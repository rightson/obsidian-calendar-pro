import { addDays, annotationFields, daysBetween, parseTaskLine, parseToken, renderTaskLine, type Assignee, type Schedule, type TaskFields, type TaskLine } from './annotation';
import { scanMarkdown } from './notes';

/**
 * A Project Note's outline as a WBS. Headings and list items are nodes;
 * heading levels and indentation give the hierarchy, and line order the
 * sequence. Every value is derived from the text on each read.
 */
export interface TaskNode {
  /** Stable while titles do not change: the title path with a repeat counter. */
  key: string;
  /** Zero-based line number in the note. */
  line: number;
  text: string;
  parsed: TaskLine;
  title: string;
  depth: number;
  /** Position-based number such as 1.2.1, never written to the note. */
  wbs: string;
  parent?: TaskNode;
  children: TaskNode[];
  own: TaskFields;
  /** The checkbox state, when the line has one. */
  checked?: boolean;
  /** Annotated, ticked, or holding tasks; plain text rows are not. */
  isTask: boolean;
  /** Has tasks below it: its dates and progress are rolled up. */
  summary: boolean;
  progress?: number;
  start?: string;
  end?: string;
  due?: string;
  milestone?: string;
  /** A summary's own date: the branch's target. */
  target?: string;
  /** The rolled-up end is later than the target. */
  late?: boolean;
  assignees: Assignee[];
  inherited: boolean;
}

export interface Project {
  roots: TaskNode[];
  /** Every node in outline order. */
  nodes: TaskNode[];
}

export function parseProject(content: string, today: string): Project {
  const roots: TaskNode[] = [];
  const nodes: TaskNode[] = [];
  const headings: TaskNode[] = [];
  let list: { indent: number; node: TaskNode }[] = [];
  scanMarkdown(content).lines.forEach((line, index) => {
    if (!line.plain) return;
    const parsed = parseTaskLine(line.text, today);
    if (!parsed || (!parsed.title.trim() && !parsed.annotation)) return;
    let parent: TaskNode | undefined;
    if (parsed.kind === 'heading') {
      while (headings.length && headings[headings.length - 1].parsed.level >= parsed.level) headings.pop();
      parent = headings[headings.length - 1];
      list = [];
    } else {
      // Irregular indentation: anything indented further than the last item is its child.
      while (list.length && list[list.length - 1].indent >= parsed.level) list.pop();
      parent = list[list.length - 1]?.node ?? headings[headings.length - 1];
    }
    const own = annotationFields(parsed.annotation);
    const node: TaskNode = {
      key: '', line: index, text: line.text, parsed, title: parsed.title.trim(), depth: parent ? parent.depth + 1 : 0,
      wbs: '', parent, children: [], own, isTask: false, summary: false, assignees: [], inherited: false,
      ...parsed.checkbox ? { checked: /^[xX]$/.test(parsed.checkbox.char) } : {},
    };
    (parent ? parent.children : roots).push(node);
    nodes.push(node);
    if (parsed.kind === 'heading') headings.push(node);
    else list.push({ indent: parsed.level, node });
  });
  number(roots, '', '');
  for (const root of roots) rollUp(root);
  for (const node of nodes) {
    const inherited = !node.own.assignees.length && !!node.parent;
    node.assignees = inherited ? node.parent!.assignees : node.own.assignees;
    node.inherited = inherited && node.assignees.length > 0;
  }
  return { roots, nodes };
}

function number(siblings: TaskNode[], prefix: string, keyPrefix: string): void {
  const seen = new Map<string, number>();
  siblings.forEach((node, index) => {
    node.wbs = prefix ? `${prefix}.${index + 1}` : String(index + 1);
    const repeat = seen.get(node.title) ?? 0;
    seen.set(node.title, repeat + 1);
    node.key = `${keyPrefix}/${node.title}#${repeat}`;
    number(node.children, node.wbs, node.key);
  });
}

/** The days a dated leaf spans, ends included; 1 for a deadline, milestone, or unscheduled task. */
export function taskWeight(node: Pick<TaskNode, 'start' | 'end'>): number {
  return node.start && node.end ? daysBetween(node.start, node.end) + 1 : 1;
}

