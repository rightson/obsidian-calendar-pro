import type { CalendarEvent } from "./types";
import type { ICalErrorCode } from "./ical-errors";

export type Interval = Pick<CalendarEvent, "start" | "end" | "allDay">;
export type ChangeStatus =
  | "applied"
  | "local_override"
  | "needs_attention"
  | "superseded"
  | "cancelled"
  | "removal_attention"
  | "resolved";

export interface ChangeHistoryEntry {
  id: string;
  eventId: string;
  sourceId: string;
  sourceName: string;
  title: string;
  detectedAt: string;
  reviewedAt?: string;
  status: ChangeStatus;
  beforeSource?: Interval;
  afterSource?: Interval;
  beforeEffective?: Interval;
  afterEffective?: Interval;
  notePath?: string;
  beforeDailyPath?: string;
  afterDailyPath?: string;
  resolutionAt?: string;
  resolution?: "source_times";
  error?: string;
  /** Revision of the accepted baseline when this change was detected. */
  acceptedRevision: number;
}

export interface AcceptedEvent {
  event: CalendarEvent;
  revision: number;
}

export interface PendingIncoming {
  event: CalendarEvent;
  baselineRevision: number;
  historyId: string;
}

export interface SourceCache {
  /** Private feed data. Never copy this into notes, history, notices, or logs. */
  raw?: string;
  /** Hash of the configured URL so validators never cross endpoint changes. */
  urlFingerprint?: string;
  etag?: string;
  lastModified?: string;
  lastAttempt?: string;
  lastSuccess?: string;
  error?: string;
  retryAfter?: string;
  retryFingerprint?: string;
  failures: number;
  accepted: Record<string, AcceptedEvent>;
  pendingIncoming: Record<string, PendingIncoming>;
}

export function emptySourceCache(): SourceCache {
  return { failures: 0, accepted: {}, pendingIncoming: {} };
}

export function needsReview(entry: ChangeHistoryEntry): boolean {
  return entry.status === "needs_attention" || !entry.reviewedAt;
}

export function historyForReview(history: readonly ChangeHistoryEntry[]): ChangeHistoryEntry[] {
  return history.filter(needsReview);
}

export function markReviewed(history: ChangeHistoryEntry[], id: string, at = new Date().toISOString()): boolean {
  const entry = history.find((item) => item.id === id);
  if (!entry) return false;
  entry.reviewedAt ??= at;
  return true;
}

export type SourceErrorKind = "url" | "fetch" | "http" | "empty" | "html" | "non-ical"
  | "parse" | "zone" | "cache" | "cache-missing" | "sync" | "write";

const suffix = " Cached events remain available.";
const parserMessages: Record<ICalErrorCode, string> = {
  "invalid-feed": "The calendar response is not a valid iCalendar feed.",
  "invalid-syntax": "Calendar Pro could not parse this iCalendar response.",
  "invalid-range": "The calendar view has an invalid date range.",
  "feed-too-large": "The calendar feed exceeds the supported size.",
  "invalid-time-zone": "The calendar uses an unknown or invalid time zone.",
  "invalid-event-time": "The calendar contains an invalid event time.",
  "missing-event-uid": "A calendar event has no UID.",
  "duplicate-event-uid": "The calendar contains duplicate event UIDs.",
  "missing-event-start": "A calendar event has no start time.",
  "duplicate-recurrence": "The calendar contains duplicate recurrence entries.",
  "invalid-event-interval": "A calendar event has an invalid start/end interval.",
  "recurrence-limit": "The calendar has too many repeated event occurrences.",
  "unsupported-calendar-update": "This is a cancellation message; a complete subscription feed is required.",
};

/** Only fixed messages and bounded HTTP status codes may enter persisted errors. */
export function safeSourceError(kind: SourceErrorKind, detail?: ICalErrorCode | number): string {
  switch (kind) {
    case "url": return "Enter a valid HTTPS or webcal subscription URL.";
    case "fetch": return "Could not refresh this calendar. Cached events remain available.";
    case "http": return typeof detail === "number" && Number.isInteger(detail) && detail >= 100 && detail <= 599
      ? `The calendar server returned HTTP ${detail}.${suffix}`
      : `The calendar server returned an HTTP error.${suffix}`;
    case "empty": return `The calendar response was empty.${suffix}`;
    case "html": return `The calendar response is HTML, not a valid iCalendar feed.${suffix}`;
    case "non-ical": return `The calendar response is not an iCalendar feed.${suffix}`;
    case "parse": return `${typeof detail === "string" && Object.hasOwn(parserMessages, detail)
      ? parserMessages[detail as ICalErrorCode] : parserMessages["invalid-feed"]}${suffix}`;
    case "zone": return "The calendar uses an unknown time zone. Cached events remain available.";
    case "cache": return `The calendar cache could not be processed.${suffix}`;
    case "cache-missing": return `The calendar server returned no new feed, and no cached feed is available.${suffix}`;
    case "sync": return `The calendar events could not be applied.${suffix}`;
    case "write": return "The linked note could not be updated. Review or retry this change.";
  }
}

/** Never show arbitrary persisted error strings, including values from older state. */
export function safeStoredSourceError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  for (const kind of ["url", "fetch", "http", "empty", "html", "non-ical", "parse", "zone", "cache", "cache-missing", "sync", "write"] as const) {
    if (error === safeSourceError(kind)) return error;
  }
  for (const code of Object.keys(parserMessages) as ICalErrorCode[]) {
    if (error === safeSourceError("parse", code)) return error;
  }
  const match = /^The calendar server returned HTTP ([1-5][0-9]{2})\. Cached events remain available\.$/.exec(error);
  if (match && error === safeSourceError("http", Number(match[1]))) return error;
  return safeSourceError("fetch");
}
