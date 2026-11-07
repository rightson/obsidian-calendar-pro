import { MarkdownView, Modal, Notice, Plugin, TFile, requestUrl, type WorkspaceLeaf } from 'obsidian';
import moment from 'moment-timezone';
import { CalendarNoteView, CALENDAR_VIEW_TYPE } from './calendar-view';
import { AgendaView, AGENDA_VIEW_TYPE, AGENDA_HOVER_SOURCE } from './agenda-view';
import { unionRange } from './agenda-layout';
import { MonthsView, MONTHS_VIEW_TYPE } from './months-view';
import { calendarOpenModeForClick, ensureSidebarView, leafBelowFileExplorer, openCalendarLeaf, type CalendarOpenMode } from './calendar-open';
import { EventPropertiesController } from './event-properties';
import { ChangeHistoryModal, EventModal } from './modals';
import { EventNoteProblemsModal } from './problems-modal';
import { CalendarNoteSettingTab, validatePluginSettings } from './settings-tab';
import { AddSubscriptionModal } from './subscription-modal';
import { DEFAULT_SETTINGS } from './settings';
import { normalizeState } from './state';
import { CalendarStore, RecoveryConflict } from './store';
import { createObsidianStoreIO } from './vault-adapter';
import { migrateLegacyData } from './migrate';
import { EventNoteService, type ChooseNote } from './events';
import { SubscriptionService } from './subscriptions';
import { SourceSyncService } from './sync';
import { SettingsUpdateQueue, newSubscription, patchSubscription } from './subscription-settings';
import { historyForReview, type ChangeHistoryEntry } from './history';
import type { CalendarEvent, Interval, PluginSettings } from './types';
import type { CalendarRange } from './ical';
import { dateAt } from './date';
import { isEventNoteFrontmatter } from './event-properties-state';
import { GanttView, GANTT_VIEW_TYPE, ganttIcon } from './gantt-view';
import { ProjectIndex } from './project-index';
import { ProjectWriter } from './project-writer';
import { replaceLine } from './project-edit';
import { ensureBlockId } from './annotation';
import type { TaskEvent } from './tasks';

export default class CalendarNotePlugin extends Plugin {
  store!: CalendarStore;
  notes!: EventNoteService;
  sync!: SourceSyncService;
  subscriptions!: SubscriptionService;
  events: CalendarEvent[] = [];
  private range?: CalendarRange;
  /** Each open calendar surface's visible range; subscriptions expand their union. */
  private ranges = new Map<object, CalendarRange>();
  private scanTimer?: number;
  private scanning?: Promise<void>;
  private scanAgain = false;
  private moving?: Promise<void>;
  private moveAgain = false;
  private disposed = false;
  private ready = false;
  private lastDiagnostics = '';
  private restoreRenameFile?: () => void;
  private eventProperties?: EventPropertiesController;
  private settingTab?: CalendarNoteSettingTab;
  private settingsUpdates!: SettingsUpdateQueue;
  private problemsModal?: EventNoteProblemsModal;
  projects!: ProjectIndex;
  projectWriter!: ProjectWriter;
  private ganttActionViews = new WeakSet<MarkdownView>();
  private ganttActions = new Set<HTMLElement>();
  private projectsScanned = false;

  /** Imports settings from Calendar Pro or Calendar-Note, this plugin's earlier IDs, once. */
  private async migrateLegacyData(): Promise<string | null> {
    const pluginsDir = `${this.app.vault.configDir}/plugins`;
    const ownDir = this.manifest.dir ?? `${pluginsDir}/${this.manifest.id}`;
    try {
      const adapter = this.app.vault.adapter;
      const result = await migrateLegacyData({
        exists: path => adapter.exists(path),
        read: path => adapter.read(path),
        write: (path, data) => adapter.write(path, data),
        mkdir: path => adapter.mkdir(path),
      }, pluginsDir, ownDir);
      return result?.name ?? null;
    } catch (error) {
      console.error('Event Notes: could not import earlier settings', error);
      return null;
    }
  }

