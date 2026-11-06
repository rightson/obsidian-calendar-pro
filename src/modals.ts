import { Component, MarkdownRenderer, Modal, Notice, Setting, SuggestModal, TFile, ToggleComponent, normalizePath, setIcon, type App } from 'obsidian';
import moment from 'moment-timezone';
import type { CalendarEvent, Interval, PluginSettings } from './types';
import type { ChangeHistoryEntry } from './history';
import { historyForReview } from './history';
import { intervalFromFields } from './calendar-input';
import { dateAt } from './date';
import { noteBody } from './notes';

function fieldDate(value: string, allDay: boolean, zone: string): string {
  return dateAt(value, zone).format(allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DDTHH:mm');
}

export type NoteOpenPlace = 'left' | 'tab' | 'right';

export interface EventNoteControls {
  path?: string;
  change: () => void;
  /** Name of the calendar the event came from, shown with its original details. */
  calendar?: string;
  /** Notes the event could be bound to; several of them show as a dropdown. */
  candidates?: () => Promise<string[]>;
  /** Bind the event to another note; resolves with the note now holding it, or undefined on failure. */
  bind?: (path: string) => Promise<string | undefined>;
  open?: (place: NoteOpenPlace) => void;
}

export class EventModal extends Modal {
  private titleValue: string;
  private startValue: string;
  private endValue: string;
  private allDay: boolean;
  private errorEl!: HTMLElement;
  private previewOwner = new Component();
  private previewChild?: Component;
  private previewToken = 0;

  constructor(app: Modal['app'], private settings: PluginSettings,
    private submit: (value: { title: string; interval: Interval }) => Promise<void>, private event?: CalendarEvent,
    initial?: Interval & { title?: string }, private note?: EventNoteControls) {
    super(app);
    this.titleValue = event?.title ?? initial?.title ?? '';
    this.allDay = event?.allDay ?? initial?.allDay ?? false;
    const start = event?.start ?? initial?.start ?? moment().toISOString();
    const end = event?.end ?? initial?.end ?? dateAt(start, settings.timeZone).add(settings.defaultDurationMinutes, 'minutes').toISOString();
    this.startValue = fieldDate(start, this.allDay, settings.timeZone);
    this.endValue = fieldDate(end, this.allDay, settings.timeZone);
  }

  onOpen(): void {
    this.modalEl.addClass('cn-event-modal');
    this.titleEl.setText('Event details');
    const root = this.contentEl;
    root.empty();
    this.renderTitle(root);
    if (this.event) this.renderOriginal(root, this.event);
    const times = root.createDiv({ cls: 'cn-time-row' });
    const makeInput = (label: string, value: string, onChange: (value: string) => void) => {
      const field = times.createEl('label', { cls: 'cn-modal-field cn-time-field' });
      const labelEl = field.createSpan({ text: label });
      const input = field.createEl('input', { type: this.allDay ? 'date' : 'datetime-local' });
      input.value = value;
      input.addEventListener('change', () => onChange(input.value));
      return { input, labelEl };
    };
    const endLabel = (allDay: boolean) => allDay ? 'End (exclusive)' : 'End';
    const start = makeInput('Start', this.startValue, value => { this.startValue = value; });
    const end = makeInput(endLabel(this.allDay), this.endValue, value => { this.endValue = value; });
    end.labelEl.setAttr('title', 'For all-day events, the day after the last day');
    const allDayField = times.createDiv({ cls: 'cn-modal-field cn-all-day-field' });
    allDayField.createSpan({ text: 'All day' });
    const toggle = new ToggleComponent(allDayField).setValue(this.allDay);
    toggle.toggleEl.querySelector('input')?.setAttr('aria-label', 'All day');
    toggle.onChange(value => {
      this.startValue = this.startValue.slice(0, 10);
      this.endValue = this.endValue.slice(0, 10);
      if (value && this.endValue <= this.startValue) {
        this.endValue = moment.tz(this.startValue, 'YYYY-MM-DD', true, this.settings.timeZone).add(1, 'day').format('YYYY-MM-DD');
      } else if (!value) {
        this.startValue += 'T09:00';
        this.endValue += 'T10:00';
      }
      this.allDay = value;
      start.input.type = value ? 'date' : 'datetime-local';
      end.input.type = value ? 'date' : 'datetime-local';
      start.input.value = this.startValue;
      end.input.value = this.endValue;
      end.labelEl.setText(endLabel(value));
    });
    if (this.note) this.renderNote(root, this.note);
    this.errorEl = root.createDiv({ cls: 'cn-validation', attr: { role: 'alert' } });
    const actions = root.createDiv({ cls: 'cn-modal-actions' });
    actions.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    save.addEventListener('click', () => { void (async () => {
      try {
        const title = this.titleValue.trim();
        if (!title) throw new Error('Enter an event title.');
        const interval = intervalFromFields(this.startValue, this.endValue, this.allDay, this.settings.timeZone);
        save.disabled = true;
        await this.submit({ title, interval });
        this.close();
      } catch (error) {
        this.errorEl.setText(error instanceof Error ? error.message : 'Could not save the event.');
        save.disabled = false;
      }
    })(); });
  }

  onClose(): void {
    this.previewToken++;
    this.previewOwner.unload();
    this.contentEl.empty();
  }

  /**
   * The title. An existing event's title comes from its Event Note, so it shows read-only and opens
   * that note in a new tab when clicked; the small Edit link below it binds the event to another note.
   */
  private renderTitle(root: HTMLElement): void {
    const field = root.createDiv({ cls: 'cn-modal-field cn-title-field' });
    const open = this.note?.open;
    if (this.event) {
      field.createSpan({ text: 'Title', cls: 'cn-field-label' });
      if (open) {
        const link = field.createEl('button', { cls: 'cn-event-title cn-event-title-link', text: this.titleValue,
          attr: { type: 'button', title: 'Open the Event Note in a new tab' } });
        link.addEventListener('click', () => { this.close(); open('tab'); });
      } else {
        field.createDiv({ cls: 'cn-event-title cn-event-title-static', text: this.titleValue });
      }
    } else {
      const label = field.createEl('label', { text: 'Title' });
      const input = label.createEl('input', { type: 'text', cls: 'cn-event-title', attr: { placeholder: 'Event title' } });
      input.value = this.titleValue;
      input.addEventListener('input', () => { this.titleValue = input.value; });
      input.focus();
    }
    const note = this.note;
    if (!note) return;
    const edit = field.createEl('a', { text: 'Edit', cls: 'cn-note-edit',
      attr: { href: '#', role: 'button', title: 'Bind the event to any note, or a new one' } });
    edit.addEventListener('click', event => { event.preventDefault(); this.close(); note.change(); });
  }

  /** The Event Note: which note holds the event, what it says, and where to open it. */
  private renderNote(root: HTMLElement, note: EventNoteControls): void {
    this.previewOwner.load();
    let path = note.path;
    const section = root.createDiv({ cls: 'cn-event-note' });
    const heading = new Setting(section).setName('Event Note').setDesc(path ?? 'Not created yet');
    const preview = section.createDiv({ cls: 'cn-note-preview' });
    void this.showPreview(preview, path);
    if (note.candidates && note.bind) {
      const bind = note.bind;
      void note.candidates().then(paths => {
        if (paths.length < 2 || !heading.settingEl.isConnected) return;
        heading.setDesc('');
        const select = heading.descEl.createEl('select', { cls: 'dropdown cn-note-choice', attr: { 'aria-label': 'Note bound to this event' } });
        if (!path) select.createEl('option', { text: 'Not created yet', value: '' });
        for (const candidate of paths) select.createEl('option', { text: candidate, value: candidate });
        select.value = path ?? '';
        select.addEventListener('change', () => { void (async () => {
          if (!select.value) return;
          select.disabled = true;
          const linked = await bind(select.value);
          select.disabled = false;
          if (linked) path = linked;
          select.value = path ?? '';
          await this.showPreview(preview, path);
        })(); });
      });
    }
    const open = note.open;
    if (!open) return;
    const row = section.createDiv({ cls: 'cn-open-note', attr: { role: 'group', 'aria-label': 'Open Event Note' } });
    const button = (place: NoteOpenPlace, icon: string, text: string, tooltip: string) => {
      const element = row.createEl('button', { cls: `cn-open-${place}${place === 'tab' ? ' mod-cta' : ''}`, attr: { 'aria-label': tooltip } });
      const iconEl = createSpan({ cls: 'cn-open-icon' });
      setIcon(iconEl, icon);
      // Each side's icon sits on the side the note will open.
      element.append(...place === 'right' ? [createSpan({ text }), iconEl] : [iconEl, createSpan({ text })]);
      element.addEventListener('click', () => { this.close(); open(place); });
    };
    button('left', 'panel-left-open', 'Left', 'Open the Event Note in a pane left of the calendar');
    button('tab', 'maximize-2', 'Open in new tab', 'Open the Event Note in a new tab beside the calendar');
    button('right', 'panel-right-open', 'Right', 'Open the Event Note in a pane right of the calendar');
  }

  /** Render the note's text read-only; a later call replaces an earlier one still loading. */
  private async showPreview(el: HTMLElement, path?: string): Promise<void> {
    const token = ++this.previewToken;
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    const content = file instanceof TFile ? await this.app.vault.cachedRead(file) : undefined;
    if (token !== this.previewToken) return;
    if (this.previewChild) this.previewOwner.removeChild(this.previewChild);
    el.empty();
    const body = content === undefined ? undefined : noteBody(content);
    el.toggleClass('is-empty', !body);
    if (!body) {
      el.setText(content === undefined ? 'The note is created when you open it.' : 'This note has no text yet.');
      return;
    }
    this.previewChild = this.previewOwner.addChild(new Component());
    await MarkdownRenderer.render(this.app, body, el, path!, this.previewChild);
  }

  /** The event as its calendar describes it, which the Event Note may have diverged from. */
  private renderOriginal(root: HTMLElement, event: CalendarEvent): void {
    const rows: [string, string][] = [];
    if (this.note?.calendar) rows.push(['Calendar', this.note.calendar]);
    if (event.location?.trim()) rows.push(['Location', event.location.trim()]);
    if (event.description?.trim()) rows.push(['Description', event.description.trim()]);
    if (!rows.length) return;
    const list = root.createEl('dl', { cls: 'cn-event-original' });
    for (const [label, value] of rows) {
      list.createEl('dt', { text: label });
      list.createEl('dd', { text: value });
    }
  }
}

export interface HistoryActions {
  openExisting(entry: ChangeHistoryEntry): Promise<void>;
  review(entry: ChangeHistoryEntry): Promise<void>;
  retry(entry: ChangeHistoryEntry): Promise<boolean>;
  useLatest(entry: ChangeHistoryEntry): Promise<boolean>;
  canRetry(entry: ChangeHistoryEntry): boolean;
  canUseLatest(entry: ChangeHistoryEntry): boolean;
}

export class ChangeHistoryModal extends Modal {
  private filter: 'all' | 'review' = 'review';
  constructor(app: Modal['app'], private getEntries: () => ChangeHistoryEntry[],
    private getSettings: () => PluginSettings, private actions: HistoryActions) { super(app); }

  onOpen(): void { this.render(); }

  private render(): void {
    this.titleEl.setText('Calendar change history');
    this.contentEl.empty();
    const tabs = this.contentEl.createDiv({ cls: 'cn-history-tabs' });
    for (const [key, label] of [['all', 'All'], ['review', 'Needs review']] as const) {
      const button = tabs.createEl('button', { text: label, cls: key === this.filter ? 'is-active' : '' });
      button.setAttribute('aria-pressed', String(key === this.filter));
      button.addEventListener('click', () => { this.filter = key; this.render(); });
    }
    const all = [...this.getEntries()].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    const entries = this.filter === 'review' ? historyForReview(all) : all;
    if (!entries.length) this.contentEl.createEl('p', { text: 'No changes in this view.' });
    for (const entry of entries) this.renderEntry(entry);
  }

  private renderEntry(entry: ChangeHistoryEntry): void {
    const zone = this.getSettings().timeZone;
    const card = this.contentEl.createDiv({ cls: 'cn-history-entry' });
    card.createEl('strong', { text: `${entry.title} · ${entry.sourceName}` });
    card.createEl('div', { text: `${entry.status.replaceAll('_', ' ')} · ${dateAt(entry.detectedAt, zone).format('lll')}`, cls: 'cn-muted' });
    const range = (value?: { start: string; end: string; allDay: boolean }) => value
      ? `${dateAt(value.start, zone).format(value.allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')} → ${dateAt(value.end, zone).format(value.allDay ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')}` : '—';
    card.createEl('div', { text: `Source: ${range(entry.beforeSource)} → ${range(entry.afterSource)}` });
    card.createEl('div', { text: `Effective: ${range(entry.beforeEffective)} → ${range(entry.afterEffective)}` });
    if (entry.notePath) card.createEl('div', { text: `Event Note: ${entry.notePath}` });
    if (entry.beforeDailyPath || entry.afterDailyPath) card.createEl('div', {
      text: `Daily Note: ${entry.beforeDailyPath ?? '—'} → ${entry.afterDailyPath ?? '—'}` });
    if (entry.error) card.createEl('div', { text: entry.error, cls: 'cn-validation' });
    const actions = card.createDiv({ cls: 'cn-history-actions' });
    const action = (label: string, run: () => Promise<void>) => {
      const button = actions.createEl('button', { text: label });
      button.addEventListener('click', () => { void (async () => {
        button.disabled = true;
        try { await run(); this.render(); }
        catch (error) { new Notice(error instanceof Error ? error.message : 'Action failed.'); button.disabled = false; }
      })(); });
      return button;
    };
    if (entry.notePath) action('Open note', () => this.actions.openExisting(entry));
    if (!entry.reviewedAt) action('Mark reviewed', () => this.actions.review(entry));
    if (entry.status === 'needs_attention' && this.actions.canRetry(entry)) action('Retry', async () => {
      if (!await this.actions.retry(entry)) new Notice('The source revision changed. Refresh before retrying.');
    });
    if (entry.status === 'local_override' && this.actions.canUseLatest(entry)) action('Use latest source times', async () => {
      if (!await this.actions.useLatest(entry)) new Notice('The latest source times are unavailable.');
    });
  }
}

/** Picks which of several Event Notes left by a removed calendar keeps the clicked event. */
export class NoteChoiceModal extends SuggestModal<string> {
  private chosen?: string;
  private resolve?: (path: string | undefined) => void;

  constructor(app: App, private readonly paths: string[]) {
    super(app);
    this.setPlaceholder('Several notes match this event. Choose the one to keep');
  }

  choose(): Promise<string | undefined> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  getSuggestions(query: string): string[] {
    const text = query.toLowerCase();
    return this.paths.filter(path => path.toLowerCase().includes(text));
  }

  renderSuggestion(path: string, el: HTMLElement): void { el.setText(path); }

  onChooseSuggestion(path: string): void { this.chosen = path; }

  onClose(): void {
    super.onClose();
    // Obsidian closes the modal before it reports the chosen suggestion.
    window.setTimeout(() => this.resolve?.(this.chosen), 0);
  }
}

export interface NoteTarget { path: string; create: boolean }

/** Picks an existing Markdown note, or a new path, to become an event's Event Note. */
export class LinkNoteModal extends SuggestModal<NoteTarget> {
  private chosen?: string;
  private resolve?: (path: string | undefined) => void;

  constructor(app: App, private readonly current?: string) {
    super(app);
    this.setPlaceholder('Choose a note for this event, or type a new note path');
    this.emptyStateText = 'No matching note.';
  }

  choose(): Promise<string | undefined> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  getSuggestions(query: string): NoteTarget[] {
    const text = query.trim().toLowerCase();
    const paths = this.app.vault.getMarkdownFiles().map(file => file.path).filter(path => path !== this.current);
    const matches = paths.filter(path => path.toLowerCase().includes(text))
      .sort((a, b) => Number(!basename(a).toLowerCase().startsWith(text)) - Number(!basename(b).toLowerCase().startsWith(text)) || a.localeCompare(b))
      .map(path => ({ path, create: false }));
    if (!text) return matches;
    const typed = normalizePath(/\.md$/i.test(query.trim()) ? query.trim() : `${query.trim()}.md`);
    const exists = this.app.vault.getAbstractFileByPath(typed) !== null;
    return exists ? matches : [...matches, { path: typed, create: true }];
  }

  renderSuggestion(target: NoteTarget, el: HTMLElement): void {
    el.setText(target.create ? `Create ${target.path}` : target.path);
  }

  onChooseSuggestion(target: NoteTarget): void { this.chosen = target.path; }

  onClose(): void {
    super.onClose();
    // Obsidian closes the modal before it reports the chosen suggestion.
    window.setTimeout(() => this.resolve?.(this.chosen), 0);
  }
}

const basename = (path: string) => path.split('/').pop() ?? path;
