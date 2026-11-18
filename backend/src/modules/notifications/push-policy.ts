import type { ExpoMessage } from '../../lib/expo-push';
import type { NotificationType } from './notify';

/*
 * Which notifications also become a push (NOTIF-01), and what the push says.
 * Every notification stays in the in-app center whatever this table says.
 *
 * `Record<NotificationType, ...>` makes the compiler refuse a type that is added to (or removed from) the union without being
 * classified here, and a test checks the table against the union in notify.ts. A value that is not in the table (the `type`
 * column is a free string) is NOT pushed: default-deny.
 */

export const PUSH_POLICY: Record<NotificationType, 'PUSH' | 'NO_PUSH'> = {
  // approved for push
  MATCH_REQUEST_RECEIVED: 'PUSH',
  MATCH_REQUEST_ACCEPTED: 'PUSH',
  MATCH_REQUEST_REJECTED: 'PUSH',
  MATCH_CANCELLED: 'PUSH',
  MATCH_TIME_CHANGED: 'PUSH',
  MATCH_INVITATION: 'PUSH',
  BOOKING_CONFIRMED: 'PUSH',
  BOOKING_REJECTED: 'PUSH',
  TEAM_INVITATION: 'PUSH',
  CHALLENGE_RECEIVED: 'PUSH',
  CHALLENGE_ACCEPTED: 'PUSH',
  // in-app only
  MATCH_PLAYER_LEFT: 'NO_PUSH',
  MATCH_REMOVED: 'NO_PUSH',
  MATCH_CLOSED_UNCONFIRMED: 'NO_PUSH',
  MATCH_VENUE_UNCONFIRMED: 'NO_PUSH',
  BOOKING_REQUEST_RECEIVED: 'NO_PUSH',
  BOOKING_CANCELLED: 'NO_PUSH',
  BOOKING_EXPIRED: 'NO_PUSH',
  TEAM_INVITATION_ACCEPTED: 'NO_PUSH',
  TEAM_INVITATION_DECLINED: 'NO_PUSH',
  TEAM_MEMBER_REMOVED: 'NO_PUSH',
  TEAM_MEMBER_LEFT: 'NO_PUSH',
  TEAM_CAPTAIN_TRANSFERRED: 'NO_PUSH',
  TEAM_ROSTER_ADDED: 'NO_PUSH',
  TEAM_ROSTER_REMOVED: 'NO_PUSH',
  CHALLENGE_REJECTED: 'NO_PUSH',
  CHALLENGE_CANCELLED: 'NO_PUSH',
  REVIEW_RECEIVED: 'NO_PUSH', // explicitly not pushed
  REPORT_RESOLVED: 'NO_PUSH', // explicitly not pushed
  VENUE_SUSPENDED: 'NO_PUSH',
  VENUE_REACTIVATED: 'NO_PUSH',
};

export const PUSH_TYPES = (Object.keys(PUSH_POLICY) as NotificationType[]).filter((t) => PUSH_POLICY[t] === 'PUSH');
export const KNOWN_TYPES = Object.keys(PUSH_POLICY);

export function isPushType(type: string): type is NotificationType {
  return Object.hasOwn(PUSH_POLICY, type) && PUSH_POLICY[type as NotificationType] === 'PUSH';
}

type Locale = 'ar' | 'en';
type Params = Record<string, unknown>;

/** A short plain string from the notification params, or undefined. Capped so a push payload can never approach Expo's 4 KiB limit. */
function text(params: Params, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined;
}

interface Template {
  title: string;
  body: string;
}
type Renderer = (p: Params) => { en: Template; ar: Template };

