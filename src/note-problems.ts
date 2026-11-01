import { parseDocument } from 'yaml';
import { detachEventFrontmatter, splitFrontmatter } from './notes';
import type { CalendarEvent } from './types';

/**
 * Why an Event Note is not shown as it is written:
 * - duplicate: several notes claim one event, or copies of a note that already holds it;
 * - unlisted: its calendar no longer lists the event;
 * - orphan: it was created by a subscription that was removed;
 * - invalid: its properties cannot be read;
 * - missing-id: its event_id was removed, so only the last valid version is shown;
 * - error: a linked note could not be updated.
 */
export type ProblemKind = 'duplicate' | 'unlisted' | 'orphan' | 'invalid' | 'missing-id' | 'error';

export interface EventNoteProblem {
  kind: ProblemKind;
  /** Every note involved. For a duplicate, all notes that share the event. */
  paths: string[];
  /** One sentence naming the files and the cause. */
  message: string;
  /** For copies of a reconnected note: the note that already holds the event. */
  holder?: string;
  /** For a note its calendar no longer lists: that calendar. */
  sourceId?: string;
  /** For a removed subscription's note: current calendar events with the same iCal identity. */
  candidates?: CalendarEvent[];
  /** The event as last read from this note, while it can still be restored. */
  lastValid?: CalendarEvent;
}

export const PROBLEM_ORDER: ProblemKind[] = ['duplicate', 'unlisted', 'orphan', 'invalid', 'missing-id', 'error'];

export const PROBLEM_LABELS: Record<ProblemKind, string> = {
  duplicate: 'Duplicates',
  unlisted: 'Not in calendar',
  orphan: 'Removed calendar',
  invalid: 'Invalid properties',
  'missing-id': 'Missing event_id',
  error: 'Update failed',
};

export function problemKey(problem: EventNoteProblem): string {
  return `${problem.kind}:${[...problem.paths].sort().join('\n')}`;
}

export function sortProblems(problems: EventNoteProblem[]): EventNoteProblem[] {
  return [...problems].sort((a, b) => PROBLEM_ORDER.indexOf(a.kind) - PROBLEM_ORDER.indexOf(b.kind)
    || a.paths[0].localeCompare(b.paths[0]));
}

/** A short title and a plain explanation of what happened and what each choice does. */
export function describeProblem(problem: EventNoteProblem, calendarName: (sourceId: string) => string): { title: string; explanation: string } {
  const count = problem.paths.length;
  switch (problem.kind) {
    case 'duplicate':
      return problem.holder
        ? { title: `${count - 1 === 1 ? 'A copy' : `${count - 1} copies`} of an Event Note`,
          explanation: 'A calendar subscription was removed and added again. Its event is now held by one note; the other notes are older copies of it. Compare them, keep any text you need, then remove the copies.' }
        : { title: `${count} notes claim the same event`,
          explanation: 'These notes have the same event_id, usually because a note was duplicated. Calendar Pro cannot tell which one is the event, so none of them is shown. Choose the note to keep; the others stop being Event Notes.' };
    case 'unlisted': {
      const source = problem.sourceId;
      return { title: source ? `Not in calendar “${calendarName(source)}”` : 'Not in its calendar',
        explanation: 'The calendar this note came from no longer lists its event. The event may have been deleted or moved, or the note’s event_id, ical_uid or recurrence_id was edited. If the calendar was only out of date, refresh it; otherwise keep the note as an ordinary note or move it to trash.' };
    }
    case 'orphan':
      return problem.candidates?.length
        ? { title: 'Left by a removed calendar; more than one calendar matches',
          explanation: 'This note was created by a subscription that was removed. More than one current calendar lists the same event, so choose which one the note belongs to.' }
        : { title: 'Left by a removed calendar',
          explanation: 'This note was created by a subscription that was removed, and no current calendar lists its event. Keep it as an ordinary note or move it to trash.' };
    case 'invalid':
      return { title: 'Event properties cannot be read',
        explanation: problem.lastValid
          ? 'The note’s event properties were edited into a form Calendar Pro cannot use. The calendar still shows the last valid version. Fix the note, or put back the last valid properties.'
          : 'The note’s event properties cannot be used, so its event is not shown. Open the note to fix them, or stop treating it as an Event Note.' };
    case 'missing-id':
      return { title: 'event_id was removed',
        explanation: 'This note no longer has an event_id. Until the plugin reloads, the calendar shows its last valid version. Put the event properties back, or keep the note as an ordinary note.' };
    case 'error':
      return { title: 'A linked note could not be updated',
        explanation: 'Calendar Pro could not update a note linked to this event. Open it, check the reason below, then scan again.' };
  }
}

