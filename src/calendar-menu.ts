import { dateAt } from './date';
import type { CalendarEvent, Interval } from './types';

/** The calendar span under the pointer: one time slot, or a whole day. */
export type PointerSpan = { kind: 'slot'; start: string; end: string } | { kind: 'day'; date: string };

export function overlapsDay(event: CalendarEvent, date: string, zone: string): boolean {
  // All-day ends are exclusive calendar dates, not instants in the display zone.
  if (event.allDay) return event.start.slice(0, 10) <= date && date < event.end.slice(0, 10);
  const from = dateAt(date, zone).valueOf();
  const to = dateAt(date, zone).add(1, 'day').valueOf();
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return start === end ? from <= start && start < to : start < to && end > from;
}

function overlapsSlot(event: CalendarEvent, span: Interval): boolean {
  // All-day events sit in their own row, not under a time slot.
  if (event.allDay) return false;
  const from = Date.parse(span.start);
  const to = Date.parse(span.end);
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return start === end ? from <= start && start < to : start < to && end > from;
}

/** Events shown in the span, earliest first; `also` is kept even when the pointer misses its span. */
export function eventsAt(events: CalendarEvent[], span: PointerSpan, zone: string, also?: CalendarEvent): CalendarEvent[] {
  const found = events.filter(event => span.kind === 'slot' ? overlapsSlot(event, span) : overlapsDay(event, span.date, zone));
  if (also && !found.some(event => event.id === also.id)) found.push(also);
  return found.sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start)
    || a.title.localeCompare(b.title));
}

export function editMenuTitle(event: CalendarEvent, zone: string): string {
  const time = event.allDay ? 'All day' : Date.parse(event.start) === Date.parse(event.end) ? dateAt(event.start, zone).format('HH:mm')
    : `${dateAt(event.start, zone).format('HH:mm')}–${dateAt(event.end, zone).format('HH:mm')}`;
  return `Edit “${event.title}” · ${time}`;
}
