import { ItemView, Menu, Notice, TFile, getIcon, normalizePath, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { addDays, assigneeText, daysBetween, formatDate, parseTaskLine, personName, remarkIssue, updateTaskLine, type Assignee, type FieldChange } from './annotation';
import { dateAt } from './date';
import { dayWidthOf, fitDayWidth, isZoom, levelFor, scale, stepZoom, ZOOM_LEVELS, type Band, type Zoom } from './gantt-scale';
import { hasGanttKey } from './project-edit';
import { confirmAction } from './project-writer';
import { hintLabel, taskHints } from './task-hints';
import {
  canStep, collapsedBelow, demoteLine, isRemark, isUnscheduled, linkedTaskNote, parseAssigneeInput, parseDateInput, parseProject, plainTitle, promoteLine,
  PROGRESS_STEPS, retargetLine, retitleLine, scheduleFromCell, splitTitle, stepProgress, subtree, taskNoteName, taskNoteNameError, upgradeAssignee,
  type Project, type TaskNode,
} from './tasks';
import type CalendarNotePlugin from './main';

export const GANTT_VIEW_TYPE = 'event-notes-gantt';
/** Lucide renamed its Gantt icon; use whichever this Obsidian has. */
export const ganttIcon = (): string => getIcon('chart-gantt') ? 'chart-gantt' : getIcon('gantt-chart') ? 'gantt-chart' : 'list-tree';

type Mode = 'table' | 'chart';
type Parsed<T> = { value: T } | { error: string };

const LABEL_WIDTH = 320;
const MIN_LABEL = 160;
const MAX_LABEL = 720;
const LEVELS = [1, 2, 3];

const weekday = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
const hue = (name: string) => [...name].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) % 360, 7);
const clampLabel = (width: number) => Math.round(Math.max(MIN_LABEL, Math.min(MAX_LABEL, width)));
const sameKeys = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(key => b.has(key));

/**
 * One Project Note as a WBS table or a Gantt chart. Everything shown is read
 * from the note's text; every edit rewrites the line it came from.
 */