export interface NoteSummary {
  /** Top-level properties in order, values as written. */
  properties: [string, string][];
  body: string;
  /** The YAML parser's message when the frontmatter cannot be read. */
  yamlError?: string;
}

export function summarizeNote(content: string): NoteSummary {
  const fm = splitFrontmatter(content);
  const summary: NoteSummary = { properties: [], body: fm.body };
  if (!fm.has) return summary;
  const doc = parseDocument(fm.lines.join('\n'), { uniqueKeys: true });
  if (doc.errors.length) {
    summary.yamlError = doc.errors[0].message.split('\n')[0];
    summary.properties = fm.lines.filter(line => line.trim()).map(line => {
      const at = line.indexOf(':');
      return at > 0 ? [line.slice(0, at), line.slice(at + 1).trim()] : ['', line];
    });
    return summary;
  }
  const data = doc.toJS() as Record<string, unknown> | null;
  if (data && typeof data === 'object') {
    for (const [key, value] of Object.entries(data)) {
      summary.properties.push([key, typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)]);
    }
  }
  return summary;
}

/** The note without the properties Calendar Pro manages, i.e. what a user wrote. */
export function userContent(content: string): string {
  return detachEventFrontmatter(content).replace(/\s+$/, '');
}

export interface DiffLine { type: 'same' | 'added' | 'removed'; text: string }

/** Line diff from `from` to `to`; added lines exist only in `to`. */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.replace(/\s+$/, '').split(/\r?\n/);
  const b = to.replace(/\s+$/, '').split(/\r?\n/);
  if (a.length * b.length > 4_000_000) {
    // Too large for a table: report the whole text as replaced.
    return [...a.map(text => ({ type: 'removed' as const, text })), ...b.map(text => ({ type: 'added' as const, text }))];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) lines.push({ type: 'removed', text: a[i++] });
    else lines.push({ type: 'added', text: b[j++] });
  }
  while (i < a.length) lines.push({ type: 'removed', text: a[i++] });
  while (j < b.length) lines.push({ type: 'added', text: b[j++] });
  return lines;
}

/** Text lines of `other` that the kept note does not have, ignoring blank lines. */
export function uniqueLines(kept: string, other: string): string[] {
  return lineDiff(splitFrontmatter(kept).body, splitFrontmatter(other).body)
    .filter(line => line.type === 'added' && line.text.trim()).map(line => line.text);
}

/** Properties of `other`, other than the managed ones, that the kept note lacks or sets differently. */
export function uniqueProperties(kept: string, other: string): string[] {
  const values = new Map(summarizeNote(detachEventFrontmatter(kept)).properties);
  return summarizeNote(detachEventFrontmatter(other)).properties.filter(([key, value]) => values.get(key) !== value).map(([key]) => key);
}

/** The event a note describes, read leniently so even an invalid note can say what it is about. */
export interface NoteEvent {
  title: string;
  start?: string;
  end?: string;
  allDay: boolean;
  /** Calendar the note came from; absent for a local event. */
  sourceId?: string;
}

/** Another note that points to a problem note. */
export interface NoteReference {
  path: string;
  /** A Daily Note's generated event entry, or any other link. */
  kind: 'daily' | 'link';
  /** The Daily Note entry's text. */
  line?: string;
}

