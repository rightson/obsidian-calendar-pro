import { parseDocument } from 'yaml';
import moment from 'moment-timezone';
import { dateAt } from './date';
import type { CalendarEvent } from './types';

export interface ParsedEventNote {
  id: string;
  start: string;
  end: string;
  allDay: boolean;
  source?: string;
  uid?: string;
  recurrenceId?: string;
  title: string;
}

function validateIntervalWithMinimum(start: string, end: string, allDay: boolean, minimumMinutes: number): void {
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/;
  if (!iso.test(start) || !iso.test(end)) throw new Error('Event times must be ISO timestamps with an offset.');
  const from = moment.parseZone(start, moment.ISO_8601, true);
  const to = moment.parseZone(end, moment.ISO_8601, true);
  if (!from.isValid() || !to.isValid() || to.valueOf() - from.valueOf() < minimumMinutes * 60_000) {
    throw new Error(minimumMinutes ? 'The event must end at least 15 minutes after it starts.'
      : 'The imported event cannot end before it starts.');
  }
  if (allDay && (!/T00:00(?::00)?(?:\.0+)?(?:Z|[+-]\d\d:\d\d)$/.test(start)
    || !/T00:00(?::00)?(?:\.0+)?(?:Z|[+-]\d\d:\d\d)$/.test(end)
    || end.slice(0, 10) <= start.slice(0, 10) || to.valueOf() <= from.valueOf())) {
    throw new Error('All-day events must use midnight boundaries and an exclusive end.');
  }
}

/** Local events and user changes have a minimum duration. */
export function validateInterval(start: string, end: string, allDay = false): void {
  validateIntervalWithMinimum(start, end, allDay, 15);
}

/** Source events may be points or shorter than the local editing minimum. */
export function validateSourceInterval(start: string, end: string, allDay = false): void {
  validateIntervalWithMinimum(start, end, allDay, 0);
}

export function isImportedEventIdentity(id: string, source: string | undefined, uid: string | undefined): boolean {
  return !id.startsWith('local|') && Boolean(source?.trim() && source !== 'local' && uid?.trim());
}

export function validateEventInterval(event: CalendarEvent): void {
  const validate = isImportedEventIdentity(event.id, event.sourceId, event.uid)
    ? validateSourceInterval : validateInterval;
  validate(event.start, event.end, event.allDay);
}

export function splitFrontmatter(content: string): { lines: string[]; body: string; newline: string; has: boolean } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  return match
    ? { lines: match[1].split(/\r?\n/), body: content.slice(match[0].length), newline: match[0].includes('\r\n') ? '\r\n' : '\n', has: true }
    : { lines: [], body: content, newline: content.includes('\r\n') ? '\r\n' : '\n', has: false };
}

export function parseEventNote(content: string, path: string): ParsedEventNote | null {
  const fm = splitFrontmatter(content);
  if (!fm.has) return null;
  if (!fm.lines.some(line => /^event_id:(?:\s|$)/.test(line))) return null;
  const doc = parseDocument(fm.lines.join('\n'), { uniqueKeys: true });
  if (doc.errors.length) throw new Error(`Invalid YAML in ${path}.`);
  const data = doc.toJS() as Record<string, unknown> | null;
  if (!data || typeof data.event_id !== 'string') return null;
  if (typeof data.start !== 'string' || typeof data.end !== 'string') throw new Error(`Invalid event times in ${path}.`);
  const source = typeof data.source === 'string' ? data.source : undefined;
  const uid = typeof data.ical_uid === 'string' ? data.ical_uid : undefined;
  const validate = isImportedEventIdentity(data.event_id, source, uid) ? validateSourceInterval : validateInterval;
  validate(data.start, data.end, data.all_day === true);
  const heading = /^#\s+(.+?)\s*$/m.exec(fm.body);
  return {
    id: data.event_id,
    start: data.start,
    end: data.end,
    allDay: data.all_day === true,
    source,
    uid,
    recurrenceId: typeof data.recurrence_id === 'string' ? data.recurrence_id : undefined,
    title: heading?.[1] ?? path.split('/').pop()!.replace(/\.md$/i, ''),
  };
}