export class GanttView extends ItemView {
  file: TFile | null = null;
  private mode: Mode = 'table';
  private content = '';
  private project?: Project;
  private collapsed = new Set<string>();
  private colorBy: 'none' | 'assignee' = 'none';
  private filter = '';
  private zoom: Zoom = 'day';
  /** Pixels per day as last drawn; drags and drops count whole days of it. */
  private dayWidth = dayWidthOf('day');
  private labelWidth = LABEL_WIDTH;
  /** Where to scroll after a zoom: keep `day` under the point `px` from the scroller's left edge. */
  private anchor?: { day: number; px: number; top: number };
  private wheel = { delta: 0, at: 0 };
  private scrolledToToday = false;
  private rootEl?: HTMLElement;
  private errors = new Set<HTMLElement>();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CalendarNotePlugin) { super(leaf); }

  getViewType(): string { return GANTT_VIEW_TYPE; }
  getDisplayText(): string { return this.file ? `${this.file.basename} (Gantt)` : 'Gantt'; }
  getIcon(): string { return ganttIcon(); }

  /** The layout keeps the mode, zoom, Task column width, and collapsed rows; none of it goes into the note. */
  getState(): Record<string, unknown> {
    return { ...super.getState(), file: this.file?.path, mode: this.mode, zoom: this.zoom, labelWidth: this.labelWidth, collapsed: [...this.collapsed] };
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const value = (state ?? {}) as { file?: unknown; mode?: unknown; zoom?: unknown; labelWidth?: unknown; collapsed?: unknown };
    if (value.mode === 'table' || value.mode === 'chart') this.mode = value.mode;
    if (isZoom(value.zoom)) this.zoom = value.zoom;
    if (typeof value.labelWidth === 'number' && Number.isFinite(value.labelWidth)) this.labelWidth = clampLabel(value.labelWidth);
    const collapsed = Array.isArray(value.collapsed) ? value.collapsed.filter((key): key is string => typeof key === 'string') : undefined;
    const file = typeof value.file === 'string' ? this.app.vault.getAbstractFileByPath(value.file) : null;
    if (file instanceof TFile && file !== this.file) {
      this.file = file;
      this.content = '';
      this.collapsed = new Set(collapsed ?? []);
      this.scrolledToToday = false;
    } else if (collapsed) {
      this.collapsed = new Set(collapsed);
    }
    await super.setState(state, result);
    await this.reload(true);
  }

  async onOpen(): Promise<void> {
    this.rootEl = this.containerEl.children[1] as HTMLElement;
    this.rootEl.addClass('cp-gantt-view');
    this.registerEvent(this.app.metadataCache.on('changed', file => { if (file === this.file) void this.reload(); }));
    this.registerEvent(this.app.vault.on('rename', file => { if (file === this.file) this.render(); }));
    this.registerEvent(this.app.vault.on('delete', file => { if (file === this.file) { this.file = null; this.render(); } }));
    // A tap on a touch screen opens one row's progress buttons; a tap anywhere else closes them.
    this.registerDomEvent(this.rootEl, 'pointerdown', event => {
      const row = (event.target as HTMLElement).closest('.cp-row');
      for (const open of Array.from(this.rootEl?.querySelectorAll('.cp-row.is-steps-open') ?? [])) if (open !== row) open.removeClass('is-steps-open');
    });
    this.render();
  }

  async onClose(): Promise<void> { this.clearErrors(); }

  onResize(): void {
    if (this.mode === 'chart' && this.zoom === 'fit') this.render();
  }

  private saveState(): void { this.app.workspace.requestSaveLayout(); }

  private get today(): string {
    return dateAt(new Date(), this.plugin.store.state.settings.timeZone).format('YYYY-MM-DD');
  }

  /** Re-read the note; renders only when its text changed, so a cell being edited is not replaced. */
  async reload(force = false): Promise<void> {
    if (!this.file) { this.render(); return; }
    try {
      const content = await this.plugin.projectWriter.read(this.file);
      if (!force && content === this.content && this.project) return;
      this.content = content;
      this.project = parseProject(content, this.today);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not read the note.');
    }
    this.render();
  }

  /** Redraw from the parsed note, keeping the scroll position unless the layout changed. */
  private render(keepScroll = true): void {
    const root = this.rootEl;
    if (!root) return;
    const scroller = root.querySelector<HTMLElement>('.cp-gantt-scroll');
    const scroll = keepScroll && scroller && this.scrolledToToday ? [scroller.scrollLeft, scroller.scrollTop] : undefined;
    this.clearErrors();
    root.empty();
    this.renderToolbar(root);
    const body = root.createDiv({ cls: `cp-gantt-body is-${this.mode}` });
    if (!this.file || !this.project) {
      body.createDiv({ cls: 'cp-gantt-empty', text: this.file ? 'Loading…' : 'The note was deleted or moved.' });
      return;
    }
    if (!this.project.nodes.length) {
      body.createDiv({ cls: 'cp-gantt-empty', text: 'This note has no headings or list items yet. Write an outline in the note, then come back.' });
      return;
    }
    const scrollEl = body.createDiv({ cls: 'cp-gantt-scroll' });
    scrollEl.addEventListener('scroll', () => this.clearErrors(), { passive: true });
    if (this.mode === 'table') this.renderTable(scrollEl);
    else this.renderChart(scrollEl, body);
    const anchor = this.anchor;
    this.anchor = undefined;
    if (anchor && this.mode === 'chart') {
      scrollEl.scrollLeft = Math.max(0, this.labelWidth + anchor.day * this.dayWidth - anchor.px);
      scrollEl.scrollTop = anchor.top;
      this.scrolledToToday = true;
    } else if (scroll) { scrollEl.scrollLeft = scroll[0]; scrollEl.scrollTop = scroll[1]; }
    else if (this.mode === 'chart') this.scrollToToday(scrollEl);
    else this.scrolledToToday = true;
  }

  private clearErrors(): void {
    for (const error of this.errors) error.remove();
    this.errors.clear();
  }

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: 'cp-gantt-toolbar' });
    bar.createEl('strong', { cls: 'cp-gantt-title', text: this.file?.basename ?? 'Gantt' });
    const modes = bar.createDiv({ cls: 'cp-gantt-modes', attr: { role: 'group', 'aria-label': 'View mode' } });
    const modeButton = (label: string, active: boolean, click: () => void) => {
      const button = modes.createEl('button', { text: label, attr: { 'aria-pressed': String(active) } });
      button.toggleClass('is-active', active);
      button.addEventListener('click', click);
    };
    modeButton('Note', false, () => void this.showNote());
    modeButton('Table', this.mode === 'table', () => this.setMode('table'));
    modeButton('Chart', this.mode === 'chart', () => this.setMode('chart'));
    const controls = bar.createDiv({ cls: 'cp-gantt-controls' });
    const group = (label: string, cls = '') => {
      const el = controls.createDiv({ cls: `cp-gantt-segmented ${cls}`.trim(), attr: { role: 'group', 'aria-label': label } });
      return (text: string, title: string, active: boolean, click: () => void) => {
        const button = el.createEl('button', { text, attr: { 'aria-label': title, 'aria-pressed': String(active), title } });
        button.toggleClass('is-active', active);
        button.addEventListener('click', click);
        return button;
      };
    };
    const nodes = this.project?.nodes ?? [];
    const parents = new Set(nodes.filter(node => node.children.length).map(node => node.key));
    const shown = new Set([...this.collapsed].filter(key => parents.has(key)));
    const level = group('Outline levels', 'cp-gantt-levels');
    for (const depth of LEVELS) {
      const keys = collapsedBelow(nodes, depth);
      level(String(depth), `Expand to level ${depth}`, !!parents.size && sameKeys(shown, keys), () => this.setCollapsed(keys));
    }
    level('Expand all', 'Expand all', !shown.size, () => this.setCollapsed(new Set()));
    level('Collapse all', 'Collapse all', !!parents.size && sameKeys(shown, parents), () => this.setCollapsed(new Set(parents)));
    if (this.mode === 'chart') {
      const zoom = group('Zoom', 'cp-gantt-zoom');
      for (const option of ZOOM_LEVELS) zoom(option.label, `Zoom to ${option.label.toLowerCase()}s (Ctrl/Cmd + scroll to zoom)`, this.zoom === option.level, () => this.zoomTo(option.level));
      const fit = zoom('', 'Zoom to fit the whole project', this.zoom === 'fit', () => this.zoomTo('fit'));
      setIcon(fit, 'maximize-2');
      const select = (label: string, options: [string, string][], value: string, change: (value: string) => void) => {
        const el = controls.createEl('select', { attr: { 'aria-label': label, title: label } });
        for (const [key, text] of options) el.createEl('option', { value: key, text });
        el.value = value;
        el.addEventListener('change', () => change(el.value));
      };
      select('Colour bars', [['none', 'One colour'], ['assignee', 'Colour by assignee']], this.colorBy, value => { this.colorBy = value as 'none' | 'assignee'; this.render(); });
      const names = [...new Set((this.project?.nodes ?? []).flatMap(node => node.assignees.map(personName)))].sort();
      select('Show assignee', [['', 'Everyone'], ...names.map(name => [name, name] as [string, string])], this.filter, value => { this.filter = value; this.render(); });
    }
    if (this.file && this.project && !hasGanttKey(this.content)) {
      bar.createDiv({ cls: 'cp-gantt-hint', text: 'Not a Project yet: the first change adds gantt: true to this note.' });
    }
  }

  private setCollapsed(keys: Set<string>): void {
    this.collapsed = keys;
    this.saveState();
    this.render();
  }

  /** Change the zoom, keeping the day at `clientX` (or the middle of the timeline) where it is. */
  private zoomTo(zoom: Zoom, clientX?: number): void {
    const scroller = this.rootEl?.querySelector<HTMLElement>('.cp-gantt-scroll');
    if (scroller && this.mode === 'chart') {
      const px = clientX !== undefined ? clientX - scroller.getBoundingClientRect().left : this.labelWidth + (scroller.clientWidth - this.labelWidth) / 2;
      const day = zoom === 'fit' ? 0 : Math.max(0, (scroller.scrollLeft + px - this.labelWidth) / this.dayWidth);
      this.anchor = { day, px: zoom === 'fit' ? this.labelWidth : px, top: scroller.scrollTop };
    }
    this.zoom = zoom;
    this.saveState();
    this.render(false);
  }

  /** Ctrl/Cmd + wheel (and a trackpad pinch) steps through the zoom levels. */
  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const now = event.timeStamp;
    if (now - this.wheel.at > 250) this.wheel.delta = 0;
    this.wheel.at = now;
    this.wheel.delta += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    if (Math.abs(this.wheel.delta) < 40) return;
    const next = stepZoom(this.zoom, this.dayWidth, this.wheel.delta < 0 ? -1 : 1);
    this.wheel.delta = 0;
    if (next !== this.zoom) this.zoomTo(next, event.clientX);
  }

  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.scrolledToToday = false;
    this.app.workspace.requestSaveLayout();
    this.render(false);
  }

  private async showNote(): Promise<void> {
    if (!this.file) return;
    await this.leaf.setViewState({ type: 'markdown', state: { file: this.file.path, mode: 'source' }, active: true });
  }

  // —— Shared tree ——

  private matches(node: TaskNode): boolean {
    if (!this.filter || this.mode !== 'chart') return true;
    return node.assignees.some(assignee => personName(assignee) === this.filter) || node.children.some(child => this.matches(child));
  }

  private visibleNodes(): TaskNode[] {
    const result: TaskNode[] = [];
    const walk = (nodes: TaskNode[]) => {
      for (const node of nodes) {
        if (!this.matches(node)) continue;
        result.push(node);
        if (!this.collapsed.has(node.key)) walk(node.children);
      }
    };
    walk(this.project?.roots ?? []);
    return result;
  }

  private caret(parent: HTMLElement, node: TaskNode): void {
    if (!node.children.length) { parent.createSpan({ cls: 'cp-caret is-empty' }); return; }
    const open = !this.collapsed.has(node.key);
    const caret = parent.createEl('button', { cls: 'cp-caret', attr: {
      'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${plainTitle(node.title)}`,
      title: `${open ? 'Collapse' : 'Expand'} (Alt/Option-click: every level below)`,
    } });
    caret.toggleClass('is-open', open);
    setIcon(caret, 'chevron-right');
    caret.addEventListener('click', event => {
      // Alt/Option-click opens or closes the whole branch, not just this row.
      for (const each of event.altKey ? subtree(node).filter(child => child.children.length) : [node]) {
        if (open) this.collapsed.add(each.key); else this.collapsed.delete(each.key);
      }
      this.saveState();
      this.render();
    });
  }

  /**
   * Collapsed rows are remembered by key, and a key holds the title; move
   * them along when a row is renamed. Returns a function that puts them back.
   */
  private rekey(node: TaskNode, title: string): () => void {
    const before = new Set(this.collapsed);
    const repeat = /#\d+$/.exec(node.key)?.[0] ?? '#0';
    const next = `${node.parent?.key ?? ''}/${title}${repeat}`;
    this.collapsed = new Set([...before].map(key => key === node.key || key.startsWith(`${node.key}/`) ? next + key.slice(node.key.length) : key));
    if (!sameKeys(before, this.collapsed)) this.saveState();
    return () => { this.collapsed = before; this.saveState(); };
  }

  // —— Writes ——

  private async edit(node: TaskNode, compute: (text: string) => string, label: string): Promise<boolean> {
    if (!this.file) return false;
    let changed = false;
    try { changed = await this.plugin.projectWriter.writeLine(this.file.path, node.line, node.text, compute, label); }
    catch (error) { new Notice(error instanceof Error ? error.message : 'Could not change the note.'); }
    if (!changed) await this.reload(true);
    return changed;
  }

  private change(node: TaskNode, change: FieldChange, label: string): Promise<boolean> {
    return this.edit(node, text => updateTaskLine(text, change, this.today), label);
  }

  private name(node: TaskNode): string { return `“${plainTitle(node.title)}”`; }

  // —— Table ——

  private renderTable(body: HTMLElement): void {
    const table = body.createEl('table', { cls: 'cp-gantt-table' });
    const head = table.createEl('thead').createEl('tr');
    for (const label of ['WBS', 'Task', '%', 'Start', 'End', 'Assignee', '']) head.createEl('th', { text: label });
    const rows = table.createEl('tbody');
    for (const node of this.visibleNodes()) this.renderTableRow(rows, node);
  }

  private renderTableRow(rows: HTMLElement, node: TaskNode): void {
    const row = rows.createEl('tr', { cls: 'cp-row' });
    row.toggleClass('is-summary', node.summary);
    row.toggleClass('is-plain', !node.isTask);
    row.toggleClass('is-late', !!node.late);
    row.createEl('td', { cls: 'cp-wbs', text: node.wbs });
    this.renderTaskCell(row.createEl('td', { cls: 'cp-task' }), node);

    const pct = row.createEl('td', { cls: 'cp-pct' });
    const box = pct.createDiv({ cls: 'cp-pct-box' });
    if (node.summary) this.meter(box, node.progress ?? 0);
    else this.input(box, node.isTask ? String(node.progress ?? 0) : '', 'Progress', text => {
      const match = /^\s*(\d{1,3})\s*[%％]?\s*$/.exec(text);
      if (!text.trim()) return { value: 0 };
      return match && Number(match[1]) <= 100 ? { value: Number(match[1]) } : { error: 'Enter a number from 0 to 100.' };
    }, value => this.change(node, { progress: value }, `Progress of ${this.name(node)} is ${value}%.`), { placeholder: '–', cls: 'cp-pct-input' });
    if (!node.summary && !isRemark(node)) this.renderSteps(box, node);
    // Touch screens have no hover: a tap on the % cell shows the buttons.
    pct.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || (event.target as HTMLElement).closest('.cp-steps')) return;
      row.addClass('is-steps-open');
    });

    this.renderDateCells(row, node);
    this.renderAssigneeCell(row.createEl('td', { cls: 'cp-assignee' }), node);
    this.renderActions(row.createEl('td', { cls: 'cp-actions' }), node);
  }

  private renderTaskCell(cell: HTMLElement, node: TaskNode): void {
    const wrap = cell.createDiv({ cls: 'cp-task-wrap' });
    wrap.setCssProps({ '--cp-depth': String(node.depth) });
    this.caret(wrap, node);
    this.renderName(wrap, node);
    const issue = remarkIssue(node.title, this.today);
    if (issue.length) {
      const warn = wrap.createSpan({ cls: 'cp-remark-warning', text: '⚠' });
      warn.title = `The last brackets are kept as a remark because “${issue.join('”, “')}” is not a %, date, ◆ milestone, or assignee.`;
    }
    if (node.summary) return;
    const own = node.own;
    for (const hint of taskHints(plainTitle(node.title), this.today, { dated: !!(own.start || own.due || own.milestone), assigned: own.assignees.length > 0 })) {
      const chip = wrap.createEl('button', { cls: 'cp-hint-chip', text: hintLabel(hint, this.today) });
      chip.addEventListener('click', () => void (hint.kind === 'date'
        ? this.change(node, { schedule: { due: hint.date } }, `${this.name(node)} is due ${formatDate(hint.date, this.today)}.`)
        : this.change(node, { assignees: [...own.assignees, { name: hint.name, style: 'at' }] }, `Assigned ${this.name(node)} to ${hint.name}.`)));
    }
  }

  private renderDateCells(row: HTMLElement, node: TaskNode): void {
    const start = row.createEl('td', { cls: 'cp-date' });
    const end = row.createEl('td', { cls: 'cp-date' });
    const show = (date?: string) => date ? formatDate(date, this.today) : '';
    const dateParse = (text: string): Parsed<string | null> => {
      const value = parseDateInput(text, this.today);
      return value === undefined ? { error: 'Use M/D (this year) or YYYY-MM-DD.' } : { value };
    };
    if (node.summary) {
      start.createSpan({ cls: 'cp-derived', text: show(node.start) });
      end.createSpan({ cls: 'cp-derived', text: show(node.end) });
      const target = end.createDiv({ cls: 'cp-target-cell' });
      target.createSpan({ text: 'target ' });
      this.input(target, show(node.target), 'Target date', dateParse,
        value => this.change(node, { schedule: value ? { due: value } : null }, value ? `Target of ${this.name(node)} is ${show(value)}.` : `Removed the target of ${this.name(node)}.`),
        { placeholder: '—', cls: 'cp-target-input' });
      if (node.late) {
        end.addClass('is-late');
        end.title = `The tasks below end ${show(node.end)}, after the ${show(node.target)} target.`;
      }
      return;
    }
    if (node.milestone) {
      start.createSpan({ cls: 'cp-derived', text: '◆' });
      this.input(end, show(node.milestone), 'Milestone date', dateParse,
        value => this.change(node, { milestone: value }, value ? `Milestone ${this.name(node)} is on ${show(value)}.` : `Removed the milestone date.`));
      return;
    }
    const cell = (el: HTMLElement, which: 'start' | 'end', value?: string) => this.input(el, show(value), which === 'start' ? 'Start' : 'End', text => {
      const parsed = dateParse(text);
      if ('error' in parsed) return parsed;
      const schedule = scheduleFromCell(node, which, parsed.value);
      return typeof schedule === 'string' ? { error: schedule } : { value: schedule };
    }, schedule => this.change(node, { schedule }, schedule ? `Dates of ${this.name(node)} changed.` : `Removed the dates of ${this.name(node)}.`), { placeholder: '–' });
    cell(start, 'start', node.start);
    cell(end, 'end', node.end ?? node.due);
    if (node.due && !node.start) end.addClass('is-deadline');
  }

  private renderAssigneeCell(cell: HTMLElement, node: TaskNode): void {
    const own = node.own.assignees;
    this.input<Assignee[]>(cell, own.map(assigneeText).join(', '), 'Assignee', text => {
      const value = parseAssigneeInput(text);
      return value ? { value } : { error: 'Use @name, @[[name]], or [[@name]], separated by commas.' };
    }, value => this.change(node, { assignees: value }, value.length ? `Assigned ${this.name(node)}.` : `Cleared the assignee of ${this.name(node)}.`), {
      placeholder: node.inherited ? `${node.assignees.map(personName).join(', ')} (inherited)` : '',
    });
    for (const assignee of node.assignees) {
      if (assignee.style === 'link' && !this.app.metadataCache.getFirstLinkpathDest(assignee.name, this.file?.path ?? '')) {
        const add = cell.createEl('button', { cls: 'cp-mini-button', text: '＋', attr: { 'aria-label': `Create a note for ${personName(assignee)}` } });
        add.title = `Create ${this.personPath(assignee.name)}`;
        add.addEventListener('click', () => void this.createPerson(assignee.name));
      }
      if (assignee.style === 'at' && !node.inherited) {
        // Follow the Vault: link `@name` notes as [[@name]], others as @[[name]].
        const atNote = `@${assignee.name}`;
        const target = this.app.metadataCache.getFirstLinkpathDest(atNote, this.file?.path ?? '') ? atNote : assignee.name;
        const text = assigneeText({ name: target, style: 'link' });
        const upgrade = cell.createEl('button', { cls: 'cp-mini-button', text: '[[ ]]', attr: { 'aria-label': `Link @${assignee.name} as ${text}` } });
        upgrade.title = `Change @${assignee.name} to ${text}`;
        upgrade.addEventListener('click', () => void this.change(node, { assignees: upgradeAssignee(own, assignee.name, target) }, `Linked ${assignee.name}.`));
      }
    }
  }

  /** +10, +20, and Done beside the %, in space kept for them; they show while the row is hovered or focused. */
  private renderSteps(parent: HTMLElement, node: TaskNode): void {
    const steps = parent.createDiv({ cls: 'cp-steps', attr: { role: 'group', 'aria-label': `Raise the progress of ${plainTitle(node.title)}` } });
    const current = node.isTask ? node.progress ?? 0 : 0;
    for (const step of [...PROGRESS_STEPS, 'done'] as const) {
      const button = steps.createEl('button', { cls: 'cp-step', text: step === 'done' ? 'Done' : `+${step}` });
      button.disabled = !canStep(current, step);
      button.addEventListener('click', () => {
        const value = stepProgress(current, step);
        void this.change(node, { progress: value }, `Progress of ${this.name(node)} is ${value}%.`);
      });
    }
  }

  /**
   * The task name as an editable field. Only the name is rewritten: remark
   * brackets after it, the annotation, and the block ID stay. A Task Note link
   * renames the note itself, and Obsidian updates the links to it.
   */
  private renderName(parent: HTMLElement, node: TaskNode, cls = ''): void {
    const { name, remark } = splitTitle(node.title);
    const link = linkedTaskNote(name);
    if (!link) {
      this.input<string>(parent, name, 'Task name', text => text.trim() ? { value: text.trim() } : { error: 'Enter a task name.' }, value => {
        const { gap, remark: kept } = splitTitle(node.title);
        const restore = this.rekey(node, kept ? `${value}${gap}${kept}` : value);
        return this.edit(node, text => retitleLine(text, this.today, value), `Renamed “${plainTitle(name)}” to “${value}”.`).then(done => { if (!done) restore(); });
      }, { cls: `cp-title-input ${cls}`.trim() });
    } else if (link.alias !== undefined) {
      // The row shows the alias, so the alias is what changes; the link still points at the same note.
      const input = this.input<string>(parent, link.alias, 'Task name', text => {
        if (!text.trim()) return { error: 'Enter a task name.' };
        return /[[\]|]/.test(text) ? { error: 'The shown name cannot contain [, ], or |.' } : { value: text.trim() };
      }, value => this.edit(node, text => retitleLine(text, this.today, `[[${link.target}|${value}]]`), `Renamed “${link.alias}” to “${value}”.`),
      { cls: `cp-title-input is-link ${cls}`.trim() });
      input.setAttr('aria-description', `The link text; the Task Note stays ${link.target}.`);
    } else {
      const input = this.input<string>(parent, link.target.split('/').pop()!, 'Task name', text => {
        const error = taskNoteNameError(text);
        return error ? { error } : { value: text.trim() };
      }, value => this.renameTaskNote(node, link.target, value), { cls: `cp-title-input is-link ${cls}`.trim() });
      input.setAttr('aria-description', `Renames the Task Note ${link.target}.`);
    }
    if (link) {
      const open = parent.createEl('button', { cls: 'cp-open-note clickable-icon', attr: { 'aria-label': `Open Task Note ${link.target}`, title: `Open ${link.target}` } });
      setIcon(open, 'arrow-up-right');
      open.addEventListener('click', () => void this.app.workspace.openLinkText(link.target, this.file?.path ?? '', 'tab'));
    }
    if (remark) parent.createSpan({ cls: 'cp-remark', text: remark, attr: { title: 'Your remark. Renaming the task keeps it.' } });
  }

  private renderActions(cell: HTMLElement, node: TaskNode): void {
    const more = cell.createEl('button', { cls: 'cp-more clickable-icon', attr: { 'aria-label': 'More actions' } });
    setIcon(more, 'more-horizontal');
    more.addEventListener('click', event => this.rowMenu(node, event));
  }

  private rowMenu(node: TaskNode, event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item => item.setTitle('Open in note').setIcon('file-text').onClick(() => {
      if (this.file) void this.plugin.runAction(() => this.plugin.openNoteAt(this.file!.path, node.line, this.app.workspace.getLeaf('tab')));
    }));
    if (linkedTaskNote(node.title)) {
      menu.addItem(item => item.setTitle('Demote to text').setIcon('unlink').onClick(() => void this.demote(node)));
    } else {
      menu.addItem(item => item.setTitle('Promote to Task Note').setIcon('file-plus').onClick(() => void this.promote(node)));
    }
    menu.showAtMouseEvent(event);
  }

  private meter(cell: HTMLElement, value: number): void {
    const meter = cell.createDiv({ cls: 'cp-meter', attr: { role: 'img', 'aria-label': `${value}% done` } });
    meter.createDiv({ cls: 'cp-meter-fill' }).setCssProps({ width: `${value}%` });
    cell.createSpan({ cls: 'cp-meter-text', text: `${value}%` });
  }

  /** A text cell written back on Enter or blur; Escape restores it, unreadable text shows why. */
  private input<T>(parent: HTMLElement, value: string, label: string, parse: (text: string) => Parsed<T>, apply: (value: T) => Promise<unknown>,
    options: { placeholder?: string; cls?: string } = {}): HTMLInputElement {
    const input = parent.createEl('input', { type: 'text', cls: `cp-cell-input ${options.cls ?? ''}`.trim(), value, attr: { 'aria-label': label } });
    if (options.placeholder) input.placeholder = options.placeholder;
    let error: HTMLElement | undefined;
    const clear = () => {
      input.removeClass('is-invalid'); input.removeAttribute('aria-invalid'); input.title = '';
      if (error) { error.remove(); this.errors.delete(error); error = undefined; }
    };
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
      if (event.key === 'Escape') { input.value = value; clear(); input.blur(); }
    });
    input.addEventListener('input', clear);
    input.addEventListener('change', () => {
      if (input.value === value) return;
      const parsed = parse(input.value);
      if ('error' in parsed) {
        input.addClass('is-invalid');
        input.setAttribute('aria-invalid', 'true');
        input.title = parsed.error;
        // Shown over the rows below, so a mistake does not make the row taller.
        if (!error) { error = activeDocument.body.createDiv({ cls: 'cp-cell-error' }); this.errors.add(error); }
        error.setText(parsed.error);
        const rect = input.getBoundingClientRect();
        error.setCssProps({ left: `${rect.left}px`, top: `${rect.bottom + 2}px` });
        return;
      }
      void apply(parsed.value);
    });
    return input;
  }

  // —— Task Notes and people ——

  private async promote(node: TaskNode): Promise<void> {
    const file = this.file;
    if (!file) return;
    const name = taskNoteName(node.title);
    const folder = file.parent && file.parent.path !== '/' ? file.parent.path : '';
    const path = normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
    // Link by name unless another note already answers to it.
    const resolved = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
    const link = !resolved || resolved.path === path ? name : path.replace(/\.md$/, '');
    const changed = await this.edit(node, text => promoteLine(text, this.today, link), `Promoted ${this.name(node)} to a Task Note.`);
    if (!changed) return;
    try {
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, '');
    } catch (error) { new Notice(error instanceof Error ? error.message : `Could not create ${path}.`); }
  }

  private async demote(node: TaskNode): Promise<void> {
    const file = this.file;
    if (!file) return;
    const { target } = demoteLine(node.text, this.today);
    const note = this.app.metadataCache.getFirstLinkpathDest(target, file.path);
    const changed = await this.edit(node, text => demoteLine(text, this.today).text, `Demoted ${this.name(node)} to text.`);
    if (!changed || !note) return;
    if ((await this.app.vault.read(note)).trim()) { new Notice(`${note.path} has text, so it was kept.`); return; }
    if (await confirmAction(this.app, 'Move the Task Note to trash?', `${note.path} is empty and nothing in this task links to it any more.`, 'Move to trash')) {
      await this.app.fileManager.trashFile(note);
    }
  }

  /** Rename a Task Note through Obsidian, so every link to it follows; Undo renames it back. */
  private async renameTaskNote(node: TaskNode, target: string, name: string): Promise<boolean> {
    const project = this.file;
    if (!project) return false;
    const note = this.app.metadataCache.getFirstLinkpathDest(target, project.path);
    const fail = async (message: string) => { new Notice(message); await this.reload(true); return false; };
    if (!note) return fail(`There is no note for ${target} yet, so there is nothing to rename. Open it to create it, or demote the task to text.`);
    if (name === note.basename) return false;
    const folder = note.parent && note.parent.path !== '/' ? `${note.parent.path}/` : '';
    const to = normalizePath(`${folder}${name}.${note.extension}`);
    const existing = this.app.vault.getAbstractFileByPath(to);
    if (existing && existing !== note) return fail(`${to} already exists.`);
    if (!await this.plugin.projectWriter.previewRename(project.path, note.path, to)) return fail('The Task Note was not renamed.');
    const from = note.path;
    const next = target.includes('/') ? `${target.slice(0, target.lastIndexOf('/') + 1)}${name}` : name;
    const restore = this.rekey(node, `[[${next}]]`);
    try {
      await this.moveTaskNote(note, to, target, next);
    } catch (error) {
      restore();
      return fail(error instanceof Error ? error.message : `Could not rename ${from}.`);
    }
    this.plugin.projectWriter.actionNotice(`Renamed the Task Note to “${name}”.`, async () => {
      const moved = this.app.vault.getAbstractFileByPath(to);
      if (!(moved instanceof TFile)) throw new Error(`${to} no longer exists.`);
      await this.moveTaskNote(moved, from, next, target);
    });
    return true;
  }

  /**
   * Move the note; Obsidian updates links as the user's settings say. When
   * this project still links to the old name afterwards, offer to update it.
   */
  private async moveTaskNote(note: TFile, to: string, oldTarget: string, newTarget: string): Promise<void> {
    await this.app.fileManager.renameFile(note, to);
    const project = this.file;
    if (!project) return;
    // Let Obsidian finish its own link updates before checking.
    await new Promise(resolve => window.setTimeout(resolve, 500));
    if (this.app.metadataCache.getFirstLinkpathDest(oldTarget, project.path)) return;
    const stale = (text: string) => {
      const line = parseTaskLine(text.replace(/\r$/, ''), this.today);
      return line && linkedTaskNote(splitTitle(line.title).name)?.target === oldTarget;
    };
    if (!(await this.plugin.projectWriter.read(project)).split('\n').some(stale)) return;
    const relink = (content: string) => content.split('\n').map(text => {
      if (!stale(text)) return text;
      const cr = text.endsWith('\r') ? '\r' : '';
      return retargetLine(text.replace(/\r$/, ''), this.today, newTarget) + cr;
    }).join('\n');
    const notice = new Notice(createFragment(fragment => {
      fragment.appendText(`Obsidian did not update the links to ${to}, so this project still links to [[${oldTarget}]]. `);
      fragment.createEl('a', { text: 'Update this project', href: '#', cls: 'cp-gantt-undo' });
    }), 0);
    notice.messageEl.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('.cp-gantt-undo')) return;
      event.preventDefault();
      notice.hide();
      void this.plugin.projectWriter.write(project.path, relink).then(changed => {
        if (changed) this.plugin.projectWriter.undoNotice(`Linked the tasks to [[${newTarget}]].`, project.path, content => content.split('\n').map(text => {
          const line = parseTaskLine(text.replace(/\r$/, ''), this.today);
          if (!line || linkedTaskNote(splitTitle(line.title).name)?.target !== newTarget) return text;
          return retargetLine(text.replace(/\r$/, ''), this.today, oldTarget) + (text.endsWith('\r') ? '\r' : '');
        }).join('\n'));
      }, error => new Notice(error instanceof Error ? error.message : 'Could not change the note.'));
    });
  }

  private personPath(name: string): string {
    if (name.includes('/')) return normalizePath(`${name}.md`);
    const folder = this.plugin.store.state.settings.ganttPeopleFolder.trim().replace(/^\/+|\/+$/g, '');
    return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
  }

  private async createPerson(name: string): Promise<void> {
    const path = this.personPath(name);
    try {
      const folder = path.split('/').slice(0, -1).join('/');
      if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, '');
      new Notice(`Created ${path}.`);
    } catch (error) { new Notice(error instanceof Error ? error.message : `Could not create ${path}.`); }
    this.render();
  }

  // —— Chart ——

  private chartRange(): { from: string; to: string } {
    const dates = [this.today];
    for (const node of this.project?.nodes ?? []) for (const date of [node.start, node.end, node.due, node.milestone, node.target]) if (date) dates.push(date);
    dates.sort();
    const first = addDays(dates[0], -7);
    return { from: addDays(first, -weekday(first)), to: addDays(dates[dates.length - 1], 21) };
  }

  private renderChart(scrollEl: HTMLElement, body: HTMLElement): void {
    const { from, to } = this.chartRange();
    const days = daysBetween(from, to) + 1;
    const dw = this.dayWidth = this.zoom === 'fit' ? fitDayWidth(days, body.clientWidth - this.labelWidth - 16) : dayWidthOf(this.zoom);
    const level = this.zoom === 'fit' ? levelFor(dw) : this.zoom;
    const x = (date: string) => daysBetween(from, date) * dw;
    const chart = scrollEl.createDiv({ cls: `cp-chart is-${level}` });
    chart.setCssProps({ '--cp-day': `${dw}px`, '--cp-label': `${this.labelWidth}px`, '--cp-days': String(days) });
    scrollEl.addEventListener('wheel', event => this.onWheel(event), { passive: false });

    const header = chart.createDiv({ cls: 'cp-chart-header' });
    const corner = header.createDiv({ cls: 'cp-chart-corner', text: 'Task' });
    this.renderResizer(corner, chart);
    const ticks = scale(from, to, level);
    const scaleEl = header.createDiv({ cls: 'cp-chart-scale' });
    const band = (row: HTMLElement, item: Band, cls: string) => {
      const el = row.createDiv({ cls, text: item.label });
      el.setCssProps({ left: `${item.offset * dw}px`, width: `${item.days * dw}px` });
      el.title = item.label;
      return el;
    };
    const majorRow = scaleEl.createDiv({ cls: 'cp-scale-major' });
    for (const item of ticks.major) band(majorRow, item, 'cp-scale-band is-major');
    const minorRow = scaleEl.createDiv({ cls: 'cp-scale-minor' });
    for (const item of ticks.minor) {
      const el = band(minorRow, item, 'cp-scale-band is-minor');
      el.toggleClass('is-weekend', !!item.weekend);
      el.toggleClass('is-today', item.start <= this.today && this.today < addDays(item.start, item.days));
      if (level === 'day') el.title = formatDate(item.start, this.today);
    }

    const rows = chart.createDiv({ cls: 'cp-chart-rows' });
    const nodes = this.visibleNodes();
    const line = (date: string, cls: string, title?: string, offset = dw / 2) => {
      const el = rows.createDiv({ cls: `cp-vline ${cls}` });
      el.setCssProps({ left: `calc(var(--cp-label) + ${x(date) + offset}px)` });
      if (title) el.title = title;
    };
    // Grid lines at each week, month, or quarter when days are too narrow to shade.
    if (level !== 'day') for (const item of ticks.minor) if (item.offset > 0) line(item.start, 'is-grid', undefined, 0);
    for (const item of ticks.major) if (item.offset > 0) line(item.start, 'is-grid is-major', undefined, 0);
    line(this.today, 'is-today', `Today, ${formatDate(this.today, this.today)}`);
    for (const node of nodes) if (node.milestone && !node.summary) line(node.milestone, 'is-milestone');
    for (const node of nodes) {
      const row = rows.createDiv({ cls: 'cp-chart-row' });
      row.toggleClass('is-summary', node.summary);
      row.toggleClass('is-plain', !node.isTask);
      const label = row.createDiv({ cls: 'cp-chart-label' });
      label.createSpan({ cls: 'cp-wbs', text: node.wbs });
      const indent = label.createDiv({ cls: 'cp-task-wrap' });
      indent.setCssProps({ '--cp-depth': String(node.depth) });
      this.caret(indent, node);
      this.renderName(indent, node, 'cp-chart-title');
      if (node.isTask) label.createSpan({ cls: 'cp-chart-pct', text: `${node.progress ?? 0}%` });
      this.renderLane(row.createDiv({ cls: 'cp-chart-lane' }), node, x);
    }
    this.renderUnscheduled(body, scrollEl, scaleEl, from);
  }

  /** The Task column's right edge: drag it, use the arrow keys, or double-click to reset. Kept in the view state. */
  private renderResizer(corner: HTMLElement, chart: HTMLElement): void {
    const grip = corner.createDiv({ cls: 'cp-label-resizer', attr: {
      role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Task column width',
      'aria-valuemin': String(MIN_LABEL), 'aria-valuemax': String(MAX_LABEL), 'aria-valuenow': String(this.labelWidth),
      title: 'Drag to change the width of the Task column. Double-click to reset.',
    } });
    const show = (width: number) => {
      const value = clampLabel(width);
      chart.setCssProps({ '--cp-label': `${value}px` });
      grip.setAttr('aria-valuenow', String(value));
      return value;
    };
    const commit = (width: number) => {
      this.labelWidth = show(width);
      this.saveState();
      if (this.zoom === 'fit') this.render();
    };
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      chart.addClass('is-resizing');
      const origin = event.clientX;
      const start = this.labelWidth;
      let width = start;
      const onMove = (next: PointerEvent) => { width = show(start + next.clientX - origin); };
      const finish = () => {
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', finish);
        grip.removeEventListener('pointercancel', finish);
        chart.removeClass('is-resizing');
        if (width !== start) commit(width);
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', finish);
      grip.addEventListener('pointercancel', finish);
    });
    grip.addEventListener('dblclick', () => commit(LABEL_WIDTH));
    grip.addEventListener('keydown', event => {
      const step = event.shiftKey ? 64 : 16;
      const next = event.key === 'ArrowLeft' ? this.labelWidth - step : event.key === 'ArrowRight' ? this.labelWidth + step
        : event.key === 'Home' ? LABEL_WIDTH : undefined;
      if (next === undefined) return;
      event.preventDefault();
      commit(next);
      this.rootEl?.querySelector<HTMLElement>('.cp-label-resizer')?.focus();
    });
  }

  private color(node: TaskNode): string | undefined {
    const first = node.assignees[0];
    const name = first && personName(first);
    return this.colorBy === 'assignee' && name ? `hsl(${hue(name)} 55% 48%)` : undefined;
  }

  private renderLane(lane: HTMLElement, node: TaskNode, x: (date: string) => number): void {
    const dw = this.dayWidth;
    const show = (date: string) => formatDate(date, this.today);
    if (node.summary) {
      if (node.start && node.end) {
        // A collapsed branch keeps its span, drawn as a full bar with its progress.
        const collapsed = this.collapsed.has(node.key);
        const bar = lane.createDiv({ cls: 'cp-summary-bar' });
        bar.toggleClass('is-collapsed', collapsed);
        bar.setCssProps({ left: `${x(node.start)}px`, width: `${Math.max(2, x(node.end) - x(node.start) + dw)}px` });
        bar.title = `${plainTitle(node.title)}: ${show(node.start)}–${show(node.end)}, ${node.progress ?? 0}%${collapsed ? ' (collapsed)' : ''}`;
        if (collapsed) {
          bar.createDiv({ cls: 'cp-bar-fill' }).setCssProps({ width: `${node.progress ?? 0}%` });
          lane.createDiv({ cls: 'cp-bar-text', text: plainTitle(node.title) }).setCssProps({ left: `${x(node.end) + dw + 4}px` });
        }
      }
      if (node.target) {
        const target = lane.createDiv({ cls: 'cp-target' });
        target.setCssProps({ left: `${x(node.target) + dw / 2}px` });
        target.toggleClass('is-late', !!node.late);
        target.title = node.late ? `Target ${show(node.target)}, but the tasks below end ${show(node.end!)}.` : `Target ${show(node.target)}`;
      }
      return;
    }
    if (node.start && node.end) {
      const start = node.start, end = node.end;
      const bar = lane.createDiv({ cls: 'cp-bar' });
      const color = this.color(node);
      if (color) bar.setCssProps({ '--cp-bar-color': color });
      const place = (s: number, e: number) => bar.setCssProps({ left: `${x(start) + s * dw}px`, width: `${Math.max(3, x(end) - x(start) + (e - s + 1) * dw)}px` });
      place(0, 0);
      bar.createDiv({ cls: 'cp-bar-fill' }).setCssProps({ width: `${node.progress ?? 0}%` });
      bar.title = `${plainTitle(node.title)}: ${show(start)}–${show(end)}, ${node.progress ?? 0}%. Drag to move, drag an end to change it.`;
      const text = lane.createDiv({ cls: 'cp-bar-text', text: plainTitle(node.title) });
      text.setCssProps({ left: `${x(end) + dw + 4}px` });
      const length = daysBetween(start, end);
      const commit = (s: number, e: number) => {
        if (!s && !e) return;
        void this.change(node, { schedule: { start: addDays(start, s), end: addDays(end, e) } },
          `${this.name(node)} now runs ${show(addDays(start, s))}–${show(addDays(end, e))}.`);
      };
      this.drag(bar, delta => place(delta, delta), delta => commit(delta, delta));
      const handle = (which: 'start' | 'end') => {
        const el = bar.createDiv({ cls: `cp-bar-handle is-${which}` });
        const clamp = (delta: number) => which === 'start' ? Math.min(delta, length) : Math.max(delta, -length);
        this.drag(el, delta => which === 'start' ? place(clamp(delta), 0) : place(0, clamp(delta)),
          delta => which === 'start' ? commit(clamp(delta), 0) : commit(0, clamp(delta)));
      };
      // Too narrow to grab an end: the whole bar moves.
      if ((length + 1) * dw >= 20) { handle('start'); handle('end'); }
      return;
    }
    if (node.due) {
      const due = node.due;
      if (due > this.today) {
        const dash = lane.createDiv({ cls: 'cp-due-line' });
        dash.setCssProps({ left: `${x(this.today) + dw / 2}px`, width: `${x(due) - x(this.today)}px` });
      }
      const marker = lane.createDiv({ cls: 'cp-due' });
      marker.toggleClass('is-overdue', due < this.today && (node.progress ?? 0) < 100);
      const color = this.color(node);
      if (color) marker.setCssProps({ '--cp-bar-color': color });
      marker.setCssProps({ left: `${x(due) + dw / 2}px` });
      marker.title = `${plainTitle(node.title)} is due ${show(due)}. Drag to change.`;
      this.drag(marker, delta => marker.setCssProps({ left: `${x(due) + delta * dw + dw / 2}px` }),
        delta => { if (delta) void this.change(node, { schedule: { due: addDays(due, delta) } }, `${this.name(node)} is due ${show(addDays(due, delta))}.`); });
      lane.createDiv({ cls: 'cp-bar-text', text: plainTitle(node.title) }).setCssProps({ left: `${x(due) + dw + 4}px` });
      return;
    }
    if (node.milestone) {
      const date = node.milestone;
      const diamond = lane.createDiv({ cls: 'cp-diamond' });
      diamond.toggleClass('is-done', (node.progress ?? 0) >= 100);
      diamond.setCssProps({ left: `${x(date) + dw / 2}px` });
      diamond.title = `◆ ${plainTitle(node.title)}: ${show(date)}. Drag to change.`;
      this.drag(diamond, delta => diamond.setCssProps({ left: `${x(date) + delta * dw + dw / 2}px` }),
        delta => { if (delta) void this.change(node, { milestone: addDays(date, delta) }, `Milestone ${this.name(node)} is on ${show(addDays(date, delta))}.`); });
      lane.createDiv({ cls: 'cp-bar-text', text: plainTitle(node.title) }).setCssProps({ left: `${x(date) + dw + 4}px` });
    }
  }

  /** Follow the pointer in whole days; a drop without movement is not a change. */
  private drag(el: HTMLElement, move: (delta: number) => void, drop: (delta: number) => void): void {
    el.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      el.setPointerCapture(event.pointerId);
      el.addClass('is-dragging');
      const origin = event.clientX;
      let delta = 0;
      const onMove = (next: PointerEvent) => {
        const value = Math.round((next.clientX - origin) / this.dayWidth);
        if (value !== delta) { delta = value; move(delta); }
      };
      const finish = (commit: boolean) => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
        el.removeClass('is-dragging');
        if (commit) drop(delta); else move(0);
      };
      const onUp = () => finish(true);
      const onCancel = () => finish(false);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onCancel);
    });
  }

  /** Tasks without dates, below the chart; dropping one on the timeline gives it that day. */
  private renderUnscheduled(body: HTMLElement, scrollEl: HTMLElement, scale: HTMLElement, from: string): void {
    const nodes = (this.project?.nodes ?? []).filter(node => isUnscheduled(node) && this.matches(node));
    const section = body.createDiv({ cls: 'cp-unscheduled' });
    section.createDiv({ cls: 'cp-unscheduled-title', text: nodes.length ? 'Unscheduled — drag a task onto the timeline to give it a date' : 'Every task has a date.' });
    const list = section.createDiv({ cls: 'cp-unscheduled-list' });
    for (const node of nodes) {
      const chip = list.createDiv({ cls: 'cp-unscheduled-chip', text: `${node.wbs} ${plainTitle(node.title)}` });
      chip.toggleClass('is-plain', !node.isTask);
      chip.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        chip.setPointerCapture(event.pointerId);
        const ghost = activeDocument.body.createDiv({ cls: 'cp-drag-ghost', text: plainTitle(node.title) });
        const place = (e: PointerEvent) => ghost.setCssProps({ left: `${e.clientX + 8}px`, top: `${e.clientY + 8}px` });
        place(event);
        const dayAt = (e: PointerEvent): string | undefined => {
          const area = scrollEl.getBoundingClientRect();
          const origin = scale.getBoundingClientRect().left;
          if (e.clientX < area.left + this.labelWidth || e.clientX > area.right || e.clientY < area.top || e.clientY > area.bottom) return undefined;
          return addDays(from, Math.floor((e.clientX - origin) / this.dayWidth));
        };
        const onMove = (e: PointerEvent) => { place(e); const day = dayAt(e); ghost.setText(day ? `${plainTitle(node.title)} → ${formatDate(day, this.today)}` : plainTitle(node.title)); };
        const onUp = (e: PointerEvent) => {
          chip.removeEventListener('pointermove', onMove);
          chip.removeEventListener('pointerup', onUp);
          ghost.remove();
          const day = dayAt(e);
          if (day) void this.change(node, { schedule: { start: day, end: day } }, `${this.name(node)} is scheduled on ${formatDate(day, this.today)}.`);
        };
        chip.addEventListener('pointermove', onMove);
        chip.addEventListener('pointerup', onUp);
      });
    }
  }

  private scrollToToday(body: HTMLElement): void {
    this.scrolledToToday = true;
    const { from } = this.chartRange();
    body.scrollLeft = Math.max(0, (daysBetween(from, this.today) - 7) * this.dayWidth);
  }
}
