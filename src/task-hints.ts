import { addDays, formatDate, isoDate } from './annotation';

/**
 * Suggestions read from a task's own words. They are only offered as chips;
 * nothing is written until the user presses one.
 */
export type TaskHint =
  | { kind: 'date'; date: string; phrase: string }
  | { kind: 'assign'; name: string; phrase: string };

const WEEKDAY = '[一二三四五六日天]';
const WEEK = '(?:週|周|星期|禮拜)';
const DAY_INDEX: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

/** Monday-based weekday of a date, 0 for Monday. */
function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

function lastOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** The first fixed date phrase in `text`, resolved against `today`. */
export function dateHint(text: string, today: string): { date: string; phrase: string } | undefined {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const monday = addDays(today, -weekday(today));
  const rules: [RegExp, (match: RegExpExecArray) => string | undefined][] = [
    [new RegExp(`下${WEEK}(${WEEKDAY})`), match => addDays(monday, 7 + DAY_INDEX[match[1]])],
    [new RegExp(`(?:本|這|这)${WEEK}(${WEEKDAY})`), match => addDays(monday, DAY_INDEX[match[1]])],
    [new RegExp(`${WEEK}(${WEEKDAY})前`), match => addDays(today, (DAY_INDEX[match[1]] - weekday(today) + 7) % 7)],
    [/今天/, () => today],
    [/明天/, () => addDays(today, 1)],
    [/後天|后天/, () => addDays(today, 2)],
    [/月底/, () => lastOfMonth(year, month)],
    [/月初/, () => day === 1 ? today : isoDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1)],
    [/(\d{1,2})[號号]前/, match => {
      const target = Number(match[1]);
      if (target >= day) return isoDate(year, month, target);
      return isoDate(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, target);
    }],
  ];
  for (const [pattern, resolve] of rules) {
    const match = pattern.exec(text);
    const date = match && resolve(match);
    if (match && date) return { date, phrase: match[0] };
  }
  return undefined;
}

/** `找小王` suggests assigning 小王. */
export function assignHint(text: string): { name: string; phrase: string } | undefined {
  const match = /找\s*([^\s，,、。.!！?？()（）@[\]]+)/.exec(text);
  return match ? { name: match[1], phrase: match[0] } : undefined;
}

/** Chips for a task: a date when it has none, an assignee when it has none of its own. */
export function taskHints(text: string, today: string, options: { dated: boolean; assigned: boolean }): TaskHint[] {
  const hints: TaskHint[] = [];
  const date = options.dated ? undefined : dateHint(text, today);
  if (date) hints.push({ kind: 'date', ...date });
  const assign = options.assigned ? undefined : assignHint(text);
  if (assign) hints.push({ kind: 'assign', ...assign });
  return hints;
}

export function hintLabel(hint: TaskHint, today: string): string {
  return hint.kind === 'date' ? `Due ${formatDate(hint.date, today)}? (${hint.phrase})` : `Assign to ${hint.name}?`;
}
