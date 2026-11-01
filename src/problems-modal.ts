import { Modal, type App } from 'obsidian';
import { dateAt } from './date';
import type { NoteDisposition } from './events';
import { PROBLEM_LABELS, PROBLEM_ORDER, calendarVisibility, describeProblem, lineDiff, problemKey, recommendKeep, sortProblems, summarizeNote,
  uniqueLines, uniqueProperties, userContent, type EventNoteProblem, type NoteFacts, type ProblemKind } from './note-problems';

type Seen = Record<string, string | null>;

export interface ProblemActions {
  problems(): EventNoteProblem[];
  inspect(paths: string[]): Promise<NoteFacts[]>;
  open(path: string): Promise<void>;
  resolveDuplicate(keep: string, others: { path: string; action: NoteDisposition }[], seen: Seen): Promise<void>;
  release(path: string, action: 'detach' | 'trash', seen: Seen): Promise<void>;
  restore(path: string, seen: Seen): Promise<void>;
  reconnect(path: string, eventId: string, seen: Seen): Promise<void>;
  /** Fetch the calendars again, then scan the notes. */
  refreshCalendars(): Promise<void>;
  scan(): Promise<void>;
  calendarName(sourceId: string): string;
  timeZone(): string;
  closed(): void;
}

const DISPOSITIONS: [NoteDisposition, string][] = [
  ['trash', 'Move to trash'],
  ['merge', 'Add its text to the kept note, then move to trash'],
  ['detach', 'Keep as an ordinary note'],
];

const MANAGED_LABELS: Record<string, string> = {
  event_id: 'event_id', start: 'Start', end: 'End', all_day: 'All day', source: 'Calendar', ical_uid: 'ical_uid', recurrence_id: 'recurrence_id',
};

/** Lists every Event Note problem with the notes side by side, so each can be judged and fixed in place. */
export class EventNoteProblemsModal extends Modal {
  private filter: ProblemKind | 'all' = 'all';
  private keepChoice = new Map<string, string>();
  private dispositions = new Map<string, NoteDisposition>();
  private shown = '';
  private renderToken = 0;
  private busy = false;

