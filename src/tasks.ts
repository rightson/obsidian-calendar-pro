import { annotationFields, daysBetween, parseTaskLine, renderTaskLine, type Assignee, type TaskFields, type TaskLine } from './annotation';
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

/** A leaf without any date, shown in the chart's unscheduled area. */
export function isUnscheduled(node: TaskNode): boolean {
  return !node.summary && !node.start && !node.end && !node.due && !node.milestone;
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

/** Replace a line's title, keeping its marker, annotation, and block ID. */
export function retitleLine(text: string, today: string, title: string): string {
  const line = parseTaskLine(text, today);
  if (!line) throw new Error('Only headings and list items can be renamed here.');
  const clean = title.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) throw new Error('Enter a task name.');
  return renderTaskLine({ ...line, title: clean, ...line.annotation ? {} : { gap: '' } });
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
