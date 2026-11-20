import * as Sentry from '@sentry/node';
import { env } from '../config/env';
import { logger } from './logger';

/*
 * Sentry error tracking (D20 / OBS-01). The whole module is a no-op unless SENTRY_DSN is set: with no DSN the SDK is never initialised,
 * nothing is patched and nothing leaves the process, so the API behaves exactly as before.
 *
 * What is reported: only errors the API did NOT expect (the 500 INTERNAL_ERROR branch of the error handler) and process-level crashes.
 * AppError, validation errors, malformed-request errors and mapped database errors are answers the API chose to give; they are never
 * reported. Capture is done in ONE place (captureUnexpected, called by the error handler), so an error cannot be reported twice:
 * the SDK's own Express capture is switched off, because it fires before our handler runs and would also report ZodError / AppError.
 *
 * What is never sent (defence in depth, because this API handles passwords, tokens and personal data):
 *   1. the SDK is told not to collect request data at all (dataCollection: no headers, cookies, bodies, query strings, user info);
 *   2. beforeSend removes whatever is left (request block, user, extra, contexts that are not technical) and redacts sensitive
 *      key names and token-like / e-mail-like / connection-string-like text everywhere except the stack frames;
 *   3. breadcrumbs and spans are filtered the same way.
 * The event that reaches the transport is what the tests assert on, not the helper functions.
 */

/** 10% of requests are traced (the approved C2 value). Errors are never sampled. */
export const TRACES_SAMPLE_RATE = 0.1;

type Span = Parameters<NonNullable<Sentry.NodeOptions['beforeSendSpan']>>[0];

const FILTERED = '[Filtered]';

/** Key names whose value must never leave the process, whatever the value looks like. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|signature|credential|jwt|bearer|dsn|database[-_]?url|smtp[-_]?url|session/i;

/** Text patterns that look like a secret or personal data, wherever they appear in a message or a value. */
const SENSITIVE_TEXT: [RegExp, string][] = [
  [/eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, FILTERED], // JWT
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${FILTERED}`],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@\S+/gi, `${FILTERED}://`], // scheme://user:password@host (database, SMTP, ...)
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, FILTERED], // e-mail address
  [/\b[A-Za-z0-9_-]{40,}\b/g, FILTERED], // long opaque token (refresh token, signature, API key)
];

/** Removes secrets and personal data from free text. Stack frames are not passed through here (they must stay readable). */
export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of SENSITIVE_TEXT) out = out.replace(re, replacement);
  return out;
}

/** Drops the query string and fragment of a URL or path (they may carry tokens, e-mail addresses, coordinates, signatures). */
function withoutQuery(url: string): string {
  return redactText(url.split(/[?#]/)[0] ?? '');
}

/** Walks any value and redacts it. Bounded depth, so a cyclic or huge object cannot hang the error path. */
function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return FILTERED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? FILTERED : redactValue(v, depth + 1);
  return out;
}

/**
 * The last line of defence before an event is sent. Returns the event to send (never null: a scrubbing step must not lose an error).
 * Exported for the tests; the SDK calls it as `beforeSend`.
 */
export function scrubEvent<T extends Sentry.ErrorEvent>(event: T): T {
  // The request block: keep the method and the path (useful to find the route), drop everything else.
  if (event.request) {
    const { method, url } = event.request;
    event.request = { ...(method ? { method } : {}), ...(url ? { url: withoutQuery(url) } : {}) };
  }
  delete event.user;
  delete event.extra; // the API never sets any; whatever the SDK or a library adds could hold request data
  if (event.message) event.message = redactText(event.message);

  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = redactText(ex.value); // e.g. a Prisma error that quotes a value
    for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars; // local variable values are never sent (also switched off in init)
  }

  // Breadcrumbs and tags are redacted as data; the stack frames are left alone.
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b)).filter((b): b is Sentry.Breadcrumb => b !== null);
  if (event.tags) event.tags = redactValue(event.tags) as typeof event.tags;
  if (event.contexts) event.contexts = redactValue(event.contexts) as typeof event.contexts;
  // A sampled request puts the span attributes (full URL with its query, headers, ...) in the trace context of the error: same rules as spans.
  const trace = event.contexts?.trace;
  if (trace?.data) trace.data = scrubAttributes(trace.data);
  if (event.transaction) event.transaction = withoutQuery(event.transaction);
  return event;
}

