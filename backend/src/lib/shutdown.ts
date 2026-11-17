import type { Server as HttpServer } from 'node:http';

export interface ShutdownTargets {
  /** The HTTP server: stops accepting connections, lets requests already in flight finish. */
  server: HttpServer;
  /** Disconnects every Socket.IO client (otherwise open websockets keep the HTTP server alive until the timeout). */
  closeRealtime: () => Promise<void>;
  /** Stops the schedule and resolves when a sweeper run in progress has finished. */
  stopJobs: () => Promise<void>;
  disconnectDb: () => Promise<void>;
  /** Hard limit for everything above. Keep it BELOW the orchestrator's kill timeout (Docker's default is 10 s). */
  timeoutMs: number;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
}

/**
 * Orderly shutdown (audit OPS-07):
 *  1. stop taking new connections and drop idle keep-alive ones, finish requests already in flight;
 *  2. disconnect websocket clients (they would otherwise hold the server open until the timeout);
 *  3. wait for a sweeper run in progress;
 *  4. close the database pool.
 * If that takes longer than `timeoutMs`, remaining connections are cut and the result is 1 (forced).
 * Returns 0 when everything finished in time, 1 when it had to be forced.
 */
export async function gracefulShutdown(t: ShutdownTargets): Promise<0 | 1> {
  const finished = new Promise<void>((resolve) => t.server.close(() => resolve())); // resolves when the last connection ends (also if it was not listening)
  // A keep-alive connection that is busy now becomes idle once its response is sent, and would then hold the server open until
  // Node's keep-alive timeout. Keep dropping connections as they go idle (requests still being answered are not touched).
  t.server.closeIdleConnections?.();
  const idleSweep = setInterval(() => t.server.closeIdleConnections?.(), 50);

  const work = (async () => {
    await t.closeRealtime();
    await t.stopJobs();
    await finished;
    await t.disconnectDb();
    return 0 as const;
  })();

  let timer: NodeJS.Timeout | undefined;
  const forced = new Promise<1>((resolve) => {
    timer = setTimeout(() => resolve(1), t.timeoutMs);
  });
  const outcome = await Promise.race([work, forced]);
  clearTimeout(timer);
  clearInterval(idleSweep);

  if (outcome === 1) {
    t.log.warn(`shutdown did not finish within ${t.timeoutMs} ms: cutting the remaining connections`);
    t.server.closeAllConnections?.();
    await t.disconnectDb().catch(() => undefined);
    return 1;
  }
  t.log.info('shutdown complete');
  return 0;
}
