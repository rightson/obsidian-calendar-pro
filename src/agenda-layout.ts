import { dateAt } from './date';
import { overlapsDay } from './calendar-menu';
import type { CalendarRange } from './ical';
import type { CalendarEvent, Interval } from './types';

/** Pixel height of one hour in the sidebar's day timeline. */
export const AGENDA_HOUR_HEIGHT = 48;
/** Short and zero-duration events still get a block tall enough for one line of text. */
export const AGENDA_MIN_BLOCK_MINUTES = 20;
/** Days the List mode shows, starting at the selected day. */
export const AGENDA_LIST_DAYS = 14;
const DAY_MINUTES = 24 * 60;

/** A timed event placed on one day of the timeline, clipped to that day. */
export interface PlacedEvent {
  event: CalendarEvent;
  /** Wall-clock minutes from the day's midnight in the display zone. */
  startMinute: number;
  endMinute: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Overlapping events share the width: this one sits in `column` of `columns`. */
  column: number;
  columns: number;
}

export interface DayEvents {
  allDay: CalendarEvent[];
  timed: PlacedEvent[];
}

export interface AgendaDay {
  day: string;
  events: CalendarEvent[];
}

/** Events the calendars show; cancelled and removed ones stay out of the sidebar too. */
export function shownEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return events.filter(event => event.status !== 'cancelled' && event.status !== 'removed');
}

/** The seven days of the week strip that holds `day`, starting on `firstDay` (0 = Sunday). */
export function weekDays(day: string, firstDay: number, zone: string): string[] {
  const date = dateAt(day, zone);
  const start = date.clone().subtract((date.day() - firstDay + 7) % 7, 'days');
  return Array.from({ length: 7 }, (_, index) => start.clone().add(index, 'days').format('YYYY-MM-DD'));
}

export function addDays(day: string, days: number, zone: string): string {
  return dateAt(day, zone).add(days, 'days').format('YYYY-MM-DD');
}

/** The instants from the start of `from` up to the start of the day after `until`. */
export function dayRange(from: string, until: string, zone: string): CalendarRange {
  return { start: dateAt(from, zone).toISOString(), end: dateAt(until, zone).add(1, 'day').toISOString() };
}

/** Wall-clock minutes since midnight in the zone, so blocks line up with the hour labels across DST. */
function wallMinute(value: string, zone: string): number {
  const date = dateAt(value, zone);
  return date.hours() * 60 + date.minutes() + date.seconds() / 60;
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start)
    || Date.parse(b.end) - Date.parse(a.end) || a.title.localeCompare(b.title);
}

/** One day's all-day events and timed events, with overlapping timed events laid out side by side. */
export function eventsOnDay(events: readonly CalendarEvent[], day: string, zone: string): DayEvents {
  const onDay = shownEvents(events).filter(event => overlapsDay(event, day, zone)).sort(byStart);
  const dayStart = dateAt(day, zone).valueOf();
  const dayEnd = dateAt(day, zone).add(1, 'day').valueOf();
  const timed = onDay.filter(event => !event.allDay).map(event => {
    const start = Date.parse(event.start);
    const end = Date.parse(event.end);
    const continuesBefore = start < dayStart;
    const continuesAfter = end > dayEnd;
    const startMinute = continuesBefore ? 0 : wallMinute(event.start, zone);
    let endMinute = continuesAfter ? DAY_MINUTES : wallMinute(event.end, zone);
    // An event ending exactly at the next midnight reads 00:00 on the wall clock.
    if (!continuesAfter && end > start && endMinute <= startMinute) endMinute = DAY_MINUTES;
    return { event, startMinute, endMinute, continuesBefore, continuesAfter, column: 0, columns: 1 };
  });
  return { allDay: onDay.filter(event => event.allDay), timed: layoutColumns(timed) };
}

/**
 * Give each group of transitively overlapping events as many columns as it
 * needs at once, placing each event in the first column free at its start.
 */