  async onload(): Promise<void> {
    const migrated = await this.migrateLegacyData();
    const state = normalizeState(await this.loadData(), DEFAULT_SETTINGS);
    this.store = new CalendarStore(createObsidianStoreIO(this.app, this), state);
    this.settingsUpdates = new SettingsUpdateQueue(() => this.store.state.settings, settings => this.persistSettings(settings));
    try { await this.store.recover(); }
    catch {
      this.store.recoveryConflict ??= new RecoveryConflict(['transaction journal']);
      new Notice('Event Notes: recovery needs attention. Open the calendar and choose Retry recovery.');
    }
    this.notes = new EventNoteService(this.app, this.store, () => this.store.state.settings);
    this.eventProperties = new EventPropertiesController(
      this.app,
      () => this.store.state.settings.eventPropertiesDefault,
      file => this.isEventNote(file),
    );
    this.eventProperties.start(this);
    this.sync = new SourceSyncService(this.store, this.notes);
    this.subscriptions = new SubscriptionService(this.store, this.sync, async (url, headers) => {
      const result = await requestUrl({ url, headers, method: 'GET', throw: false });
      return { status: result.status, text: result.text, headers: result.headers };
    });
    this.store.onChange = () => { this.updateEventsFromCache(); this.refreshViews(); this.scheduleMoves(); };
    this.registerView(CALENDAR_VIEW_TYPE, leaf => new CalendarNoteView(leaf, this));
    this.registerView(MONTHS_VIEW_TYPE, leaf => new MonthsView(leaf, this));
    this.registerView(AGENDA_VIEW_TYPE, leaf => new AgendaView(leaf, this));
    this.projectWriter = new ProjectWriter({
      app: this.app,
      settings: () => this.store.state.settings,
      updateSettings: change => this.updateSettings(change),
      written: path => { for (const view of this.getGanttViews()) if (view.file?.path === path) void view.reload(); },
    });
    this.projects = new ProjectIndex(this.app, () => this.today(), () => { for (const view of this.getViews()) view.refresh(); });
    this.registerView(GANTT_VIEW_TYPE, leaf => new GanttView(leaf, this));
    this.addCommand({ id: 'open-gantt', name: 'Open current note as Gantt', checkCallback: checking => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== 'md') return false;
      if (!checking) void this.openGantt(file, view?.leaf);
      return true;
    } });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem(item => item.setTitle('Open as Gantt').setIcon(ganttIcon()).onClick(() => void this.openGantt(file)));
    }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.addGanttActions()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.addGanttActions()));
    this.registerEvent(this.app.metadataCache.on('changed', (file, data, cache) => this.projects.update(file, data, cache)));
    this.registerEvent(this.app.metadataCache.on('deleted', file => this.projects.remove(file.path)));
    this.registerEvent(this.app.metadataCache.on('resolved', () => {
      if (!this.ready || this.projectsScanned) return;
      this.projectsScanned = true;
      void this.projects.scanAll();
    }));
    this.registerHoverLinkSource(AGENDA_HOVER_SOURCE, { display: 'Event Notes events sidebar', defaultMod: false });
    this.addRibbonIcon('calendar-days', 'Open Event Notes calendar', evt => void this.openCalendar(calendarOpenModeForClick(evt)));
    this.addRibbonIcon('calendar-clock', 'Open Event Notes events sidebar', () => void this.openAgenda());
    this.addCommand({ id: 'open-calendar', name: 'Open calendar in new tab', callback: () => void this.openCalendar('tab') });
    this.addCommand({ id: 'open-calendar-right', name: 'Open calendar in right split', callback: () => void this.openCalendar('right-split') });
    this.addCommand({ id: 'open-months', name: 'Open month calendar in sidebar', callback: () => void this.openMonths() });
    this.addCommand({ id: 'open-months-below-explorer', name: 'Move month calendar below the file explorer', callback: () => void this.openMonths('below-explorer') });
    this.addCommand({ id: 'open-events-sidebar', name: 'Open events sidebar', callback: () => void this.openAgenda() });
    this.addCommand({ id: 'new-event', name: 'New event', callback: () => void this.openCalendar().then(view => view.newEvent()) });
    this.addCommand({ id: 'remove-duplicate-event-title', name: 'Remove duplicate Event Note title', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!(file instanceof TFile) || file.extension !== 'md' || !this.isEventNote(file)) return false;
      if (checking) return true;
      void this.runAction(async () => {
        const removed = await this.notes.removeDuplicateTitle(file.path);
        new Notice(removed ? 'Removed the duplicate Event Note title.' : 'This Event Note has no duplicate title to remove.');
      });
      return true;
    } });
    this.addCommand({ id: 'refresh', name: 'Refresh calendars', callback: () => void this.refresh(true) });
    this.addCommand({ id: 'change-history', name: 'Show change history', callback: () => this.showHistory() });
    this.addCommand({ id: 'add-subscription', name: 'Add calendar subscription', callback: () => this.showAddSubscription() });
    this.addCommand({ id: 'retry-recovery', name: 'Retry pending recovery', callback: () => void this.retryRecovery() });
    this.addCommand({ id: 'review-event-note-problems', name: 'Review Event Note problems', callback: () => this.showProblems() });
    this.settingTab = new CalendarNoteSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    const changed = (file: TFile) => { if (file.extension === 'md') this.scheduleScan(); };
    this.registerEvent(this.app.vault.on('create', file => { if (file instanceof TFile) changed(file); }));
    this.registerEvent(this.app.vault.on('modify', file => { if (file instanceof TFile) changed(file); }));
    this.registerEvent(this.app.vault.on('delete', file => { if (file instanceof TFile) changed(file); }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      void this.projects.rename(file, oldPath);
      void this.runAction(async () => { await this.notes.handleRename(file, oldPath); this.scheduleScan(); });
    }));
    this.registerEvent(this.app.metadataCache.on('changed', file => { if (file.extension === 'md') this.scheduleScan(); }));
    // The Vault rename event fires before FileManager finishes rewriting
    // wikilinks. Complete our tracked Daily entry only after that public
    // renameFile Promise resolves, so both writers never race on offsets.
    const manager = this.app.fileManager;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Keep the exact method for restoration; invoke it with manager as this.
    const originalRename = manager.renameFile;
    const wrappedRename: typeof originalRename = async (file, newPath) => {
      const result = await originalRename.call(manager, file, newPath);
      if (!this.disposed && file instanceof TFile && file.extension === 'md') {
        await this.runAction(async () => { await this.notes.finalizePendingRenames(file.path); this.scheduleScan(); });
      }
      return result;
    };
    manager.renameFile = wrappedRename;
    this.restoreRenameFile = () => { if (manager.renameFile === wrappedRename) manager.renameFile = originalRename; };
    this.registerDomEvent(window, 'focus', () => void this.refresh(false));
    this.registerDomEvent(window, 'online', () => void this.refresh(false));
    this.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      this.ready = true;
      this.addGanttActions();
      void this.projects.scanAll();
      void this.runAction(async () => { await this.notes.finalizePendingRenames(); }).then(() => this.rescan());
      this.scheduleMoves();
      this.subscriptions.start();
      if (this.store.state.settings.monthsOnStartup) void ensureSidebarView(this.app.workspace, MONTHS_VIEW_TYPE);
      if (this.range) void this.refresh(false);
      if (this.store.recoveryConflict) this.showRecovery();
      if (migrated) new Notice(`Event Notes imported your ${migrated} settings. Disable and remove ${migrated} so the two plugins don't edit the same notes.`, 0);
    });
  }

  onunload(): void {
    this.disposed = true;
    this.eventProperties?.dispose();
    this.restoreRenameFile?.();
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.subscriptions?.dispose();
    for (const action of this.ganttActions) action.remove();
  }

  private getViews(): CalendarNoteView[] {
    return this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)
      .map(leaf => leaf.view).filter((view): view is CalendarNoteView => view instanceof CalendarNoteView);
  }
  private getGanttViews(): GanttView[] {
    return this.app.workspace.getLeavesOfType(GANTT_VIEW_TYPE)
      .map(leaf => leaf.view).filter((view): view is GanttView => view instanceof GanttView);
  }
  private getMonthsViews(): MonthsView[] {
    return this.app.workspace.getLeavesOfType(MONTHS_VIEW_TYPE)
      .map(leaf => leaf.view).filter((view): view is MonthsView => view instanceof MonthsView);
  }
  private getAgendaViews(): AgendaView[] {
    return this.app.workspace.getLeavesOfType(AGENDA_VIEW_TYPE)
      .map(leaf => leaf.view).filter((view): view is AgendaView => view instanceof AgendaView);
  }
  private refreshViews(): void {
    for (const view of this.getViews()) view.refresh();
    for (const view of this.getMonthsViews()) view.refresh();
    for (const view of this.getAgendaViews()) view.refresh();
    this.settingTab?.refreshSubscriptionStatus();
  }
  getVisibleRange(): CalendarRange | undefined { return this.range; }
  private updateEventsFromCache(): void {
    const local = this.events.filter(event => event.sourceId === 'local');
    const imports = this.subscriptions?.getEvents(this.range);
    if (imports) {
      const noteTitles = new Map(this.events.filter(event => event.sourceId !== 'local' && this.store.state.noteLinks[event.id])
        .map(event => [event.id, event.title]));
      this.events = [...local, ...imports.map(event => ({ ...event, title: noteTitles.get(event.id) ?? event.title }))];
    }
  }
  eventById(id: string): CalendarEvent | undefined { return this.events.find(event => event.id === id); }

  private isEventNote(file: TFile): boolean {
    return isEventNoteFrontmatter(this.app.metadataCache.getFileCache(file)?.frontmatter);
  }

  async openCalendar(mode: CalendarOpenMode = 'tab'): Promise<CalendarNoteView> {
    const leaf = await openCalendarLeaf(this.app.workspace, CALENDAR_VIEW_TYPE, mode);
    return leaf.view as CalendarNoteView;
  }

  /**
   * Reveal the month calendar where it is, adding it to the right sidebar the
   * first time; 'below-explorer' moves it under the file explorer instead.
   */
  async openMonths(place: 'sidebar' | 'below-explorer' = 'sidebar'): Promise<void> {
    const workspace = this.app.workspace;
    const existing = workspace.getLeavesOfType(MONTHS_VIEW_TYPE);
    if (place === 'below-explorer') existing.forEach(leaf => leaf.detach());
    const reuse = place === 'sidebar' ? existing[0] : undefined;
    const leaf = reuse ?? (place === 'below-explorer' ? leafBelowFileExplorer(workspace) : workspace.getRightLeaf(false));
    if (!leaf) return;
    if (!reuse) await leaf.setViewState({ type: MONTHS_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }

  /** Open the events sidebar in the right sidebar, or reveal the one already there. */
  async openAgenda(): Promise<void> {
    await this.app.workspace.ensureSideLeaf(AGENDA_VIEW_TYPE, 'right', { active: true, reveal: true });
  }

  /**
   * `owner` (a calendar or the events sidebar) now shows `range`. Feeds are
   * expanded over every open surface's range at once, so one surface moving
   * does not drop the events another still shows.
   */
  async onVisibleRange(range: CalendarRange, owner: object = this): Promise<void> {
    this.ranges.set(owner, range);
    const next = unionRange(this.ranges.values()) ?? range;
    const unchanged = this.range?.start === next.start && this.range?.end === next.end;
    this.range = next;
    if (!this.ready || this.store.recoveryConflict) return;
    if (unchanged) { this.updateEventsFromCache(); this.refreshViews(); return; }
    await this.runAction(async () => {
      await this.subscriptions.setRange(next);
      await this.subscriptions.refresh(next);
      this.updateEventsFromCache(); this.refreshViews();
    });
  }

  /** `owner` closed; the remaining surfaces' ranges apply from the next refresh. */
  releaseVisibleRange(owner: object): void {
    if (!this.ranges.delete(owner)) return;
    this.range = unionRange(this.ranges.values()) ?? this.range;
  }

  async refresh(force = false): Promise<void> {
    if (!this.ready || this.store.recoveryConflict) return;
    await this.runAction(async () => {
      await this.rescan();
      if (this.range) await this.subscriptions.refresh(this.range, { force });
      this.updateEventsFromCache(); this.refreshViews();
    });
  }

  /**
   * Move Event Notes whose date changed once the commit that recorded the move
   * has returned; renameFile calls back into the note service's queue, so it
   * cannot run inside that queue.
   */
  private scheduleMoves(): void {
    if (!this.ready || this.disposed || this.store.recoveryConflict) return;
    if (!Object.values(this.store.state.noteLinks).some(link => link.moveTo && !link.pendingRename)) return;
    if (this.moving) { this.moveAgain = true; return; }
    this.moving = (async () => {
      await Promise.resolve();
      do {
        this.moveAgain = false;
        try {
          const failures = await this.notes.settleMoves();
          for (const failure of failures) new Notice(failure);
        } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not move Event Notes.'); }
      } while (this.moveAgain && !this.disposed);
    })().finally(() => { this.moving = undefined; });
  }

  private scheduleScan(): void {
    if (!this.ready || this.disposed || this.store.recoveryConflict) return;
    if (this.scanTimer) window.clearTimeout(this.scanTimer);
    this.scanTimer = window.setTimeout(() => { this.scanTimer = undefined; void this.rescan(); }, 300);
  }

  /** Resolves once a scan that started after this call has finished. */
  private rescan(): Promise<void> {
    if (!this.ready || this.disposed || this.store.recoveryConflict) return Promise.resolve();
    if (this.scanning) { this.scanAgain = true; return this.scanning; }
    this.scanning = (async () => {
      try {
        do {
          this.scanAgain = false;
          const scanned = await this.notes.scanEvents();
          this.events = scanned;
          this.updateEventsFromCache();
          this.refreshViews();
          const diagnostic = this.notes.diagnostics.join('\n');
          if (diagnostic && diagnostic !== this.lastDiagnostics && !this.problemsModal) this.problemNotice();
          this.lastDiagnostics = diagnostic;
          this.problemsModal?.update();
          this.settingTab?.refreshDiagnostics();
        } while (this.scanAgain && !this.disposed);
      } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not scan Event Notes.'); }
    })().finally(() => { this.scanning = undefined; });
    return this.scanning;
  }

  private problemNotice(): void {
    const count = this.notes.problems.length;
    const notice = new Notice(createFragment(fragment => {
      fragment.appendText(`Found ${count} Event Note ${count === 1 ? 'problem' : 'problems'}. `);
      fragment.createEl('a', { text: 'Review and fix', href: '#' });
    }), 10000);
    notice.messageEl.addEventListener('click', event => { event.preventDefault(); notice.hide(); this.showProblems(); });
  }

  get problemCount(): number { return this.notes.problems.length; }

  showProblems(): void {
    if (this.problemsModal) return;
    const changed = async (action: () => Promise<void>) => {
      if (this.store.recoveryConflict) throw new Error('Resolve pending recovery before changing notes.');
      try { await action(); }
      finally { await this.rescan(); }
    };
    const modal = new EventNoteProblemsModal(this.app, {
      problems: () => this.notes.problems,
      inspect: paths => this.notes.inspectNotes(paths),
      open: async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`${path} no longer exists.`);
        await this.app.workspace.getLeaf(true).openFile(file);
      },
      resolveDuplicate: (keep, others, seen) => changed(() => this.notes.resolveDuplicate(keep, others, seen)),
      release: (path, action, seen) => changed(() => this.notes.releaseNote(path, action, seen)),
      restore: (path, seen) => changed(() => this.notes.restoreNote(path, seen)),
      reconnect: (path, eventId, seen) => changed(() => this.notes.reconnectNote(path, eventId, seen)),
      refreshCalendars: () => this.refresh(true),
      scan: () => this.rescan(),
      calendarName: id => {
        if (id === 'local') return 'Local';
        const current = this.store.state.settings.sources.find(source => source.id === id)?.name;
        if (current) return current;
        // A removed subscription is gone from settings; History still knows its name.
        const removed = this.store.state.history.find(entry => entry.sourceId === id)?.sourceName;
        return removed ? `${removed} (removed)` : 'a removed calendar';
      },
      timeZone: () => this.store.state.settings.timeZone,
      closed: () => { this.problemsModal = undefined; },
    });
    this.problemsModal = modal;
    modal.open();
  }

  async runAction<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      if (this.store.recoveryConflict) { this.showRecovery(); throw new Error('Resolve pending recovery before editing notes.'); }
      return await action();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'The action failed.');
      return undefined;
    }
  }

  async createLocal(title: string, interval: Interval, properties?: Record<string, string>): Promise<void> {
    if (this.store.recoveryConflict) throw new Error('Resolve pending recovery before creating events.');
    const event = await this.notes.createLocal({ title, ...interval, properties });
    this.events = [...this.events.filter(item => item.id !== event.id), event];
    this.refreshViews();
    this.scheduleScan();
  }
  async reschedule(event: CalendarEvent, interval: Interval): Promise<void> {
    if (this.store.recoveryConflict) throw new Error('Resolve pending recovery before editing events.');
    const updated = await this.notes.reschedule(event, interval);
    this.events = this.events.map(item => item.id === updated.id ? updated : item);
    this.refreshViews();
    this.scheduleScan();
  }

  /** Bind the event to the note at `path`, opening it unless `open` is false. */
  async linkEventNote(event: CalendarEvent, path: string, choose?: ChooseNote, open = true): Promise<string | undefined> {
    return this.runAction(async () => {
      const linked = await this.notes.linkNote(event, path, choose);
      const file = this.app.vault.getAbstractFileByPath(linked);
      if (open && file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`Linked the event to ${linked}.`);
      this.scheduleScan();
      return linked;
    });
  }

  today(): string { return dateAt(new Date(), this.store.state.settings.timeZone).format('YYYY-MM-DD'); }

  /** Show a note as a Gantt in `leaf`, or in the active leaf. */
  async openGantt(file: TFile, leaf?: WorkspaceLeaf): Promise<void> {
    const target = leaf ?? this.app.workspace.getLeaf(false);
    await target.setViewState({ type: GANTT_VIEW_TYPE, state: { file: file.path, mode: 'table' }, active: true });
  }

  /** A title bar button on every Markdown view. */
  private addGanttActions(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || this.ganttActionViews.has(view)) continue;
      this.ganttActionViews.add(view);
      this.ganttActions.add(view.addAction(ganttIcon(), 'Open as Gantt', () => { if (view.file) void this.openGantt(view.file, view.leaf); }));
    }
  }

  /** Open a note with its line in view and the cursor on it. */
  async openNoteAt(path: string, line: number, leaf?: WorkspaceLeaf): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${path} no longer exists.`);
    const target = leaf ?? this.app.workspace.getLeaf('tab');
    await target.openFile(file, { active: true, eState: { line } });
    await this.app.workspace.revealLeaf(target);
    const view = target.view;
    if (view instanceof MarkdownView) {
      const position = { line, ch: 0 };
      view.editor.setCursor(position);
      view.editor.scrollIntoView({ from: position, to: position }, true);
    }
  }

  /**
   * Schedule a Project task at a time on `day`: the usual new-event dialog,
   * then an Event Note whose `task` property links the task line's block.
   */
  scheduleTask(task: TaskEvent, day: string): void {
    const settings = this.store.state.settings;
    const start = moment.tz(`${day}T09:00:00`, 'YYYY-MM-DDTHH:mm:ss', true, settings.timeZone).toISOString();
    const end = dateAt(start, settings.timeZone).add(settings.defaultDurationMinutes, 'minutes').toISOString();
    new EventModal(this.app, settings, async value => {
      const id = await this.taskBlockId(task);
      const file = this.app.vault.getAbstractFileByPath(task.path);
      if (!(file instanceof TFile)) throw new Error(`${task.path} no longer exists.`);
      await this.createLocal(value.title, value.interval, { task: `[[${this.app.metadataCache.fileToLinktext(file, '')}#^${id}]]` });
    }, undefined, { start, end, allDay: false, title: task.title }).open();
  }

  private async taskBlockId(task: TaskEvent): Promise<string> {
    if (task.blockId) return task.blockId;
    const fresh = Math.random().toString(36).slice(2, 8);
    let id = '';
    const changed = await this.projectWriter.write(task.path, content => replaceLine(content, task.line, task.text, text => {
      const made = ensureBlockId(text, this.today(), () => fresh);
      id = made.id;
      return made.text;
    }));
    if (!id || (!changed && id === fresh)) throw new Error('The task line was not changed, so no event was created.');
    return id;
  }

  updateSettings(change: (settings: PluginSettings) => void, validate?: (settings: PluginSettings) => void): Promise<void> {
    return this.settingsUpdates.update(change, validate);
  }

  /** Settings changed outside the settings tab; redraw it so it doesn't show stale subscriptions. */
  private async updateSettingsFromView(change: (settings: PluginSettings) => void): Promise<void> {
    await this.updateSettings(change, next => { validatePluginSettings(this.app, next); });
    this.settingTab?.update();
  }

  showAddSubscription(): void {
    new AddSubscriptionModal(this.app, () => this.store.state.settings.sources, async input => {
      const source = newSubscription(crypto.randomUUID(), input);
      await this.updateSettingsFromView(next => { next.sources.push(source); });
      new Notice(`Event Notes: subscribed to “${source.name}”. Its events appear after the first refresh.`);
    }, () => this.openSettings()).open();
  }

  async setSubscriptionEnabled(id: string, enabled: boolean): Promise<void> {
    try { await this.updateSettingsFromView(next => { patchSubscription(next, id, { enabled }); }); }
    catch (error) { new Notice(error instanceof Error ? error.message : 'Could not update the subscription.'); }
  }

  /** Obsidian's settings window, on this plugin's tab. The API is undocumented, so it is feature-checked. */
  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => unknown } }).setting;
    if (typeof setting?.open !== 'function' || typeof setting.openTabById !== 'function') {
      new Notice('Open Settings → Event Notes to manage subscriptions.');
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  saveSettings(settings: PluginSettings): Promise<void> {
    return this.updateSettings(next => { Object.assign(next, settings); });
  }

  private async persistSettings(settings: PluginSettings): Promise<void> {
    const previousPropertiesDefault = this.store.state.settings.eventPropertiesDefault;
    await this.store.commit([], state => { state.settings = settings; });
    if (settings.eventPropertiesDefault !== previousPropertiesDefault) this.eventProperties?.settingsChanged();
    for (const view of this.getViews()) view.settingsChanged();
    for (const view of this.getMonthsViews()) view.refresh();
    for (const view of this.getAgendaViews()) view.settingsChanged();
    this.subscriptions.dispose();
    this.subscriptions = new SubscriptionService(this.store, this.sync, async (url, headers) => {
      const result = await requestUrl({ url, headers, method: 'GET', throw: false });
      return { status: result.status, text: result.text, headers: result.headers };
    });
    if (this.range) await this.subscriptions.setRange(this.range);
    if (this.ready) this.subscriptions.start();
    if (this.ready && this.range) await this.subscriptions.refresh(this.range);
    this.scheduleScan();
  }

  showHistory(): void {
    new ChangeHistoryModal(this.app, () => this.store.state.history, () => this.store.state.settings, {
      openExisting: async entry => {
        if (!entry.notePath) return;
        const path = this.store.state.noteLinks[entry.eventId]?.eventPath ?? entry.notePath;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('The linked Event Note is missing.');
        await this.app.workspace.getLeaf(true).openFile(file);
      },
      review: async entry => { await this.sync.markReviewed(entry.id); },
      retry: async entry => this.sync.retry(entry.id),
      useLatest: async entry => this.sync.useLatestSourceTimes(entry.eventId),
      canRetry: entry => this.canRetry(entry),
      canUseLatest: entry => !!this.store.state.overrides[entry.eventId] &&
        !!this.store.state.sourceCaches[entry.sourceId]?.accepted[entry.eventId],
    }).open();
  }
  get reviewCount(): number { return historyForReview(this.store.state.history).length; }
  private canRetry(entry: ChangeHistoryEntry): boolean {
    const cache = this.store.state.sourceCaches[entry.sourceId];
    const pending = cache?.pendingIncoming[entry.eventId];
    return entry.status === 'needs_attention' && !this.store.state.overrides[entry.eventId] && !!pending && pending.historyId === entry.id &&
      cache.accepted[entry.eventId]?.revision === pending.baselineRevision;
  }

  private showRecovery(): void {
    const conflict = this.store.recoveryConflict;
    if (!conflict) return;
    const modal = new Modal(this.app);
    modal.titleEl.setText('Event Notes: recovery needs attention');
    modal.contentEl.createEl('p', { text: 'These files changed during a pending transaction. Review them, then retry recovery. Calendar edits are paused until recovery succeeds.' });
    const list = modal.contentEl.createEl('ul');
    for (const path of conflict.paths) list.createEl('li', { text: path });
    const retry = modal.contentEl.createEl('button', { text: 'Retry recovery', cls: 'mod-cta' });
    retry.addEventListener('click', () => void this.retryRecovery().then(() => { if (!this.store.recoveryConflict) modal.close(); }));
    modal.open();
  }
  async retryRecovery(): Promise<void> {
    // Recovery can restore settings from disk, which is the one way subscriptions change outside the tab.
    const sourceIds = () => this.store.state.settings.sources.map(source => source.id).join();
    const before = sourceIds();
    try {
      await this.store.recover();
      this.store.recoveryConflict = null;
      new Notice('Event Notes: recovery completed.');
      await this.rescan();
      if (this.range) await this.refresh(false);
    } catch { this.showRecovery(); }
    finally { if (sourceIds() !== before) this.settingTab?.update(); }
  }
}