// Only params that notify() really sets are used; a missing one falls back to a generic sentence. Free-text reasons typed by users
// (cancel reasons, booking notes) are deliberately NOT included in a push.
const TEMPLATES: Record<string, Renderer> = {
  MATCH_REQUEST_RECEIVED: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'New join request', body: t ? `A player asked to join "${t}"` : 'A player asked to join your match' },
      ar: { title: 'طلب انضمام جديد', body: t ? `طلب لاعب الانضمام إلى «${t}»` : 'طلب لاعب الانضمام إلى مباراتك' },
    };
  },
  MATCH_REQUEST_ACCEPTED: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'Request accepted', body: t ? `You are in: "${t}"` : 'Your request to join a match was accepted' },
      ar: { title: 'تم قبول طلبك', body: t ? `تم قبولك في «${t}»` : 'تم قبول طلبك للانضمام إلى المباراة' },
    };
  },
  MATCH_REQUEST_REJECTED: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'Request declined', body: t ? `Your request to join "${t}" was declined` : 'Your request to join a match was declined' },
      ar: { title: 'تم رفض طلبك', body: t ? `تم رفض طلبك للانضمام إلى «${t}»` : 'تم رفض طلبك للانضمام إلى المباراة' },
    };
  },
  MATCH_CANCELLED: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'Match cancelled', body: t ? `"${t}" was cancelled` : 'A match you are part of was cancelled' },
      ar: { title: 'تم إلغاء المباراة', body: t ? `تم إلغاء «${t}»` : 'تم إلغاء مباراة أنت جزء منها' },
    };
  },
  MATCH_TIME_CHANGED: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'Match time changed', body: t ? `The time of "${t}" changed` : 'The time of a match changed' },
      ar: { title: 'تغيّر موعد المباراة', body: t ? `تغيّر موعد «${t}»` : 'تغيّر موعد مباراة' },
    };
  },
  MATCH_INVITATION: (p) => {
    const t = text(p, 'title');
    return {
      en: { title: 'Match invitation', body: t ? `You were invited to "${t}"` : 'You were invited to a match' },
      ar: { title: 'دعوة إلى مباراة', body: t ? `تمت دعوتك إلى «${t}»` : 'تمت دعوتك إلى مباراة' },
    };
  },
  BOOKING_CONFIRMED: (p) => {
    const v = text(p, 'venueName');
    return {
      en: { title: 'Booking confirmed', body: v ? `${v} confirmed your booking` : 'Your booking was confirmed' },
      ar: { title: 'تم تأكيد الحجز', body: v ? `أكّد ${v} حجزك` : 'تم تأكيد حجزك' },
    };
  },
  BOOKING_REJECTED: (p) => {
    const v = text(p, 'venueName');
    return {
      en: { title: 'Booking declined', body: v ? `${v} declined your booking` : 'Your booking was declined' },
      ar: { title: 'تم رفض الحجز', body: v ? `رفض ${v} حجزك` : 'تم رفض حجزك' },
    };
  },
  TEAM_INVITATION: (p) => {
    const n = text(p, 'teamName');
    return {
      en: { title: 'Team invitation', body: n ? `You were invited to join ${n}` : 'You were invited to join a team' },
      ar: { title: 'دعوة إلى فريق', body: n ? `تمت دعوتك للانضمام إلى ${n}` : 'تمت دعوتك للانضمام إلى فريق' },
    };
  },
  CHALLENGE_RECEIVED: (p) => {
    const n = text(p, 'challengerName');
    return {
      en: { title: 'New challenge', body: n ? `${n} challenged your team` : 'Your team received a challenge' },
      ar: { title: 'تحدٍّ جديد', body: n ? `تحدّاك فريق ${n}` : 'تلقّى فريقك تحدّياً' },
    };
  },
  CHALLENGE_ACCEPTED: (p) => {
    const n = text(p, 'challengedName');
    return {
      en: { title: 'Challenge accepted', body: n ? `${n} accepted your challenge` : 'Your challenge was accepted' },
      ar: { title: 'تم قبول التحدي', body: n ? `قبِل فريق ${n} تحدّيك` : 'تم قبول تحدّيك' },
    };
  },
};

export const PUSH_TTL_SECONDS = 24 * 3600; // equals the staleness window: an older push is not worth delivering

export interface PushSource {
  notificationId: string;
  type: string;
  params: unknown;
  resourceType: string | null;
  resourceId: string | null;
}

/** The Expo message for one device. Returns null for a type that is not pushed (or has no template). */
export function buildPush(source: PushSource, expoToken: string, locale: Locale): ExpoMessage | null {
  if (!isPushType(source.type)) return null;
  const render = TEMPLATES[source.type];
  if (!render) return null;
  const params = source.params && typeof source.params === 'object' && !Array.isArray(source.params) ? (source.params as Params) : {};
  const t = render(params)[locale === 'ar' ? 'ar' : 'en'];
  return {
    to: expoToken,
    title: t.title,
    body: t.body,
    data: { type: source.type, notificationId: source.notificationId, resourceType: source.resourceType, resourceId: source.resourceId },
    ttl: PUSH_TTL_SECONDS,
    priority: 'high',
    sound: 'default',
    collapseId: source.notificationId,
    tag: source.notificationId,
  };
}