function rollUp(node: TaskNode): void {
  for (const child of node.children) rollUp(child);
  node.summary = node.children.some(child => child.isTask);
  node.isTask = node.summary || !!node.parsed.annotation?.segments.length || node.checked !== undefined;
  const own = node.own;
  if (!node.summary) {
    if (!node.isTask) return;
    node.progress = node.checked ? 100 : own.progress ?? 0;
    node.start = own.start;
    node.end = own.end;
    node.due = own.due;
    node.milestone = own.milestone;
    return;
  }
  node.target = own.due ?? own.end ?? own.milestone;
  const leaves = taskLeaves(node);
  let weight = 0;
  let done = 0;
  for (const leaf of leaves) {
    const w = taskWeight(leaf);
    weight += w;
    done += w * (leaf.progress ?? 0);
    const from = leaf.start ?? leaf.due ?? leaf.milestone;
    const to = leaf.end ?? leaf.due ?? leaf.milestone;
    if (from && (!node.start || from < node.start)) node.start = from;
    if (to && (!node.end || to > node.end)) node.end = to;
  }
  node.progress = weight ? Math.round(done / weight) : 0;
  node.late = !!(node.target && node.end && node.end > node.target);
}

/** The tasks a summary rolls up: leaves below it, through nested summaries. */
export function taskLeaves(node: TaskNode): TaskNode[] {
  return node.children.flatMap(child => child.summary ? taskLeaves(child) : child.isTask ? [child] : []);
}

/** A plain row under a task that is not a summary, such as a note about that task. */
export function isRemark(node: TaskNode): boolean {
  return !node.isTask && !!node.parent && (node.parent.isTask && !node.parent.summary || isRemark(node.parent));
}

/** A leaf without any date, shown in the chart's unscheduled area; remarks are not tasks to schedule. */
export function isUnscheduled(node: TaskNode): boolean {
  return !node.summary && !isRemark(node) && !node.start && !node.end && !node.due && !node.milestone;
}

export const PROGRESS_STEPS = [10, 20] as const;

/** A step button is disabled when it would pass 100%. */
export function canStep(current: number, step: number | 'done'): boolean {
  return step === 'done' ? current < 100 : current + step <= 100;
}

export function stepProgress(current: number, step: number | 'done'): number {
  return step === 'done' ? 100 : Math.min(100, current + step);
}