  constructor(app: App, private readonly actions: ProblemActions) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('cn-problems-modal');
    this.titleEl.setText('Event Note problems');
    void this.render();
  }

  onClose(): void {
    this.renderToken++;
    this.contentEl.empty();
    this.actions.closed();
  }

  /** Called after every scan; redraws only when the problems changed. */
  update(): void {
    if (this.busy) return;
    if (this.signature() !== this.shown) void this.render();
  }

  private signature(): string { return this.actions.problems().map(problem => `${problemKey(problem)}\n${problem.message}`).join('\n\n'); }

  private async render(): Promise<void> {
    const token = ++this.renderToken;
    const problems = sortProblems(this.actions.problems());
    const signature = this.signature();
    const facts = new Map<string, NoteFacts[]>();
    for (const problem of problems) facts.set(problemKey(problem), await this.actions.inspect(problem.paths));
    if (token !== this.renderToken) return;
    this.shown = signature;
    const scroll = this.contentEl.scrollTop;
    const root = this.contentEl;
    root.empty();
    this.renderHeader(root, problems, facts);
    if (!problems.length) {
      root.createDiv({ cls: 'cn-problems-empty', text: 'No problems. Every Event Note can be read and belongs to exactly one event.' });
      return;
    }
    const visible = problems.filter(problem => this.filter === 'all' || problem.kind === this.filter);
    if (!visible.length) this.filter = 'all';
    for (const problem of visible.length ? visible : problems) this.renderProblem(root, problem, facts.get(problemKey(problem))!);
    root.scrollTop = scroll;
  }

  private renderHeader(root: HTMLElement, problems: EventNoteProblem[], facts: Map<string, NoteFacts[]>): void {
    const header = root.createDiv({ cls: 'cn-problems-header' });
    const notes = new Set(problems.flatMap(problem => problem.paths)).size;
    header.createDiv({ cls: 'cn-problems-summary', text: problems.length
      ? `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} in ${notes} ${notes === 1 ? 'note' : 'notes'}. Each card shows the notes involved and what each choice will do.`
      : 'Event Notes were scanned.' });
    const scan = header.createEl('button', { text: 'Scan again' });
    scan.addEventListener('click', () => void this.run(scan, () => this.actions.scan()));
    if (!problems.length) return;
    const counts = new Map<ProblemKind, number>();
    for (const problem of problems) counts.set(problem.kind, (counts.get(problem.kind) ?? 0) + 1);
    const chips = root.createDiv({ cls: 'cn-problems-filters', attr: { role: 'group', 'aria-label': 'Show problems' } });
    const chip = (key: ProblemKind | 'all', label: string, count: number) => {
      const button = chips.createEl('button', { text: `${label} (${count})`, cls: key === this.filter ? 'is-active' : '' });
      button.setAttribute('aria-pressed', String(key === this.filter));
      button.addEventListener('click', () => { this.filter = key; void this.render(); });
    };
    chip('all', 'All', problems.length);
    for (const kind of PROBLEM_ORDER) if (counts.get(kind)) chip(kind, PROBLEM_LABELS[kind], counts.get(kind)!);
    // Copies whose text is already in the note that keeps their event can go without review.
    const exact = problems.filter(problem => problem.kind === 'duplicate').flatMap(problem => {
      const notes = facts.get(problemKey(problem))!;
      const keep = this.keepFor(problem, notes);
      const kept = notes.find(note => note.path === keep)?.content;
      if (kept == null) return [];
      return notes.filter(note => note.path !== keep && isExactCopy(problem, kept, note.content))
        .map(note => ({ problem, keep, path: note.path, notes }));
    });
    if (exact.length) {
      const bar = root.createDiv({ cls: 'cn-problems-bulk' });
      bar.createSpan({ text: `${exact.length} ${exact.length === 1 ? 'note is an exact copy' : 'notes are exact copies'} of the note that keeps the event. Nothing is lost by removing ${exact.length === 1 ? 'it' : 'them'}.` });
      const button = bar.createEl('button', { text: `Move ${exact.length} exact ${exact.length === 1 ? 'copy' : 'copies'} to trash`, cls: 'mod-cta' });
      button.addEventListener('click', () => void this.run(button, async () => {
        const groups = new Map<EventNoteProblem, typeof exact>();
        for (const item of exact) groups.set(item.problem, [...groups.get(item.problem) ?? [], item]);
        for (const [, items] of groups) {
          const seen = this.seen(items[0].notes);
          await this.actions.resolveDuplicate(items[0].keep, items.map(item => ({ path: item.path, action: 'trash' as const })), seen);
        }
      }));
    }
  }

  private renderProblem(root: HTMLElement, problem: EventNoteProblem, notes: NoteFacts[]): void {
    const card = root.createDiv({ cls: `cn-problem cn-problem-${problem.kind}` });
    const { title, explanation } = describeProblem(problem, id => this.actions.calendarName(id));
    const heading = card.createDiv({ cls: 'cn-problem-heading' });
    heading.createSpan({ cls: 'cn-problem-tag', text: PROBLEM_LABELS[problem.kind] });
    heading.createEl('strong', { text: title });
    card.createEl('p', { cls: 'cn-problem-explanation', text: explanation });
    this.renderImpact(card, problem, notes);
    if (problem.kind === 'duplicate') this.renderDuplicate(card, problem, notes);
    else this.renderSingle(card, problem, notes[0]);
    card.createDiv({ cls: 'cn-problem-error cn-validation', attr: { role: 'alert' } });
  }

  /** Which event this is, whether the calendar shows it, and which notes link to the notes involved. */
  private renderImpact(card: HTMLElement, problem: EventNoteProblem, notes: NoteFacts[]): void {
    const box = card.createDiv({ cls: 'cn-problem-impact' });
    const row = (label: string) => {
      const element = box.createDiv({ cls: 'cn-problem-impact-row' });
      element.createSpan({ cls: 'cn-problem-impact-label', text: label });
      return element.createDiv({ cls: 'cn-problem-impact-value' });
    };
    const main = problem.kind === 'duplicate' ? notes.find(note => note.path === this.keepFor(problem, notes)) : notes[0];
    const event = main?.event ?? notes.find(note => note.event)?.event;
    const eventRow = row('Event');
    if (event) {
      eventRow.createEl('strong', { text: event.title });
      const when = this.when(event.start, event.end, event.allDay);
      if (when) eventRow.appendText(` · ${when}`);
      eventRow.appendText(` · ${event.sourceId ? `Calendar “${this.actions.calendarName(event.sourceId)}”` : 'Local event'}`);
    } else {
      eventRow.setText(problem.kind === 'error' ? 'See the reason below.' : 'The note has no readable event properties.');
    }
    row('Calendar').setText(calendarVisibility(problem));
    const references = notes.flatMap(note => note.references.map(reference => ({ ...reference, target: note.path })))
      .filter((reference, index, all) => all.findIndex(other => other.path === reference.path && other.target === reference.target && other.line === reference.line) === index);
    const linked = row('Linked from');
    if (!references.length) {
      linked.setText('No other note links to this note.');
      return;
    }
    const list = linked.createEl('ul', { cls: 'cn-problem-references' });
    for (const reference of references) {
      const item = list.createEl('li');
      const link = item.createEl('a', { text: reference.path, href: '#', attr: { title: 'Open this note in a new tab' } });
      link.addEventListener('click', click => { click.preventDefault(); void this.openNote(reference.path); });
      item.appendText(reference.kind === 'daily' ? ' — Daily Note entry ' : ' — links to it');
      if (reference.line) item.createEl('code', { text: reference.line });
      if (notes.length > 1) item.appendText(` → ${reference.target}`);
    }
    if (problem.kind !== 'duplicate') {
      box.createDiv({ cls: 'cn-muted', text: `If you move the note to trash, ${references.length === 1 ? 'this link points' : 'these links point'} to a missing note. If you keep it as an ordinary note, ${references.length === 1 ? 'it keeps' : 'they keep'} working.` });
    }
  }

  private when(start?: string, end?: string, allDay = false): string {
    const zone = this.actions.timeZone();
    const from = start ? dateAt(start, zone) : undefined;
    if (!from?.isValid()) return '';
    if (allDay) return `${from.format('ddd YYYY-MM-DD')} (all day)`;
    const to = end ? dateAt(end, zone) : undefined;
    if (!to?.isValid()) return from.format('ddd YYYY-MM-DD HH:mm');
    return `${from.format('ddd YYYY-MM-DD HH:mm')}–${to.format(to.isSame(from, 'day') ? 'HH:mm' : 'YYYY-MM-DD HH:mm')}`;
  }

  /** Editing happens in the note itself; the next scan updates this list. */
  private async openNote(path: string): Promise<void> {
    this.close();
    await this.actions.open(path);
  }

  private keepFor(problem: EventNoteProblem, notes: NoteFacts[]): string {
    const key = problemKey(problem);
    const chosen = this.keepChoice.get(key);
    return problem.holder ?? (chosen && problem.paths.includes(chosen) ? chosen : recommendKeep(notes).path);
  }

  private dispositionFor(problem: EventNoteProblem, path: string, kept: string | null, other: string | null): NoteDisposition {
    const chosen = this.dispositions.get(`${problemKey(problem)}\n${path}`);
    if (chosen) return chosen;
    // Removing an exact copy loses nothing; a note with its own text stays until the user decides.
    return isExactCopy(problem, kept, other) ? 'trash' : 'detach';
  }

  private renderDuplicate(card: HTMLElement, problem: EventNoteProblem, notes: NoteFacts[]): void {
    const key = problemKey(problem);
    const keep = this.keepFor(problem, notes);
    const recommended = recommendKeep(notes, problem.holder);
    const kept = notes.find(note => note.path === keep)!;
    const grid = card.createDiv({ cls: 'cn-problem-compare' });
    for (const note of notes) {
      const isKept = note.path === keep;
      const column = grid.createDiv({ cls: `cn-problem-note${isKept ? ' is-kept' : ''}` });
      const choice = column.createDiv({ cls: 'cn-problem-choice' });
      if (problem.holder) {
        choice.createSpan({ cls: 'cn-problem-role', text: isKept ? 'Keeps the event' : 'Copy' });
      } else {
        const label = choice.createEl('label', { cls: 'cn-problem-role' });
        const radio = label.createEl('input', { type: 'radio', attr: { name: `keep-${key}` } });
        radio.checked = isKept;
        label.appendText(isKept ? ' Keeps the event' : ' Keep this one');
        radio.addEventListener('change', () => { if (radio.checked) { this.keepChoice.set(key, note.path); void this.render(); } });
      }
      const badges: [string, string][] = [];
      if (note.path === recommended.path) badges.push(['Recommended', recommended.reason]);
      if (note.linked) badges.push(['Linked by calendar', 'Calendar Pro links the event to this note.']);
      if (note.listed) badges.push(['In Daily Note', 'The event’s Daily Note entry links to this note.']);
      this.renderNote(column, note, badges, isKept ? undefined : kept.content);
      if (!isKept) {
        const row = column.createDiv({ cls: 'cn-problem-then' });
        row.createSpan({ text: 'Then:' });
        const select = row.createEl('select', { cls: 'dropdown', attr: { 'aria-label': `What happens to ${note.path}` } });
        for (const [value, label] of DISPOSITIONS) select.createEl('option', { value, text: label });
        select.value = this.dispositionFor(problem, note.path, kept.content, note.content);
        select.addEventListener('change', () => { this.dispositions.set(`${key}\n${note.path}`, select.value as NoteDisposition); void this.render(); });
      }
    }
    const others = notes.filter(note => note.path !== keep);
    const plan = others.map(note => ({ path: note.path, action: this.dispositionFor(problem, note.path, kept.content, note.content) }));
    const outcome = card.createEl('ul', { cls: 'cn-problem-outcome' });
    outcome.createEl('li', { text: `${keep} keeps the event${plan.some(item => item.action === 'merge') ? ' and gains the merged text under “Merged from …” headings' : ''}.` });
    for (const item of plan) {
      const note = notes.find(other => other.path === item.path)!;
      const lines = note.content !== null && kept.content !== null ? uniqueLines(kept.content, note.content).length : 0;
      const properties = note.content !== null && kept.content !== null ? uniqueProperties(kept.content, note.content) : [];
      const losses = [lines ? `${lines} highlighted ${lines === 1 ? 'line' : 'lines'}` : '', properties.length ? `the ${properties.join(', ')} ${properties.length === 1 ? 'property' : 'properties'}` : '']
        .filter(Boolean).join(' and ');
      // The tracked Daily entry is moved to the kept note; any other link is left pointing at this one.
      const repointed = !problem.holder && note.linked && !kept.linked;
      const stale = note.references.filter(reference => !(repointed && reference.kind === 'daily')).length;
      const broken = item.action !== 'detach' && stale ? `; ${stale} ${stale === 1 ? 'note that links' : 'notes that link'} to it would point to a missing note` : '';
      const text = item.action === 'detach' ? `${item.path} stays in the Vault as an ordinary note; only its event properties are removed.`
        : item.action === 'merge' ? `${item.path}: its text is added to the kept note, then it is moved to trash${properties.length ? ` (its ${properties.join(', ')} ${properties.length === 1 ? 'property is' : 'properties are'} not copied)` : ''}.`
          : `${item.path} is moved to trash${losses ? ` — ${losses} would be lost from the kept note` : ''}.`;
      outcome.createEl('li', { text: broken ? `${text.slice(0, -1)}${broken}.` : text,
        cls: (item.action === 'trash' && losses) || (item.action === 'merge' && properties.length) || broken ? 'cn-problem-warning' : '' });
    }
    if (!problem.holder && !kept.linked && others.some(note => note.linked)) {
      outcome.createEl('li', { text: `The event’s Daily Note entry is changed to link to ${keep}.` });
    }
    const actions = card.createDiv({ cls: 'cn-history-actions' });
    const apply = actions.createEl('button', { text: problem.holder ? 'Remove the copies' : `Keep ${basename(keep)} and fix`, cls: 'mod-cta' });
    apply.addEventListener('click', () => void this.run(apply, () => this.actions.resolveDuplicate(keep, plan, this.seen(notes)), card));
  }

  private renderSingle(card: HTMLElement, problem: EventNoteProblem, note: NoteFacts): void {
    const column = card.createDiv({ cls: 'cn-problem-note is-single' });
    // The explanation already covers these; other kinds have a specific reason worth showing.
    if (problem.kind !== 'unlisted' && problem.kind !== 'orphan') {
      const reason = problem.message.startsWith(`${note.path}: `) ? problem.message.slice(note.path.length + 2) : problem.message;
      column.createDiv({ cls: 'cn-problem-reason', text: reason });
    }
    const summary = this.renderNote(column, note, note.linked ? [['Linked by calendar', 'Calendar Pro links an event to this note.']] : []);
    const seen = this.seen([note]);
    const actions = card.createDiv({ cls: 'cn-history-actions' });
    const button = (label: string, run: () => Promise<void>, cta = false) => {
      const element = actions.createEl('button', { text: label, cls: cta ? 'mod-cta' : '' });
      element.addEventListener('click', () => void this.run(element, run, card));
      return element;
    };
    const exists = note.content !== null;
    if (exists) button('Open note to edit', () => this.openNote(note.path));
    if (problem.kind === 'unlisted') button('Refresh calendars', () => this.actions.refreshCalendars());
    for (const candidate of problem.candidates ?? []) {
      button(`Belongs to “${this.actions.calendarName(candidate.sourceId)}”`, () => this.actions.reconnect(note.path, candidate.id, seen), true);
    }
    const restorable = problem.lastValid && (problem.kind === 'missing-id' || problem.kind === 'invalid') && !summary?.yamlError;
    if (restorable) {
      const event = problem.lastValid!;
      const zone = this.actions.timeZone();
      const when = `${dateAt(event.start, zone).format(event.allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')} → ${dateAt(event.end, zone).format(event.allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')}`;
      column.createDiv({ cls: 'cn-muted', text: `Last valid version: ${when}${event.allDay ? ' (all day)' : ''}, event_id ${event.id}.` });
      button('Restore last valid properties', () => this.actions.restore(note.path, seen), true);
    }
    if (exists && problem.kind !== 'error') {
      button('Keep as ordinary note', () => this.actions.release(note.path, 'detach', seen));
      this.confirmButton(actions, 'Move to trash', () => this.actions.release(note.path, 'trash', seen), card);
    }
    if (problem.kind === 'error') button('Scan again', () => this.actions.scan());
  }

  /** Path, badges, properties and text of one note; lines missing from `kept` are highlighted. */
  private renderNote(parent: HTMLElement, note: NoteFacts, badges: [string, string][], kept?: string | null): ReturnType<typeof summarizeNote> | undefined {
    const head = parent.createDiv({ cls: 'cn-problem-path' });
    const link = head.createEl('a', { text: note.path, href: '#', attr: { title: 'Open this note in a new tab' } });
    link.addEventListener('click', event => { event.preventDefault(); void this.openNote(note.path); });
    if (note.mtime) head.createDiv({ cls: 'cn-muted', text: `Modified ${dateAt(new Date(note.mtime).toISOString(), this.actions.timeZone()).format('YYYY-MM-DD HH:mm')}` });
    if (badges.length) {
      const row = parent.createDiv({ cls: 'cn-problem-badges' });
      for (const [label, title] of badges) row.createSpan({ cls: 'cn-problem-badge', text: label, attr: { title } });
    }
    if (note.content === null) { parent.createDiv({ cls: 'cn-muted', text: 'This note no longer exists.' }); return undefined; }
    const summary = summarizeNote(note.content);
    const keptSummary = kept ? summarizeNote(kept) : undefined;
    if (summary.yamlError) parent.createDiv({ cls: 'cn-validation', text: `YAML error: ${summary.yamlError}` });
    if (summary.properties.length) {
      const list = parent.createEl('dl', { cls: 'cn-problem-properties' });
      const keptValues = new Map(keptSummary?.properties ?? []);
      const ordered = [...summary.properties].sort(([a], [b]) => Number(!(a in MANAGED_LABELS)) - Number(!(b in MANAGED_LABELS)));
      for (const [key, value] of ordered) {
        const differs = keptSummary && keptValues.get(key) !== value;
        list.createEl('dt', { text: MANAGED_LABELS[key] ?? key, cls: differs ? 'is-different' : '' });
        list.createEl('dd', { text: this.propertyValue(key, value), cls: differs ? 'is-different' : '', attr: { title: value } });
      }
    }
    const body = summary.body.replace(/^\s+|\s+$/g, '');
    const unique = kept ? new Set(uniqueLines(kept, note.content)) : new Set<string>();
    if (kept) {
      const count = uniqueLines(kept, note.content).length;
      parent.createDiv({ cls: count ? 'cn-problem-diffnote is-different' : 'cn-problem-diffnote', text: count
        ? `${count} ${count === 1 ? 'line is' : 'lines are'} only in this note (highlighted).`
        : userContent(kept) === userContent(note.content) ? 'Same text and properties as the kept note.' : 'Its text is already in the kept note; highlighted properties differ.' });
    }
    const preview = parent.createEl('pre', { cls: 'cn-problem-body' });
    if (!body) preview.createSpan({ cls: 'cn-muted', text: '(no text)' });
    for (const line of body.split(/\r?\n/)) {
      preview.createSpan({ text: `${line}\n`, cls: unique.has(line) && line.trim() ? 'is-unique' : '' });
    }
    if (kept && unique.size) {
      const details = parent.createEl('details', { cls: 'cn-problem-diff' });
      details.createEl('summary', { text: 'Compare line by line with the kept note' });
      const diff = details.createEl('pre');
      for (const line of lineDiff(userContent(kept), userContent(note.content))) {
        diff.createSpan({ text: `${line.type === 'added' ? '+ ' : line.type === 'removed' ? '− ' : '  '}${line.text}\n`, cls: `is-${line.type}` });
      }
    }
    return summary;
  }

  private propertyValue(key: string, value: string): string {
    if (key === 'source') return this.actions.calendarName(value);
    if ((key === 'start' || key === 'end') && /^\d{4}-\d\d-\d\dT/.test(value)) {
      const time = dateAt(value, this.actions.timeZone());
      if (time.isValid()) return `${time.format('ddd YYYY-MM-DD HH:mm')}`;
    }
    return value;
  }

  private seen(notes: NoteFacts[]): Seen {
    return Object.fromEntries(notes.map(note => [note.path, note.content]));
  }

  /** A destructive action asks once more on the same button before it runs. */
  private confirmButton(parent: HTMLElement, label: string, run: () => Promise<void>, card: HTMLElement): void {
    const button = parent.createEl('button', { text: label, cls: 'mod-warning' });
    let armed = false;
    let timer: number | undefined;
    button.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        button.setText('Click again to move to trash');
        timer = window.setTimeout(() => { armed = false; button.setText(label); }, 4000);
        return;
      }
      window.clearTimeout(timer);
      void this.run(button, run, card);
    });
  }

  private async run(button: HTMLButtonElement, action: () => Promise<void>, card?: HTMLElement): Promise<void> {
    const buttons = [...(card ?? this.contentEl).querySelectorAll('button, select, input')] as (HTMLButtonElement | HTMLSelectElement | HTMLInputElement)[];
    const error = card?.querySelector<HTMLElement>('.cn-problem-error');
    for (const element of buttons) element.disabled = true;
    button.addClass('is-loading');
    this.busy = true;
    try {
      await action();
      this.busy = false;
      await this.render();
    } catch (failure) {
      this.busy = false;
      for (const element of buttons) element.disabled = false;
      button.removeClass('is-loading');
      const message = failure instanceof Error ? failure.message : 'The action failed.';
      if (error) error.setText(message);
      else this.contentEl.createDiv({ cls: 'cn-validation', text: message });
    }
  }
}

/**
 * Removing an exact copy loses nothing. A reconnected note's copies differ
 * from it only in their old event identity; other duplicates must also agree
 * on times, which the user may want to compare.
 */
function isExactCopy(problem: EventNoteProblem, kept: string | null | undefined, other: string | null): boolean {
  if (kept == null || other === null) return false;
  return problem.holder ? userContent(kept) === userContent(other) : kept === other;
}

const basename = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/i, '');