/** Console output is dropped (it can contain anything); HTTP breadcrumbs keep the method and the URL without its query. */
export function scrubBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  if (crumb.category === 'console') return null;
  const out: Sentry.Breadcrumb = { ...crumb };
  if (out.message) out.message = redactText(out.message);
  if (out.data) {
    const data = redactValue(out.data) as Record<string, unknown>;
    for (const k of Object.keys(data)) {
      if (/url|query|header|body|cookie/i.test(k)) {
        if (typeof data[k] === 'string' && /url/i.test(k)) data[k] = withoutQuery(data[k] as string);
        else delete data[k];
      }
    }
    out.data = data;
  }
  return out;
}

/** Trace spans: keep the route and the timing, drop queries, headers, bodies, client addresses and SQL text. */
const DROP_SPAN_ATTRIBUTE = /query|header|cookie|body|authoriz|^user\.|client\.|address|db\.(statement|query)|url\.full|http\.url|http\.target|^url$/i;
function scrubAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (DROP_SPAN_ATTRIBUTE.test(k) || SENSITIVE_KEY.test(k)) continue;
    out[k] = redactValue(v);
  }
  return out;
}
function scrubSpan(span: Span): Span {
  return { ...span, name: redactText(span.name.split('?')[0] ?? span.name), attributes: scrubAttributes(span.attributes) as Span['attributes'] };
}

/** `development`, `staging` or `production`: SENTRY_ENVIRONMENT when set, otherwise derived from NODE_ENV (production -> production). */
export function sentryEnvironment(): 'development' | 'staging' | 'production' {
  return env.SENTRY_ENVIRONMENT ?? (env.NODE_ENV === 'production' ? 'production' : 'development');
}

let enabled = false;

export interface SentryInitOptions {
  /** Defaults to SENTRY_DSN. */
  dsn?: string;
  /** Tests only: replaces the network transport. */
  transport?: Sentry.NodeOptions['transport'];
}

/**
 * Initialises Sentry when a valid DSN is configured and returns whether it is on. Must run BEFORE the modules it instruments (express,
 * http) are loaded, so src/instrument.ts imports it first. An empty or malformed DSN keeps Sentry off; it never stops the API starting.
 * The DSN itself is never logged.
 */
export function initSentry(options: SentryInitOptions = {}): boolean {
  const dsn = (options.dsn ?? env.SENTRY_DSN ?? '').trim();
  if (!dsn) return false;
  try {
    new URL(dsn);
  } catch {
    logger.warn('SENTRY_DSN is not a valid URL: error tracking is off');
    return false;
  }

  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    tracesSampleRate: TRACES_SAMPLE_RATE,
    // No error sampling: every unexpected error is reported (sampleRate defaults to 1, stated here so nobody lowers it by accident).
    sampleRate: 1,
    // Collect no request data at all. (sendDefaultPii no longer exists in SDK 11; these switches replace it.)
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    // Never attach the values of local variables to stack frames (they would hold passwords and tokens).
    includeLocalVariables: false,
    // Errors are reported by captureUnexpected, once, from the error handler. The integration would report them earlier and also
    // report expected errors (ZodError has no status), so its capture is off.
    integrations: [Sentry.expressIntegration({ shouldHandleError: false })],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb),
    beforeSendSpan: (span) => scrubSpan(span),
    ...(options.transport ? { transport: options.transport } : {}),
  });
  enabled = true;
  return true;
}

export function sentryEnabled(): boolean {
  return enabled;
}

/** Reports an error the API did not expect. Called from the error handler's 500 branch only. Never throws. */
export function captureUnexpected(err: unknown, requestId?: string): void {
  if (!enabled) return;
  try {
    Sentry.captureException(err, requestId ? { tags: { request_id: requestId } } : undefined);
  } catch {
    // reporting must never break the response
  }
}

/** Sends what is queued, waiting at most `timeoutMs`. Called before the process exits so the last error is not lost. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!enabled) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    // best effort
  }
}

/** Tests only: closes the client so a file can initialise again. */
export async function closeSentryForTests(): Promise<void> {
  await Sentry.close(1000);
  enabled = false;
}