const LINK = /^\[\[([^\][|#^]+)(?:\|([^\]]+))?\]\]$/;

/** The note a title links to when the title is exactly one wikilink. */
export function linkedTaskNote(title: string): { target: string; alias?: string } | undefined {
  const match = LINK.exec(title.trim());
  return match ? { target: match[1].trim(), ...match[2] ? { alias: match[2] } : {} } : undefined;
}

/** A title with wikilinks reduced to the text they show. */
export function plainTitle(title: string): string {
  return title.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => target.split('/').pop()!);
}

/** A file name for a Task Note made from a title. */
export function taskNoteName(title: string): string {
  return plainTitle(title).replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '') || 'Untitled task';
}

/** Replace a line's title with a link to `name`; the annotation, block ID, and children stay where they are. */
export function promoteLine(text: string, today: string, name: string): string {
  const line = parseTaskLine(text, today);
  if (!line) throw new Error('Only headings and list items can become Task Notes.');
  if (linkedTaskNote(line.title)) throw new Error('This task already links to a Task Note.');
  return renderTaskLine({ ...line, title: `[[${name}]]`, ...line.annotation ? {} : { gap: '' } });
}

/** Replace a Task Note link with its text again. */
export function demoteLine(text: string, today: string): { text: string; target: string } {
  const line = parseTaskLine(text, today);
  const link = line && linkedTaskNote(line.title);
  if (!line || !link) throw new Error('This task does not link to a Task Note.');
  const title = link.alias ?? link.target.split('/').pop()!;
  return { text: renderTaskLine({ ...line, title, ...line.annotation ? {} : { gap: '' } }), target: link.target };
}

const REMARK = /\s*(?:\([^()（）]*\)|（[^()（）]*）)$/;

/**
 * A title split into the name the user edits and the remark brackets after
 * it, as in `前端 （跟 AAA 確認）`. The annotation is not part of a title, so
 * these brackets are always the user's own; a title that is only brackets is
 * all name.
 */
export function splitTitle(title: string): { name: string; gap: string; remark: string } {
  let at = title.length;
  for (let match = REMARK.exec(title); match; match = REMARK.exec(title.slice(0, at))) at = match.index;
  const name = title.slice(0, at);
  if (!name.trim() || at === title.length) return { name: title, gap: '', remark: '' };
  const rest = title.slice(at);
  const gap = /^\s*/.exec(rest)![0];
  return { name, gap, remark: rest.slice(gap.length) };
}

/**
 * Replace a line's task name. The marker, checkbox, remark brackets after the
 * name, annotation, and block ID are kept as written.
 */
export function retitleLine(text: string, today: string, name: string): string {
  const line = parseTaskLine(text, today);
  if (!line) throw new Error('Only headings and list items can be renamed here.');
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new Error('Enter a task name.');
  const { gap, remark } = splitTitle(line.title);
  const title = remark ? `${clean}${gap}${remark}` : clean;
  return renderTaskLine({ ...line, title, ...line.annotation ? {} : { gap: '' } });
}

/** Why `name` cannot be a Task Note's file name, or undefined when it can. */
export function taskNoteNameError(name: string): string | undefined {
  const clean = name.trim();
  if (!clean) return 'Enter a task name.';
  if (/[\\/:*?"<>|#^[\]]/.test(clean)) return 'A Task Note name cannot contain \\ / : * ? " < > | # ^ [ or ].';
  if (clean.startsWith('.')) return 'A Task Note name cannot start with a dot.';
  return undefined;
}

/** Point a line's Task Note link at `target`, keeping its alias and everything else on the line. */
export function retargetLine(text: string, today: string, target: string): string {
  const line = parseTaskLine(text, today);
  const parts = line && splitTitle(line.title);
  const link = parts && linkedTaskNote(parts.name);
  if (!line || !parts || !link) throw new Error('This task does not link to a Task Note.');
  const name = `[[${target}${link.alias ? `|${link.alias}` : ''}]]`;
  const title = parts.remark ? `${name}${parts.gap}${parts.remark}` : name;
  return renderTaskLine({ ...line, title, ...line.annotation ? {} : { gap: '' } });
}

/** The node and every node below it. */
export function subtree(node: TaskNode): TaskNode[] {
  return [node, ...node.children.flatMap(subtree)];
}

/** The rows to collapse so that only the first `level` levels show. */
export function collapsedBelow(nodes: TaskNode[], level: number): Set<string> {
  return new Set(nodes.filter(node => node.children.length && node.depth >= level - 1).map(node => node.key));
}

/** The node's own assignees as typed in a cell: `@name`, `[[name]]`, `by [[name]]`, or a bare name. */
export function parseAssigneeInput(input: string): Assignee[] | undefined {
  const items = input.split(/\s*[,，、]\s*/).map(item => item.trim()).filter(Boolean);
  const result: Assignee[] = [];
  for (const item of items) {
    const link = /^(?:by\s+)?\[\[([^\][|#^]+)(?:\|([^\]]+))?\]\]$/.exec(item);
    if (link) { result.push({ name: link[1].trim(), style: 'link', ...link[2] ? { alias: link[2] } : {} }); continue; }
    const name = item.replace(/^@/, '');
    if (!/^[^\s@,，、()（）[\]]+$/.test(name)) return undefined;
    result.push({ name, style: 'at' });
  }
  return result;
}

/** `@name` becomes `by [[name]]`; other assignees are unchanged. */
export function upgradeAssignee(assignees: Assignee[], name: string): Assignee[] {
  return assignees.map(assignee => assignee.style === 'at' && assignee.name === name ? { name, style: 'link' } : assignee);
}

/** A date typed in a cell: M/D in the current year or YYYY-MM-DD; null when emptied, undefined when unreadable. */
export function parseDateInput(text: string, today: string): string | null | undefined {
  const value = text.trim();
  if (!value) return null;
  const token = parseToken(value, today);
  return token?.kind === 'due' ? token.date : undefined;
}

/**
 * The schedule after editing a leaf's Start or End cell. A Start without an
 * End starts and ends that day; clearing Start leaves the End as a deadline.
 */
export function scheduleFromCell(node: Pick<TaskNode, 'start' | 'end' | 'due'>, cell: 'start' | 'end', value: string | null): Schedule | string {
  const end = node.end ?? node.due;
  if (cell === 'start') {
    if (value === null) return end ? { due: end } : null;
    if (!end) return { start: value, end: value };
    return value > end ? 'Start is after End.' : { start: value, end };
  }
  if (value === null) return null;
  if (!node.start) return { due: value };
  return value < node.start ? 'End is before Start.' : { start: node.start, end: value };
}

/** A dated leaf of a Project as a read-only all-day calendar entry. */
export interface TaskEvent {
  id: string;
  path: string;
  line: number;
  text: string;
  title: string;
  kind: 'range' | 'due' | 'milestone';
  start: string;
  /** Exclusive, as all-day calendar events end. */
  end: string;
  progress: number;
  blockId?: string;
}

export function projectTaskEvents(path: string, project: Project): TaskEvent[] {
  return project.nodes.flatMap(node => {
    if (node.summary || !node.isTask) return [];
    const kind = node.start && node.end ? 'range' : node.due ? 'due' : node.milestone ? 'milestone' : undefined;
    if (!kind) return [];
    const start = kind === 'range' ? node.start! : (node.due ?? node.milestone)!;
    const last = kind === 'range' ? node.end! : start;
    return [{ id: `task|${path}|${node.line}`, path, line: node.line, text: node.text, title: plainTitle(node.title), kind,
      start, end: addDays(last, 1), progress: node.progress ?? 0, ...node.parsed.blockId ? { blockId: node.parsed.blockId } : {} }];
  });
}
