import { addDays, daysBetween } from './annotation';

/**
 * The Gantt chart's time axis. A zoom level only sets how many pixels a day
 * takes and how the scale is labelled; positions and drags are always counted
 * in whole days.
 */
export type ZoomLevel = 'day' | 'week' | 'month' | 'quarter';
export type Zoom = ZoomLevel | 'fit';

export const ZOOM_LEVELS: { level: ZoomLevel; label: string; dayWidth: number }[] = [
  { level: 'day', label: 'Day', dayWidth: 24 },
  { level: 'week', label: 'Week', dayWidth: 8 },
  { level: 'month', label: 'Month', dayWidth: 3 },
  { level: 'quarter', label: 'Quarter', dayWidth: 1.2 },
];

export const MIN_DAY_WIDTH = 0.5;
export const MAX_DAY_WIDTH = 40;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const isZoom = (value: unknown): value is Zoom => value === 'fit' || ZOOM_LEVELS.some(zoom => zoom.level === value);

export function dayWidthOf(level: ZoomLevel): number {
  return ZOOM_LEVELS.find(zoom => zoom.level === level)!.dayWidth;
}

/** The level whose labels suit a day width, such as one set by zooming to fit. */
export function levelFor(dayWidth: number): ZoomLevel {
  if (dayWidth >= 14) return 'day';
  if (dayWidth >= 5) return 'week';
  if (dayWidth >= 2) return 'month';
  return 'quarter';
}

/** One step in (negative) or out (positive) from a level or a fitted width. */
export function stepZoom(current: Zoom, dayWidth: number, direction: -1 | 1): ZoomLevel {
  const index = ZOOM_LEVELS.findIndex(zoom => zoom.level === (current === 'fit' ? levelFor(dayWidth) : current));
  if (current === 'fit') {
    // From a fitted width, the first step goes to the nearest level on that side.
    const exact = ZOOM_LEVELS[index].dayWidth;
    if (direction < 0 && dayWidth < exact) return ZOOM_LEVELS[index].level;
    if (direction > 0 && dayWidth > exact) return ZOOM_LEVELS[index].level;
  }
  return ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + direction))].level;
}

/** The day width that shows `days` days in `width` pixels. */
export function fitDayWidth(days: number, width: number): number {
  if (days <= 0 || width <= 0) return dayWidthOf('day');
  return Math.max(MIN_DAY_WIDTH, Math.min(MAX_DAY_WIDTH, width / days));
}

/** ISO 8601 week number of a date. */
export function isoWeek(date: string): number {
  const value = new Date(`${date}T00:00:00Z`);
  const day = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - day + 3);
  const year = value.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  return 1 + Math.round(((value.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}

/** A labelled span of the scale: `offset` days from the chart's first day, `days` long. */
export interface Band { start: string; offset: number; days: number; label: string; weekend?: boolean }

export interface Scale { major: Band[]; minor: Band[] }

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';

function nextStart(date: string, unit: Unit): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const pad = (value: number) => String(value).padStart(2, '0');
  switch (unit) {
    case 'day': return addDays(date, 1);
    case 'week': return addDays(date, 7 - ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
    case 'month': return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
    case 'quarter': {
      const next = Math.floor((month - 1) / 3) * 3 + 4;
      return next > 12 ? `${year + 1}-01-01` : `${year}-${pad(next)}-01`;
    }
    case 'year': return `${year + 1}-01-01`;
  }
}

function label(date: string, unit: Unit): string {
  const month = Number(date.slice(5, 7));
  switch (unit) {
    case 'day': return String(Number(date.slice(8)));
    case 'week': return `W${isoWeek(date)}`;
    case 'month': return MONTHS[month - 1];
    case 'quarter': return `Q${Math.floor((month - 1) / 3) + 1}`;
    case 'year': return date.slice(0, 4);
  }
}

/** The bands of `unit` from `from` to `to`, both days included; the first and last may be partial. */
export function bands(from: string, to: string, unit: Unit, monthWithYear = false): Band[] {
  const result: Band[] = [];
  for (let start = from; start <= to;) {
    const next = nextStart(start, unit);
    const end = next > to ? addDays(to, 1) : next;
    const text = unit === 'month' && monthWithYear ? `${label(start, 'month')} ${start.slice(0, 4)}` : label(start, unit);
    const weekday = (new Date(`${start}T00:00:00Z`).getUTCDay() + 6) % 7;
    result.push({ start, offset: daysBetween(from, start), days: daysBetween(start, end), label: text, ...unit === 'day' && weekday >= 5 ? { weekend: true } : {} });
    start = next;
  }
  return result;
}

/** The two rows of the scale at a level: months over days, months over weeks, years over months or quarters. */
export function scale(from: string, to: string, level: ZoomLevel): Scale {
  switch (level) {
    case 'day': return { major: bands(from, to, 'month', true), minor: bands(from, to, 'day') };
    case 'week': return { major: bands(from, to, 'month', true), minor: bands(from, to, 'week') };
    case 'month': return { major: bands(from, to, 'year'), minor: bands(from, to, 'month') };
    case 'quarter': return { major: bands(from, to, 'year'), minor: bands(from, to, 'quarter') };
  }
}