export function noteEvent(content: string, path: string): NoteEvent {
  const summary = summarizeNote(content);
  const values = new Map(summary.properties.map(([key, value]) => [key, value.replace(/^["']|["']$/g, '')]));
  const heading = /^#\s+(.+?)\s*$/m.exec(summary.body);
  const id = values.get('event_id');
  const source = values.get('source') || (id && !id.startsWith('local|') ? id.split('|')[0] : undefined);
  return { title: heading?.[1] ?? path.split('/').pop()!.replace(/\.md$/i, ''), start: values.get('start') || undefined,
    end: values.get('end') || undefined, allDay: values.get('all_day') === 'true', sourceId: source || undefined };
}

/** Whether, and how, the event currently appears on the calendar. */
export function calendarVisibility(problem: EventNoteProblem): string {
  switch (problem.kind) {
    case 'duplicate': return problem.holder
      ? 'Shown on the calendar from the note that holds it. The copies are not used.'
      : 'Not shown on the calendar until one note is kept.';
    case 'unlisted': return 'Not shown on the calendar: its calendar no longer lists it.';
    case 'orphan': return 'Not shown on the calendar: its calendar subscription was removed.';
    case 'invalid': return problem.lastValid
      ? 'Shown on the calendar from the last valid version of the note, until the plugin reloads.'
      : 'Not shown from this note. An imported event still appears with its calendar’s times.';
    case 'missing-id': return 'Shown on the calendar from the last valid version of the note, until the plugin reloads.';
    case 'error': return 'Shown on the calendar; only the linked note could not be updated.';
  }
}

export interface NoteFacts {
  path: string;
  content: string | null;
  /** The event the note describes, when it has any event properties. */
  event?: NoteEvent;
  /** Daily Note entries and other notes that link to this note. */
  references: NoteReference[];
  /** Last modification time, when the Vault reports it. */
  mtime?: number;
  /** Calendar Pro's link for the event points to this note. */
  linked: boolean;
  /** The event's Daily Note entry links to this note. */
  listed: boolean;
}

/** The note most likely to be the real one, and why, so the user can confirm instead of investigate. */
export function recommendKeep(notes: NoteFacts[], holder?: string): { path: string; reason: string } {
  if (holder) return { path: holder, reason: 'It holds the event now.' };
  const linked = notes.filter(note => note.linked);
  if (linked.length === 1) return { path: linked[0].path, reason: 'Calendar Pro links the event to this note.' };
  const listed = notes.filter(note => note.listed);
  if (listed.length === 1) return { path: listed[0].path, reason: 'The Daily Note links to this note.' };
  const size = (note: NoteFacts) => note.content ? userContent(note.content).length : -1;
  const ranked = [...notes].sort((a, b) => size(b) - size(a) || (a.mtime ?? Infinity) - (b.mtime ?? Infinity) || a.path.localeCompare(b.path));
  const [best, next] = ranked;
  return { path: best.path, reason: next && size(best) === size(next) ? 'The notes are the same size; this one was changed first.' : 'It has the most text.' };
}

/** Append what only `other` has written to `kept`, under a heading naming where it came from. */
export function mergeNoteText(kept: string, other: string, otherPath: string): string {
  // The copy's title heading is replaced by the heading naming it; kept, it
  // could become the kept note's event title.
  const body = splitFrontmatter(other).body.replace(/^\s+|\s+$/g, '').replace(/^# [^\r\n]*(?:\r?\n\s*|$)/, '');
  if (!body || !uniqueLines(kept, other).length) return kept;
  const name = otherPath.split('/').pop()!.replace(/\.md$/i, '');
  const newline = kept.includes('\r\n') ? '\r\n' : '\n';
  const base = kept.replace(/\s+$/, '');
  return `${base}${base ? newline + newline : ''}## Merged from ${name}${newline}${newline}${body.replace(/\r?\n/g, newline)}${newline}`;
}