/** Replace only managed top-level properties; preserve all other YAML and body bytes. */
export function writeEventFrontmatter(content: string, event: CalendarEvent): string {
  validateEventInterval(event);
  const original = splitFrontmatter(content).has ? parseEventNote(content, 'Event Note') : null;
  if (original && original.id !== event.id) throw new Error('The Event Note belongs to another event.');
  return replaceEventFields(content, event);
}

/**
 * Put back an event's last valid properties in a note that no longer passes
 * validation, e.g. after its times or event_id were edited by hand.
 */
export function restoreEventFrontmatter(content: string, event: CalendarEvent): string {
  validateEventInterval(event);
  const fm = splitFrontmatter(content);
  const doc = parseDocument(fm.lines.join('\n'), { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Fix the YAML in this note first; its properties cannot be read.');
  const id = (doc.toJS() as Record<string, unknown> | null)?.event_id;
  if (typeof id === 'string' && id.trim() && id !== event.id) throw new Error('The Event Note belongs to another event.');
  return replaceEventFields(content, event);
}

function replaceEventFields(content: string, event: CalendarEvent): string {
  const fm = splitFrontmatter(content);
  let lines = fm.lines;
  const fields: Record<string, string | null> = {
    event_id: event.id,
    start: event.start,
    end: event.end,
    all_day: event.allDay ? 'true' : null,
    source: event.sourceId === 'local' ? null : event.sourceId,
    ical_uid: event.sourceId === 'local' ? null : event.uid,
    recurrence_id: event.sourceId === 'local' ? null : event.recurrenceId ?? null,
  };
  for (const [key, value] of Object.entries(fields)) {
    const positions = lines.flatMap((line, index) => new RegExp(`^${key}:(?:\\s|$)`).test(line) ? [index] : []);
    if (positions.length > 1) throw new Error(`Duplicate ${key} property in Event Note.`);
    if (value === null) { if (positions.length) lines = lines.filter((_, index) => index !== positions[0]); }
    else if (positions.length) lines[positions[0]] = `${key}: ${key === 'all_day' ? value : JSON.stringify(value)}`;
    else lines.push(`${key}: ${key === 'all_day' ? value : JSON.stringify(value)}`);
  }
  return `---${fm.newline}${lines.join(fm.newline)}${fm.newline}---${fm.newline}${fm.body}`;
}

const MANAGED_KEYS = ['event_id', 'start', 'end', 'all_day', 'source', 'ical_uid', 'recurrence_id'];
const managedLine = (line: string) => MANAGED_KEYS.some(key => new RegExp(`^${key}:(?:\\s|$)`).test(line));

/** Top-level properties an Event Note owns that this note already uses. */
export function managedEventKeys(content: string): string[] {
  return MANAGED_KEYS.filter(key => splitFrontmatter(content).lines.some(line => new RegExp(`^${key}:(?:\\s|$)`).test(line)));
}

export function assertValidFrontmatter(content: string, path: string): void {
  const fm = splitFrontmatter(content);
  if (fm.has && parseDocument(fm.lines.join('\n'), { uniqueKeys: true }).errors.length) throw new Error(`Invalid YAML in ${path}.`);
}

/** Turn an Event Note back into an ordinary note: drop managed properties, keep everything else. */
export function detachEventFrontmatter(content: string): string {
  const fm = splitFrontmatter(content);
  if (!fm.has) return content;
  const lines = fm.lines.filter(line => !managedLine(line));
  if (!lines.some(line => line.trim())) return fm.body;
  return `---${fm.newline}${lines.join(fm.newline)}${fm.newline}---${fm.newline}${fm.body}`;
}

/** Give a removed calendar's Event Note the identity of the same event in its replacement. */
export function adoptEventFrontmatter(content: string, event: CalendarEvent): string {
  const fm = splitFrontmatter(content);
  const index = fm.lines.findIndex(line => /^event_id:(?:\s|$)/.test(line));
  if (index < 0) throw new Error('Only an Event Note can be adopted.');
  const lines = fm.lines.map((line, at) => at === index ? `event_id: ${JSON.stringify(event.id)}` : line);
  return writeEventFrontmatter(`---${fm.newline}${lines.join(fm.newline)}${fm.newline}---${fm.newline}${fm.body}`, event);
}

export function newEventNote(event: CalendarEvent, notePath?: string, properties?: Record<string, string>): string {
  const basename = notePath?.split('/').pop()?.replace(/\.md$/i, '').normalize('NFC');
  const heading = event.title.replace(/[\r\n]/g, ' ').trim();
  const content = writeEventFrontmatter(basename === event.title.normalize('NFC') ? '' : `# ${heading}\n\n`, event);
  return properties ? addProperties(content, properties) : content;
}

/** Add string properties after the managed ones, skipping keys the note already has. */
function addProperties(content: string, properties: Record<string, string>): string {
  const fm = splitFrontmatter(content);
  const lines = [...fm.lines];
  for (const [key, value] of Object.entries(properties)) {
    if (!lines.some(line => new RegExp(`^${key}:(?:\\s|$)`).test(line))) lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  return `---${fm.newline}${lines.join(fm.newline)}${fm.newline}---${fm.newline}${fm.body}`;
}

/** Remove an exact duplicate filename heading from a recognized Event Note only. */
export function removeDuplicateEventNoteTitle(content: string, path: string): string {
  let note: ParsedEventNote | null;
  try { note = parseEventNote(content, path); }
  catch { return content; }
  if (!note) return content;
  const fm = splitFrontmatter(content);
  const heading = /^((?:[ \t]*\r?\n)*)# ([^\r\n]*)(?:\r?\n|$)/.exec(fm.body);
  if (!heading) return content;
  const basename = path.split('/').pop()?.replace(/\.md$/i, '');
  if (!basename || heading[2].normalize('NFC') !== basename.normalize('NFC')) return content;
  const bodyStart = content.length - fm.body.length;
  return content.slice(0, bodyStart + heading[1].length) + content.slice(bodyStart + heading[0].length);
}

export function eventBullet(event: CalendarEvent, notePath: string, zone: string): string {
  const from = dateAt(event.start, zone);
  const to = dateAt(event.end, zone);
  const time = event.allDay ? 'All day' : Date.parse(event.start) === Date.parse(event.end) ? from.format('HH:mm')
    : `${from.format('HH:mm')}–${to.format('YYYY-MM-DD') === from.format('YYYY-MM-DD') ? to.format('HH:mm') : to.format('YYYY-MM-DD HH:mm')}`;
  const alias = event.title.replace(/[[\]|#\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled event';
  return `- ${time} [[${notePath.replace(/\.md$/i, '')}|${alias}]]`;
}

interface Line { text: string; start: number; end: number; plain: boolean }
/** Split Markdown into lines and return the fence still open at the end, if any. */
export function scanMarkdown(content: string): { lines: Line[]; openFence: string | null } {
  const bodyStart = content.length - splitFrontmatter(content).body.length;
  let offset = 0;
  let fence = null as { mark: string; length: number } | null;
  const lines = content.split('\n').map((text, index, array) => {
    const start = offset;
    offset += text.length + (index < array.length - 1 ? 1 : 0);
    const raw = text.replace(/\r$/, '');
    // A backtick fence's info string cannot contain backticks, so ```code``` is inline code.
    const match = start >= bodyStart ? /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(raw) : null;
    const marker = match ? [match[1] ?? match[3], match[2] ?? match[4]] : null;
    let plain = start >= bodyStart && !fence && !marker;
    if (marker) {
      if (!fence) fence = { mark: marker[0][0], length: marker[0].length };
      else if (fence.mark === marker[0][0] && marker[0].length >= fence.length && !marker[1].trim()) fence = null;
      plain = false;
    }
    return { text: raw, start, end: offset, plain };
  });
  return { lines, openFence: fence ? fence.mark.repeat(fence.length) : null };
}

function markdownLines(content: string): Line[] {
  return scanMarkdown(content).lines;
}

function eventSection(content: string): { start: number; end: number } | null {
  const headings = markdownLines(content).flatMap(line => {
    if (!line.plain) return [];
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line.text);
    return match ? [{ level: match[1].length, title: match[2], start: line.start, end: line.end }] : [];
  });
  // Daily Notes written before the rename keep their `## Event` section.
  const current = headings.find(heading => heading.level === 2 && (heading.title === 'Events' || heading.title === 'Event'));
  if (!current) return null;
  return { start: current.end, end: headings.find(heading => heading.start > current.start && heading.level <= 2)?.start ?? content.length };
}

function trackedLine(content: string, bullet: string): Line | undefined {
  const section = eventSection(content);
  return section ? markdownLines(content).find(line => line.plain && line.start >= section.start && line.start < section.end && line.text === bullet) : undefined;
}

// Times exactly as eventBullet writes them, so a user's own wording is never matched.
const generatedTime = /^(?:All day|\d\d:\d\d(?:–(?:\d{4}-\d\d-\d\d )?\d\d:\d\d)?)$/;

/** Generated entries linking to any of these Event Note paths, whatever their alias or time. */
function eventBulletLines(content: string, notePaths: string[]): Line[] {
  const key = (path: string) => path.replace(/\.md$/i, '').normalize('NFC').toLocaleLowerCase('en-US');
  const targets = notePaths.map(key);
  // Obsidian writes a bare basename only while it is unique in the Vault.
  const basenames = targets.map(target => target.split('/').pop());
  return markdownLines(content).filter(line => {
    const match = line.plain ? /^- (.+?) \[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/.exec(line.text) : null;
    if (!match || !generatedTime.test(match[1])) return false;
    const target = key(match[2]);
    return targets.includes(target) || (!target.includes('/') && basenames.includes(target));
  });
}

/** The generated entries in a Daily Note that link to any of these Event Note paths. */
export function eventBulletText(content: string, notePaths: string[]): string[] {
  return eventBulletLines(content, notePaths).map(line => line.text);
}

export function hasEventBullet(content: string, notePaths: string[]): boolean {
  return eventBulletLines(content, notePaths).length > 0;
}

export function removeEventBullets(content: string, notePaths: string[]): string {
  return eventBulletLines(content, notePaths).reverse()
    .reduce((text, line) => text.slice(0, line.start) + text.slice(line.end), content);
}

/** Rewrite this event's first generated entry in place and drop repeats; add one when none exists. */
export function upsertEventBullet(content: string, bullet: string, notePaths: string[]): string {
  const [first, ...repeats] = eventBulletLines(content, notePaths);
  if (!first) return addEventBullet(content, bullet);
  const text = repeats.reverse().reduce((result, line) => result.slice(0, line.start) + result.slice(line.end), content);
  return text.slice(0, first.start) + bullet + text.slice(first.start + first.text.length);
}

export function addEventBullet(content: string, bullet: string): string {
  if (trackedLine(content, bullet)) return content;
  const section = eventSection(content);
  // An unclosed fence runs to the end of the note. Text appended there stays
  // code, so the entry would never be found and every open would add another.
  const fence = scanMarkdown(content).openFence;
  const close = fence && (!section || section.end === content.length) ? `${fence}\n` : '';
  if (!section) {
    const text = `${content}${content.endsWith('\n') ? '' : '\n'}${close}`;
    return `${text}${/(?:^|\n)\n$/.test(text) ? '' : '\n'}## Events\n${bullet}\n`;
  }
  // Follow the section's last non-blank line so entries stay contiguous.
  const last = markdownLines(content).filter(line => line.start >= section.start && line.start < section.end && line.text.trim()).pop();
  const before = content.slice(0, last?.end ?? section.start);
  return `${before}${before.endsWith('\n') ? '' : '\n'}${close}${bullet}\n${content.slice(before.length)}`;
}

/** Markdown below the frontmatter, which the dialog already shows as fields. */
export function noteBody(content: string): string {
  return content.replace(/^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/, '').trim();
}