export function layoutColumns(placed: PlacedEvent[]): PlacedEvent[] {
  const visualEnd = (item: PlacedEvent) => Math.max(item.endMinute, item.startMinute + AGENDA_MIN_BLOCK_MINUTES);
  const sorted = [...placed].sort((a, b) => a.startMinute - b.startMinute || visualEnd(b) - visualEnd(a));
  const result: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const item of cluster) item.columns = columnEnds.length;
    result.push(...cluster);
    cluster = []; columnEnds = []; clusterEnd = -Infinity;
  };
  for (const original of sorted) {
    const item = { ...original };
    if (item.startMinute >= clusterEnd) flush();
    let column = columnEnds.findIndex(end => end <= item.startMinute);
    if (column === -1) { column = columnEnds.length; columnEnds.push(0); }
    columnEnds[column] = visualEnd(item);
    item.column = column;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, visualEnd(item));
  }
  flush();
  return result;
}

/** Days in [from, from + count) that have events, each with its events; `from` is always listed. */
export function agendaDays(events: readonly CalendarEvent[], from: string, count: number, zone: string): AgendaDay[] {
  const shown = shownEvents(events);
  const days: AgendaDay[] = [];
  for (let index = 0; index < count; index++) {
    const day = addDays(from, index, zone);
    const onDay = shown.filter(event => overlapsDay(event, day, zone)).sort(byStart);
    if (onDay.length || index === 0) days.push({ day, events: onDay });
  }
  return days;
}

/** Days that show at least one event, for the week strip's dots. */
export function daysWithEvents(events: readonly CalendarEvent[], days: readonly string[], zone: string): Set<string> {
  const shown = shownEvents(events);
  return new Set(days.filter(day => shown.some(event => overlapsDay(event, day, zone))));
}

/** How the event's time reads on `day`: its own times, or where it runs in from or on into another day. */
export function eventTimeLabel(event: CalendarEvent, day: string, zone: string): string {
  if (event.allDay) return 'All day';
  const start = dateAt(event.start, zone);
  const end = dateAt(event.end, zone);
  const startsToday = start.format('YYYY-MM-DD') === day;
  const endsToday = end.format('YYYY-MM-DD') === day || end.valueOf() === dateAt(day, zone).add(1, 'day').valueOf();
  if (start.valueOf() === end.valueOf()) return start.format('HH:mm');
  if (startsToday && endsToday) return `${start.format('HH:mm')}–${end.format('HH:mm')}`;
  if (startsToday) return `${start.format('HH:mm')} →`;
  if (endsToday) return `→ ${end.format('HH:mm')}`;
  return 'All day';
}

/** A pointer drag of `pixels` as whole snap steps of minutes. */
export function snappedMinutes(pixels: number, hourHeight: number, snap: number): number {
  const step = Math.max(1, snap);
  const steps = pixels / hourHeight * 60 / step;
  // Round half away from zero so dragging up snaps exactly like dragging down.
  const minutes = Math.sign(steps) * Math.round(Math.abs(steps)) * step;
  return minutes === 0 ? 0 : minutes; // never -0
}

/**
 * The event's interval after dragging it by `minutes`: `move` shifts both
 * ends, `resize` only the end, which never comes closer than `minimum`
 * minutes to the start.
 */
export function draggedInterval(event: Pick<CalendarEvent, 'start' | 'end'>, minutes: number, mode: 'move' | 'resize', minimum: number): Interval {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const shift = minutes * 60_000;
  if (mode === 'move') return { start: new Date(start + shift).toISOString(), end: new Date(end + shift).toISOString(), allDay: false };
  const nextEnd = Math.max(start + minimum * 60_000, end + shift);
  return { start: new Date(start).toISOString(), end: new Date(nextEnd).toISOString(), allDay: false };
}

/** The wall-clock time `minute` minutes into `day`, snapped down to the step, as an instant. */
export function instantAt(day: string, minute: number, snap: number, zone: string): string {
  const step = Math.max(1, snap);
  const snapped = Math.max(0, Math.min(DAY_MINUTES - step, Math.floor(minute / step) * step));
  return dateAt(day, zone).hours(Math.floor(snapped / 60)).minutes(snapped % 60).toISOString();
}

/** The smallest range covering every range, or undefined when there are none. */
export function unionRange(ranges: Iterable<CalendarRange>): CalendarRange | undefined {
  let start: number | undefined;
  let end: number | undefined;
  for (const range of ranges) {
    const from = Date.parse(range.start);
    const to = Date.parse(range.end);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    start = start === undefined ? from : Math.min(start, from);
    end = end === undefined ? to : Math.max(end, to);
  }
  return start === undefined || end === undefined ? undefined : { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}
