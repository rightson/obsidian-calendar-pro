/**
 * Inline task annotations: the trailing parenthesis on a Project Note line.
 *
 *   - 視覺稿 (30%, 11/4-11/10, @小王)
 *   ## 設計 （11/20）
 *
 * A parenthesis is an annotation only when every comma-separated segment is a
 * recognised token; otherwise it is the user's own remark and stays text.
 * Text outside the last parenthesis is never parsed. Writing back changes only
 * the tokens that changed and keeps the line's brackets, separators, and the
 * raw spelling of every untouched token.
 */

export type Token =
  | { kind: 'progress'; value: number; sign: string }
  | { kind: 'due'; date: string; iso: boolean }
  | { kind: 'range'; start: string; end: string; sep: string; startIso: boolean; endIso: boolean }
  | { kind: 'milestone'; date: string; iso: boolean; space: string }
  | { kind: 'assignee'; name: string; style: 'at' | 'link'; alias?: string };

export interface Segment { raw: string; token: Token }

export interface Annotation {
  open: string;
  close: string;
  /** Whitespace just inside the brackets, kept as written. */
  lead: string;
  trail: string;
  segments: Segment[];
  /** The separators between segments, each with its surrounding spaces. */
  seps: string[];
}

export type Assignee = { name: string; style: 'at' | 'link'; alias?: string };

/** What an annotation says, independent of how it is spelled. */
export interface TaskFields {
  progress?: number;
  start?: string;
  end?: string;
  due?: string;
  milestone?: string;
  assignees: Assignee[];
}

export interface TaskLine {
  kind: 'heading' | 'bullet';
  /** Heading level, or the bullet's indentation width in columns. */
  level: number;
  /** Everything before the title: indent, marker, and checkbox. */
  prefix: string;
  checkbox?: { char: string; at: number };
  title: string;
  /** Whitespace between the title and the annotation. */
  gap: string;
  annotation?: Annotation;
  /** ` ^block-id` and anything after the annotation, kept verbatim. */
  suffix: string;
  blockId?: string;
}

const SEP = /(\s*[,，、]\s*)/;
const DATE = String.raw`(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2})`;
const RANGE = new RegExp(String.raw`^(${DATE})(\s*[-–~]\s*)(${DATE})$`);
const MILESTONE = new RegExp(String.raw`^◆(\s*)(${DATE})$`);

const pad = (value: number) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` for a real calendar date, otherwise undefined. */
export function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A written date; M/D takes `year`. */
function readDate(text: string, year: number): { date: string; iso: boolean } | undefined {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) {
    const date = isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return date ? { date, iso: true } : undefined;
  }
  const md = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (!md) return undefined;
  const date = isoDate(year, Number(md[1]), Number(md[2]));
  return date ? { date, iso: false } : undefined;
}

/** One segment of a parenthesis, or undefined when it is not a token. */
export function parseToken(text: string, today: string): Token | undefined {
  const year = Number(today.slice(0, 4));
  const progress = /^(\d{1,3})\s*([%％])$/.exec(text);
  if (progress) {
    const value = Number(progress[1]);
    return value <= 100 ? { kind: 'progress', value, sign: progress[2] } : undefined;
  }
  const milestone = MILESTONE.exec(text);
  if (milestone) {
    const date = readDate(milestone[2], year);
    return date ? { kind: 'milestone', date: date.date, iso: date.iso, space: milestone[1] } : undefined;
  }
  const range = RANGE.exec(text);
  if (range) {
    const start = readDate(range[1], year);
    if (!start) return undefined;
    // An end without a year follows the start, into the next year when it would come first.
    let end = readDate(range[3], Number(start.date.slice(0, 4)));
    if (end && !end.iso && end.date < start.date) end = readDate(range[3], Number(start.date.slice(0, 4)) + 1);
    if (!end || end.date < start.date) return undefined;
    return { kind: 'range', start: start.date, end: end.date, sep: range[2], startIso: start.iso, endIso: end.iso };
  }
  const single = readDate(text, year);
  if (single) return { kind: 'due', date: single.date, iso: single.iso };
  const at = /^@([^\s@,，、()（）[\]]+)$/.exec(text);
  if (at) return { kind: 'assignee', name: at[1], style: 'at' };
  const link = /^by\s+\[\[([^\][|#^]+)(?:\|([^\]]+))?\]\]$/.exec(text);
  if (link) return { kind: 'assignee', name: link[1].trim(), style: 'link', ...link[2] ? { alias: link[2] } : {} };
  return undefined;
}

/** The inside of a parenthesis as an annotation, or undefined when any segment is not a token. */
export function parseAnnotationBody(inner: string, today: string): Omit<Annotation, 'open' | 'close'> | undefined {
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner.slice(lead.length))![0];
  const body = inner.slice(lead.length, inner.length - trail.length);
  if (!body) return undefined;
  const parts = body.split(SEP);
  const segments: Segment[] = [];
  const seps: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    if (index % 2) { seps.push(parts[index]); continue; }
    const token = parseToken(parts[index], today);
    if (!token) return undefined;
    segments.push({ raw: parts[index], token });
  }
  // One value per field: two dates or two percentages are ambiguous, so the parenthesis stays a remark.
  const count = (kinds: Token['kind'][]) => segments.filter(segment => kinds.includes(segment.token.kind)).length;
  if (count(['progress']) > 1 || count(['due', 'range', 'milestone']) > 1) return undefined;
  return { lead, trail, segments, seps };
}

const PAIRS: Record<string, string> = { ')': '(', '）': '（' };

/** The title, annotation, and suffix of the text after a line's marker. */
function splitContent(content: string, today: string): Pick<TaskLine, 'title' | 'gap' | 'annotation' | 'suffix' | 'blockId'> {
  const block = /(\s+\^([A-Za-z0-9-]+))\s*$/.exec(content);
  const suffix = block ? content.slice(block.index) : /\s*$/.exec(content)![0];
  const main = content.slice(0, content.length - suffix.length);
  const blockId = block?.[2];
  const plain = { title: main, gap: '', suffix, ...blockId ? { blockId } : {} };
  const close = main.slice(-1);
  const open = PAIRS[close];
  if (!open) return plain;
  const at = main.lastIndexOf(open);
  if (at < 0) return plain;
  const inner = main.slice(at + 1, -1);
  if (inner.includes(open) || inner.includes(close)) return plain;
  const body = parseAnnotationBody(inner, today);
  if (!body) return plain;
  const before = main.slice(0, at);
  const gap = /\s*$/.exec(before)![0];
  return { title: before.slice(0, before.length - gap.length), gap, annotation: { open, close, ...body }, suffix, ...blockId ? { blockId } : {} };
}

const BULLET = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)(?:\[([^\]])\]([ \t]+|$))?/;
const HEADING = /^(#{1,6})[ \t]+/;

/** Indentation width with tabs as four columns. */
export function indentWidth(indent: string): number {
  let width = 0;
  for (const char of indent) width = char === '\t' ? width + 4 - (width % 4) : width + 1;
  return width;
}

/** A heading or list item line, or undefined for any other line. */
export function parseTaskLine(line: string, today: string): TaskLine | undefined {
  const heading = HEADING.exec(line);
  if (heading) {
    const rest = line.slice(heading[0].length);
    const closing = /[ \t]+#+[ \t]*$/.exec(rest);
    const parts = splitContent(closing ? rest.slice(0, closing.index) : rest, today);
    return { kind: 'heading', level: heading[1].length, prefix: heading[0], ...parts, suffix: parts.suffix + (closing?.[0] ?? '') };
  }
  const bullet = BULLET.exec(line);
  if (!bullet) return undefined;
  const checkbox = bullet[4] !== undefined ? { char: bullet[4], at: bullet[1].length + bullet[2].length + bullet[3].length + 1 } : undefined;
  return { kind: 'bullet', level: indentWidth(bullet[1]), prefix: bullet[0], ...checkbox ? { checkbox } : {},
    ...splitContent(line.slice(bullet[0].length), today) };
}

export function renderAnnotation(annotation: Annotation): string {
  const body = annotation.segments.map((segment, index) => (index ? annotation.seps[index - 1] : '') + segment.raw).join('');
  return `${annotation.open}${annotation.lead}${body}${annotation.trail}${annotation.close}`;
}

export function renderTaskLine(line: TaskLine): string {
  const annotation = line.annotation?.segments.length ? `${line.gap || ' '}${renderAnnotation(line.annotation)}` : '';
  return `${line.prefix}${line.title}${annotation}${line.suffix}`;
}

/** What the annotation says; the checkbox is not included. */
export function annotationFields(annotation: Annotation | undefined): TaskFields {
  const fields: TaskFields = { assignees: [] };
  for (const { token } of annotation?.segments ?? []) {
    switch (token.kind) {
      case 'progress': fields.progress = token.value; break;
      case 'due': fields.due = token.date; break;
      case 'range': fields.start = token.start; fields.end = token.end; break;
      case 'milestone': fields.milestone = token.date; break;
      case 'assignee': fields.assignees.push({ name: token.name, style: token.style, ...token.alias ? { alias: token.alias } : {} }); break;
    }
  }
  return fields;
}

/** A date as written back: M/D in the current year unless the line used the full form, YYYY-MM-DD otherwise. */
export function formatDate(date: string, today: string, preferIso = false): string {
  if (preferIso || date.slice(0, 4) !== today.slice(0, 4)) return date;
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

export function assigneeText(assignee: Assignee): string {
  return assignee.style === 'at' ? `@${assignee.name}` : `by [[${assignee.name}${assignee.alias ? `|${assignee.alias}` : ''}]]`;
}

export type Schedule = { start: string; end: string } | { due: string } | null;

/** The changes a write makes; a missing key leaves that field alone. */
export interface FieldChange {
  progress?: number;
  schedule?: Schedule;
  milestone?: string | null;
  assignees?: Assignee[];
}

const DATE_KINDS: Token['kind'][] = ['due', 'range'];

/**
 * Apply `change` to one line, rewriting only the tokens it touches. A line
 * without an annotation gains one such as `(30%, 11/1-11/6)`; progress 0 is
 * left out. With a checkbox, 100% is the ticked box rather than a token.
 */
export function updateTaskLine(text: string, change: FieldChange, today: string): string {
  const line = parseTaskLine(text, today);
  if (!line) throw new Error('Only headings and list items can carry task annotations.');
  const existing = line.annotation;
  const segments = existing ? existing.segments.map(segment => ({ ...segment })) as (Segment | null)[] : [];
  const added: Segment[] = [];
  const find = (kinds: Token['kind'][]) => segments.findIndex(segment => segment && kinds.includes(segment.token.kind));
  const put = (kinds: Token['kind'][], segment: Segment | null) => {
    const index = find(kinds);
    if (index >= 0) segments[index] = segment;
    else if (segment) added.push(segment);
  };

  let prefix = line.prefix;
  if (change.progress !== undefined) {
    const value = Math.max(0, Math.min(100, Math.round(change.progress)));
    let token: Segment | null = null;
    if (line.checkbox) {
      const char = value >= 100 ? 'x' : ' ';
      prefix = prefix.slice(0, line.checkbox.at) + char + prefix.slice(line.checkbox.at + 1);
    }
    if (value > 0 && !(line.checkbox && value >= 100)) {
      const old = segments[find(['progress'])]?.token;
      const sign = old?.kind === 'progress' ? old.sign : '%';
      token = { raw: `${value}${sign}`, token: { kind: 'progress', value, sign } };
    }
    put(['progress'], token);
  }

  if (change.schedule !== undefined) {
    const old = segments[find(DATE_KINDS)]?.token;
    const isoStart = old?.kind === 'range' ? old.startIso : old?.kind === 'due' ? old.iso : false;
    const isoEnd = old?.kind === 'range' ? old.endIso : old?.kind === 'due' ? old.iso : false;
    const schedule = change.schedule;
    let token: Segment | null = null;
    if (schedule && 'due' in schedule) {
      token = { raw: formatDate(schedule.due, today, isoEnd), token: { kind: 'due', date: schedule.due, iso: isoEnd } };
    } else if (schedule) {
      if (schedule.end < schedule.start) throw new Error('The end date is before the start date.');
      const sep = old?.kind === 'range' ? old.sep : '-';
      const start = formatDate(schedule.start, today, isoStart);
      const end = formatDate(schedule.end, today, isoEnd);
      token = { raw: `${start}${sep}${end}`, token: { kind: 'range', start: schedule.start, end: schedule.end, sep, startIso: start.includes('-'), endIso: end.includes('-') } };
    }
    put(DATE_KINDS, token);
  }

  if (change.milestone !== undefined) {
    const old = segments[find(['milestone'])]?.token;
    const space = old?.kind === 'milestone' ? old.space : ' ';
    const iso = old?.kind === 'milestone' ? old.iso : false;
    put(['milestone'], change.milestone === null ? null
      : { raw: `◆${space}${formatDate(change.milestone, today, iso)}`, token: { kind: 'milestone', date: change.milestone, iso, space } });
  }

  if (change.assignees !== undefined) {
    const old = segments.filter((segment): segment is Segment => segment?.token.kind === 'assignee');
    const next = change.assignees.map(assignee => old.find(segment => segment.token.kind === 'assignee'
      && segment.token.name === assignee.name && segment.token.style === assignee.style)
      ?? { raw: assigneeText(assignee), token: { kind: 'assignee' as const, ...assignee } });
    const first = find(['assignee']);
    for (let index = 0; index < segments.length; index++) if (segments[index]?.token.kind === 'assignee') segments[index] = null;
    if (first >= 0) segments.splice(first, 1, ...next);
    else added.push(...next);
  }

  // Remove dropped segments with the separator before them (or after, for the first one).
  const kept: Segment[] = [];
  const seps: string[] = [];
  const oldSeps = existing?.seps ?? [];
  segments.forEach((segment, index) => {
    if (!segment) return;
    if (kept.length) seps.push(oldSeps[Math.max(0, Math.min(index - 1, oldSeps.length - 1))] ?? defaultSep(existing));
    kept.push(segment);
  });
  for (const segment of added) {
    if (kept.length) seps.push(oldSeps[0] ?? defaultSep(existing));
    kept.push(segment);
  }
  const annotation: Annotation = existing
    ? { ...existing, segments: kept, seps }
    : { open: '(', close: ')', lead: '', trail: '', segments: order(kept), seps: kept.slice(1).map(() => ', ') };
  return renderTaskLine({ ...line, prefix, annotation, gap: existing ? line.gap : ' ' });
}

function defaultSep(annotation: Annotation | undefined): string {
  return annotation?.open === '（' ? '，' : ', ';
}

const ORDER: Token['kind'][] = ['progress', 'due', 'range', 'milestone', 'assignee'];
/** A new annotation lists progress, dates, then people. */
function order(segments: Segment[]): Segment[] {
  return [...segments].sort((a, b) => ORDER.indexOf(a.token.kind) - ORDER.indexOf(b.token.kind));
}

/** Add `^id` to a line that has no block ID, returning the line and the ID it carries. */
export function ensureBlockId(text: string, today: string, make: () => string): { text: string; id: string } {
  const line = parseTaskLine(text, today);
  if (line?.blockId) return { text, id: line.blockId };
  const id = make();
  const trimmed = text.replace(/\s+$/, '');
  return { text: `${trimmed} ^${id}${text.slice(trimmed.length)}`, id };
}
