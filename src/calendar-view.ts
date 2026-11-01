import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import { Calendar, type EventClickArg, type EventDropArg, type EventInput } from '@fullcalendar/core';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import multiMonthPlugin from '@fullcalendar/multimonth';
import interactionPlugin, { type DateClickArg, type EventResizeDoneArg } from '@fullcalendar/interaction';
import momentTimezonePlugin from '@fullcalendar/moment-timezone';
import moment from 'moment-timezone';
import { dateAt, firstWeekday, weekInfo } from './date';
import { resolveWeekRules } from './settings';
import type { CalendarEvent, Interval, PluginSettings } from './types';
import type CalendarNotePlugin from './main';
import { EventActions } from './event-actions';
import { miniMonthColumns, visibleMonthCount } from './calendar-layout';
import { editMenuTitle, eventsAt, type PointerSpan } from './calendar-menu';
import { mainDateClick, miniDateClick, type NotePlacement } from './calendar-click';
import { sidebarWidthForContainer, resizeSidebarWithKeyboard, togglePanel, type CalendarPanel } from './sidebar-layout';
import { subscriptionFailureMessage } from './subscription-settings';
import { holidayDays, showsEvent, type HolidayDay } from './holidays';

export const CALENDAR_VIEW_TYPE = 'calendar-pro-calendar';
export const CALENDAR_VIEWS = [
  ['timeGridWeek', 'Week'], ['timeGridDay', 'Day'], ['dayGridMonth', 'Month'],
  ['multiMonthYear', 'Year'], ['customDays', 'Custom days'], ['listWeek', 'List'],
] as const;

const isoDay = (date: Date, zone: string): string => dateAt(date, zone).format('YYYY-MM-DD');

export class CalendarNoteView extends ItemView {
  private calendar?: Calendar;
  private miniEl?: HTMLElement;
  private shellEl?: HTMLElement;
  private sidebarEl?: HTMLElement;
  private separatorEl?: HTMLElement;
  private sidebarRestore?: HTMLButtonElement;
  private mainRestore?: HTMLButtonElement;
  private mainCollapse?: HTMLButtonElement;
  private workdaysToggle?: HTMLButtonElement;
  private shellResizeObserver?: ResizeObserver;
  private stopSidebarDrag?: () => void;
  private miniNavTitle?: HTMLElement;
  private periodEl?: HTMLElement;
  private viewWeekEl?: HTMLButtonElement;
  private historyEl?: HTMLButtonElement;
  private problemsEl?: HTMLButtonElement;
  private subscriptionFailureEl?: HTMLElement;
  private listDatesEl?: HTMLElement;
  private selectedDay?: string;
  private miniMonth?: string;
  private lastDragAt = 0;
  private dateButtonObserver?: MutationObserver;
  private miniResizeObserver?: ResizeObserver;
  private miniResizeFrame?: number;
  private layoutResizeFrame?: number;
  private sidebarPersistTimer?: number;
  private pendingSidebarWidth?: number;
  private viewType = 'timeGridWeek';
  private holidays = new Map<string, HolidayDay>();

  private readonly actions: EventActions;

  constructor(leaf: WorkspaceLeaf, public readonly plugin: CalendarNotePlugin) {
    super(leaf);
    this.actions = new EventActions(plugin, () => this.leaf);
  }
  getViewType(): string { return CALENDAR_VIEW_TYPE; }
  getDisplayText(): string { return 'Calendar Pro'; }
  getIcon(): string { return 'calendar-days'; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('calendar-pro-view');
    const shell = root.createDiv({ cls: 'cn-shell' });
    this.shellEl = shell;
    this.sidebarRestore = shell.createEl('button', { cls: 'cn-sidebar-restore', attr: {
      type: 'button', 'aria-label': 'Show calendar sidebar', title: 'Show calendar sidebar', 'aria-expanded': 'false',
    } });
    setIcon(this.sidebarRestore, 'panel-left-open');
    this.sidebarRestore.addEventListener('click', () => void this.togglePanel('sidebar'));
    this.mainRestore = shell.createEl('button', { cls: 'cn-main-restore', attr: {
      type: 'button', 'aria-label': 'Show main calendar', title: 'Show main calendar', 'aria-expanded': 'false',
    } });
    setIcon(this.mainRestore, 'panel-right-open');
    this.mainRestore.addEventListener('click', () => void this.togglePanel('main'));
    const sidebar = shell.createDiv({ cls: 'cn-sidebar' });
    this.sidebarEl = sidebar;
    const miniHeading = sidebar.createDiv({ cls: 'cn-mini-heading' });
    const miniPrev = miniHeading.createEl('button', { text: '‹', attr: { 'aria-label': 'Previous month' } });
    this.miniNavTitle = miniHeading.createEl('span');
    const miniToday = miniHeading.createEl('button', { text: 'Today', attr: { 'aria-label': 'Navigate calendar to today' } });
    const miniNext = miniHeading.createEl('button', { text: '›', attr: { 'aria-label': 'Next month' } });
    const miniCollapse = miniHeading.createEl('button', { text: '×', attr: { 'aria-label': 'Collapse calendar sidebar', title: 'Collapse calendar sidebar' } });
    this.miniEl = sidebar.createDiv({ cls: 'cn-mini' });
    this.miniMonth = dateAt(this.today(), this.settings.timeZone).startOf('month').format('YYYY-MM-DD');
    miniPrev.addEventListener('click', () => { this.miniMonth = dateAt(this.miniMonth!, this.settings.timeZone).subtract(1, 'month').format('YYYY-MM-DD'); this.miniEl!.scrollTop = 0; this.renderMini(); });
    miniNext.addEventListener('click', () => { this.miniMonth = dateAt(this.miniMonth!, this.settings.timeZone).add(1, 'month').format('YYYY-MM-DD'); this.miniEl!.scrollTop = 0; this.renderMini(); });
    miniToday.addEventListener('click', () => this.navigateToday());
    miniCollapse.addEventListener('click', () => void this.togglePanel('sidebar'));
    this.miniResizeObserver = new ResizeObserver(() => {
      if (this.miniResizeFrame) cancelAnimationFrame(this.miniResizeFrame);
      this.miniResizeFrame = requestAnimationFrame(() => { this.miniResizeFrame = undefined; this.renderMini(); });
    });
    this.miniResizeObserver.observe(this.miniEl);
    this.separatorEl = shell.createDiv({ cls: 'cn-sidebar-resizer', attr: {
      role: 'separator', tabindex: '0', 'aria-label': 'Resize calendar sidebar',
      'aria-orientation': 'vertical', 'aria-valuemin': '200', 'aria-valuemax': '480',
    } });
    this.separatorEl.addEventListener('pointerdown', event => this.startSidebarDrag(event));
    this.separatorEl.addEventListener('keydown', event => {
      const width = resizeSidebarWithKeyboard(this.sidebarEl?.getBoundingClientRect().width ?? this.settings.sidebarWidth,
        event.key, shell.clientWidth, event.shiftKey);
      if (width === undefined) return;
      event.preventDefault();
      this.applySidebarLayout(width);
      this.pendingSidebarWidth = width;
      if (this.sidebarPersistTimer) window.clearTimeout(this.sidebarPersistTimer);
      this.sidebarPersistTimer = window.setTimeout(() => {
        this.sidebarPersistTimer = undefined;
        const settledWidth = this.pendingSidebarWidth;
        this.pendingSidebarWidth = undefined;
        if (settledWidth !== undefined) void this.saveDisplaySettings({ sidebarWidth: settledWidth });
      }, 180);
    });
    this.shellResizeObserver = new ResizeObserver(() => this.applySidebarLayout());
    this.shellResizeObserver.observe(shell);
    const content = shell.createDiv({ cls: 'cn-content' });
    const toolbar = content.createDiv({ cls: 'cn-toolbar' });
    const navigation = toolbar.createDiv({ cls: 'cn-navigation' });
    this.button(navigation, 'Today', () => this.navigateToday());
    this.button(navigation, '‹', () => this.calendar?.prev(), 'Previous period');
    this.button(navigation, '›', () => this.calendar?.next(), 'Next period');
    this.viewWeekEl = this.button(navigation, 'Week', () => {
      const day = this.calendar ? isoDay(this.calendar.view.currentStart, this.settings.timeZone) : this.today();
      void this.openWeek(day);
    });
    this.viewWeekEl.addClass('cn-view-week');
    this.periodEl = navigation.createEl('strong', { cls: 'cn-period' });
    const controls = toolbar.createDiv({ cls: 'cn-controls' });
    this.workdaysToggle = this.button(controls, 'Workdays', () => void this.toggleWorkdays(), 'Show workdays only in the main calendar');
    this.workdaysToggle.addClass('cn-workdays-toggle');
    const views = controls.createEl('select', { attr: { 'aria-label': 'Calendar view' } });
    for (const [id, label] of CALENDAR_VIEWS) views.createEl('option', { value: id, text: label });
    views.value = this.viewType;
    views.addEventListener('change', () => { this.viewType = views.value; this.calendar?.changeView(views.value, this.selectedDay); });
    this.button(controls, 'New event', () => this.newEvent());
    this.button(controls, 'Refresh', () => void this.plugin.refresh(true));
    this.historyEl = this.button(controls, 'History', () => this.plugin.showHistory());
    this.problemsEl = this.button(controls, 'Note problems', () => this.plugin.showProblems(), 'Review Event Note problems');
    this.problemsEl.addClass('cn-problems-button');
    this.problemsEl.hidden = true;
    this.mainCollapse = this.button(controls, '', () => void this.togglePanel('main'), 'Hide main calendar');
    this.mainCollapse.addClass('cn-main-collapse');
    this.mainCollapse.title = 'Hide main calendar';
    setIcon(this.mainCollapse, 'panel-right-close');
    this.subscriptionFailureEl = content.createDiv({ cls: 'cn-subscription-failure', attr: { role: 'status', 'aria-live': 'polite' } });
    this.listDatesEl = content.createDiv({ cls: 'cn-list-dates' });
    const grid = content.createDiv({ cls: 'cn-calendar' });
    const rules = resolveWeekRules(this.app, this.settings);
    this.updateHolidays();
    this.calendar = new Calendar(grid, {
      plugins: [dayGridPlugin, timeGridPlugin, listPlugin, multiMonthPlugin, interactionPlugin, momentTimezonePlugin],
      initialView: this.viewType,
      headerToolbar: false,
      timeZone: this.settings.timeZone,
      locale: 'en',
      firstDay: this.firstDay(),
      weekends: !this.settings.workdaysOnly,
      weekNumbers: true,
      weekNumberCalculation: date => weekInfo(date, rules, this.settings.timeZone).number,
      weekNumberContent: arg => String(arg.num),
      navLinks: false,
      nowIndicator: true,
      selectable: false,
      editable: true,
      eventResizableFromStart: true,
      eventOverlap: true,
      slotDuration: { minutes: this.settings.snapMinutes },
      snapDuration: { minutes: this.settings.snapMinutes },
      allDaySlot: true,
      dayMaxEvents: true,
      height: '100%',
      scrollTime: '08:00:00',
      views: {
        timeGridWeek: { weekNumbers: false }, timeGridDay: { weekNumbers: false },
        customDays: { type: 'timeGrid', duration: { days: this.settings.customDays }, weekNumbers: false },
        listWeek: {},
      },
      events: (_range, success) => success(this.eventInputs()),
      datesSet: info => {
        this.periodEl?.setText(info.view.title);
        const visibleStart = isoDay(info.start, this.settings.timeZone);
        const visibleEnd = isoDay(info.end, this.settings.timeZone);
        if (!this.selectedDay || this.selectedDay < visibleStart || this.selectedDay >= visibleEnd) {
          this.selectedDay = isoDay(this.calendar?.getDate() ?? info.view.currentStart, this.settings.timeZone);
        }
        this.miniMonth = dateAt(this.selectedDay, this.settings.timeZone).startOf('month').format('YYYY-MM-DD');
        this.renderMini();
        if (this.viewWeekEl) {
          const start = isoDay(info.view.currentStart, this.settings.timeZone);
          const week = weekInfo(start, resolveWeekRules(this.app, this.settings), this.settings.timeZone);
          const show = info.view.type === 'timeGridWeek' || info.view.type === 'customDays';
          this.viewWeekEl.toggleClass('cn-hidden', !show);
          this.viewWeekEl.setText(`Week ${week.number}`);
          const label = `${week.label}, ${week.start} through ${week.end}. Open Weekly Note.`;
          this.viewWeekEl.setAttribute('aria-label', label);
          this.viewWeekEl.title = label;
        }
        this.renderListDates(info.view.type, info.start, info.end);
        this.installDateButtons();
        void this.plugin.onVisibleRange({ start: info.start.toISOString(), end: info.end.toISOString() }, this);
      },
      dateClick: arg => this.handleDateClick(arg),
      dayHeaderContent: arg => {
        const formatted = dateAt(arg.date, this.settings.timeZone).locale('en');
        if (arg.view.type === 'dayGridMonth' || arg.view.type === 'multiMonthYear') return formatted.format('ddd');
        const day = formatted.format('YYYY-MM-DD');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'cn-date-open cn-date-open-header';
        button.setAttribute('aria-label', `Open Daily Note for ${day}`);
        const weekday = document.createElement('span'); weekday.textContent = formatted.format('ddd');
        const number = document.createElement('span'); number.textContent = formatted.format('D');
        button.append(weekday, number);
        button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void this.openDay(day); });
        return { domNodes: [button] };
      },
      eventClick: arg => this.handleEventClick(arg),
      eventDrop: arg => void this.handleMove(arg),
      eventResize: arg => void this.handleMove(arg),
      eventDidMount: arg => {
        const event = this.plugin.eventById(arg.event.id);
        if (!event) return;
        arg.el.setAttribute('aria-label', `${event.title}. ${this.settings.eventClickAction === 'dialog' ? 'Show event details.' : 'Open Event Note.'}`);
        const details = document.createElement('button');
        details.className = 'cn-event-details';
        details.textContent = '⋯';
        details.type = 'button';
        details.setAttribute('aria-label', `Details and edit: ${event.title}`);
        details.addEventListener('click', e => { e.stopPropagation(); this.actions.showDetails(event); });
        arg.el.appendChild(details);
        arg.el.addEventListener('contextmenu', e => {
          e.preventDefault(); e.stopPropagation(); this.showSlotMenu(e, event);
        });
      },
      dayCellDidMount: () => this.installDateButtons(),
      weekNumberDidMount: arg => {
        const week = weekInfo(arg.date, resolveWeekRules(this.app, this.settings), this.settings.timeZone);
        const label = `${week.label}, ${week.start} through ${week.end}. Open Weekly Note.`;
        arg.el.setAttribute('role', 'button');
        arg.el.setAttribute('tabindex', '0');
        arg.el.setAttribute('aria-label', label);
        arg.el.setAttribute('title', label);
        if (week.start === weekInfo(this.today(), resolveWeekRules(this.app, this.settings), this.settings.timeZone).start) arg.el.classList.add('is-current-week');
        const open = (event: Event) => { event.preventDefault(); event.stopPropagation(); void this.openWeek(week.start); };
        arg.el.addEventListener('click', open);
        arg.el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') open(event); });
      },
    });
    grid.addEventListener('contextmenu', e => {
      if ((e.target as HTMLElement).closest('.fc-event')) return;
      e.preventDefault();
      this.showSlotMenu(e);
    });
    this.dateButtonObserver = new MutationObserver(() => this.installDateButtons());
    this.dateButtonObserver.observe(grid, { childList: true, subtree: true });
    this.calendar.render();
    this.applySidebarLayout();
    this.updateDisplayControls();
    this.updateSubscriptionFailure();
    this.renderMini();
  }

  async onClose(): Promise<void> {
    if (this.sidebarPersistTimer) window.clearTimeout(this.sidebarPersistTimer);
    if (this.pendingSidebarWidth !== undefined) {
      await this.saveDisplaySettings({ sidebarWidth: this.pendingSidebarWidth });
      this.pendingSidebarWidth = undefined;
    }
    this.dateButtonObserver?.disconnect();
    this.miniResizeObserver?.disconnect();
    this.shellResizeObserver?.disconnect();
    this.stopSidebarDrag?.();
    if (this.miniResizeFrame) cancelAnimationFrame(this.miniResizeFrame);
    if (this.layoutResizeFrame) cancelAnimationFrame(this.layoutResizeFrame);
    this.calendar?.destroy(); this.calendar = undefined;
    this.plugin.releaseVisibleRange(this);
  }
  get settings(): PluginSettings { return this.plugin.store.state.settings; }
  private today(): string { return dateAt(new Date(), this.settings.timeZone).format('YYYY-MM-DD'); }
  private navigateToday(): void {
    const today = this.today();
    this.selectedDay = today;
    this.miniMonth = dateAt(today, this.settings.timeZone).startOf('month').format('YYYY-MM-DD');
    if (this.miniEl) this.miniEl.scrollTop = 0;
    this.calendar?.today();
    this.renderMini();
  }
  private firstDay(): number {
    return firstWeekday(resolveWeekRules(this.app, this.settings), this.settings.timeZone);
  }
  private applySidebarLayout(requested = this.pendingSidebarWidth ?? this.settings.sidebarWidth): void {
    if (!this.shellEl || !this.sidebarEl || !this.separatorEl) return;
    const collapsed = this.settings.sidebarCollapsed;
    const mainCollapsed = this.settings.mainCollapsed && !collapsed;
    const width = sidebarWidthForContainer(requested, this.shellEl.clientWidth);
    const overlay = !collapsed && !mainCollapsed && width === 0;
    this.shellEl.toggleClass('is-sidebar-collapsed', collapsed);
    this.shellEl.toggleClass('is-main-collapsed', mainCollapsed);
    this.shellEl.toggleClass('is-sidebar-overlay', overlay);
    this.sidebarEl.setCssProps({ '--cn-sidebar-width': mainCollapsed ? 'auto' : `${overlay ? Math.min(260, Math.max(0, this.shellEl.clientWidth - 16)) : width}px` });
    const placement = miniDateClick(this.settings.miniDateClickAction, mainCollapsed);
    const dates = placement === 'split' ? 'Dates open Daily Notes beside the calendar.'
      : placement === 'tab' ? 'Dates open Daily Notes in a new tab.' : 'Dates navigate the calendar.';
    if (this.miniNavTitle) this.miniNavTitle.title = `${dates} Week numbers open Weekly Notes${mainCollapsed ? ' beside the calendar' : ''}.`;
    this.separatorEl.setAttribute('aria-valuenow', String(width || requested));
    this.updateDisplayControls();
    if (this.layoutResizeFrame) cancelAnimationFrame(this.layoutResizeFrame);
    this.layoutResizeFrame = requestAnimationFrame(() => { this.layoutResizeFrame = undefined; this.calendar?.updateSize(); });
  }
  private updateDisplayControls(): void {
    this.sidebarRestore?.setAttribute('aria-expanded', String(!this.settings.sidebarCollapsed));
    this.mainRestore?.setAttribute('aria-expanded', String(!this.settings.mainCollapsed));
    this.workdaysToggle?.setAttribute('aria-pressed', String(this.settings.workdaysOnly));
    this.workdaysToggle?.setAttribute('aria-label', this.settings.workdaysOnly ? 'Show all days in the main calendar' : 'Show workdays only in the main calendar');
    this.workdaysToggle?.toggleClass('is-active', this.settings.workdaysOnly);
  }
  private async saveDisplaySettings(change: Partial<Pick<PluginSettings, 'sidebarWidth' | 'sidebarCollapsed' | 'mainCollapsed' | 'workdaysOnly'>>): Promise<void> {
    try {
      await this.plugin.store.commit([], state => { state.settings = { ...state.settings, ...change }; });
      for (const leaf of this.app.workspace.getLeavesOfType(CALENDAR_VIEW_TYPE)) {
        if (leaf.view instanceof CalendarNoteView) leaf.view.settingsChanged();
      }
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not save calendar display settings.');
      this.settingsChanged();
    }
  }
  private async togglePanel(panel: CalendarPanel): Promise<void> {
    await this.saveDisplaySettings(togglePanel(this.settings, panel));
  }
  private async toggleWorkdays(): Promise<void> {
    const workdaysOnly = !this.settings.workdaysOnly;
    await this.saveDisplaySettings({ workdaysOnly });
  }
  private startSidebarDrag(event: PointerEvent): void {
    if (event.button !== 0 || !this.shellEl || !this.sidebarEl) return;
    if (this.sidebarPersistTimer) window.clearTimeout(this.sidebarPersistTimer);
    this.sidebarPersistTimer = undefined;
    this.pendingSidebarWidth = undefined;
    this.separatorEl?.focus();
    event.preventDefault();
    this.stopSidebarDrag?.();
    const startX = event.clientX;
    const startWidth = this.sidebarEl.getBoundingClientRect().width;
    let currentWidth = startWidth;
    const move = (next: PointerEvent) => {
      const width = sidebarWidthForContainer(startWidth + next.clientX - startX, this.shellEl!.clientWidth);
      if (!width) return;
      currentWidth = width;
      this.applySidebarLayout(width);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      this.stopSidebarDrag = undefined;
      if (Math.round(currentWidth) !== this.settings.sidebarWidth) void this.saveDisplaySettings({ sidebarWidth: Math.round(currentWidth) });
    };
    this.stopSidebarDrag = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }
  private button(parent: HTMLElement, label: string, click: () => void, aria = label): HTMLButtonElement {
    const button = parent.createEl('button', { text: label });
    button.setAttribute('aria-label', aria);
    button.addEventListener('click', click);
    return button;
  }
  private weekButton(parent: HTMLElement, day: string, label: string): void {
    const week = weekInfo(day, resolveWeekRules(this.app, this.settings), this.settings.timeZone);
    const button = this.button(parent, label, () => void this.openWeek(week.start),
      `${week.label}, ${week.start} through ${week.end}. Open Weekly Note.`);
    button.title = button.getAttribute('aria-label') ?? '';
    if (week.start === weekInfo(this.today(), resolveWeekRules(this.app, this.settings), this.settings.timeZone).start) button.addClass('is-current-week');
  }
  private get miniOnly(): boolean { return this.settings.mainCollapsed && !this.settings.sidebarCollapsed; }
  /** With only the mini calendar showing, notes open in one reused leaf beside it instead of a new tab. */
  private noteTarget(): () => WorkspaceLeaf {
    return this.miniOnly ? this.actions.besideTarget : this.actions.tabTarget;
  }
  private async openWeek(day: string): Promise<void> { await this.plugin.runAction(() => this.plugin.notes.openWeekly(day, this.noteTarget())); }
  private placementTarget(placement?: NotePlacement): () => WorkspaceLeaf {
    return placement === 'split' ? this.actions.besideTarget : placement === 'tab' ? this.actions.tabTarget : this.noteTarget();
  }
  private async openDay(day: string, placement?: NotePlacement): Promise<void> {
    this.selectedDay = day; this.renderMini();
    await this.plugin.runAction(() => this.plugin.notes.openDaily(day, this.placementTarget(placement)));
  }
  private renderMini(): void {
    if (!this.miniEl || !this.miniMonth) return;
    const first = dateAt(this.miniMonth, this.settings.timeZone).locale('en');
    this.miniNavTitle?.setText(first.format('MMM YYYY'));
    const previousScroll = this.miniEl.scrollTop;
    this.miniEl.empty();
    const columns = this.miniOnly ? miniMonthColumns(this.miniEl.clientWidth) : 1;
    const firstCard = this.renderMiniMonth(first, columns > 1);
    const nextCard = this.renderMiniMonth(first.clone().add(1, 'month'));
    const cardHeight = nextCard.getBoundingClientRect().height;
    const firstHeight = firstCard.getBoundingClientRect().height;
    const fit = visibleMonthCount(this.miniEl.clientHeight + Math.max(0, cardHeight - firstHeight), cardHeight);
    const rendered = columns > 1 ? Math.min(24, columns * (fit + 1)) : Math.min(6, fit + 2);
    for (let month = 2; month < rendered; month++) this.renderMiniMonth(first.clone().add(month, 'month'));
    this.miniEl.scrollTop = previousScroll;
  }
  private renderMiniMonth(monthDate: moment.Moment, showHeading = true): HTMLElement {
    const card = this.miniEl!.createDiv({ cls: 'cn-mini-month' });
    if (showHeading) card.createEl('h3', { text: monthDate.format('MMMM YYYY') });
    const table = card.createEl('table');
    const head = table.createEl('thead').createEl('tr');
    head.createEl('th', { text: 'Wk' });
    const firstDay = this.firstDay();
    for (let d = 0; d < 7; d++) {
      const weekday = dateAt('2026-10-18', this.settings.timeZone).add((firstDay + d) % 7, 'days').locale('en');
      const th = head.createEl('th', { text: weekday.format('ddd') }); th.title = weekday.format('dddd');
    }
    const start = monthDate.clone().subtract((monthDate.day() - firstDay + 7) % 7, 'days');
    for (let row = 0; row < 6; row++) {
      const tr = table.createEl('tr');
      const weekDay = start.clone().add(row * 7, 'days').format('YYYY-MM-DD');
      const weekCell = tr.createEl('td');
      this.weekButton(weekCell, weekDay, String(weekInfo(weekDay, resolveWeekRules(this.app, this.settings), this.settings.timeZone).number));
      for (let col = 0; col < 7; col++) {
        const day = start.clone().add(row * 7 + col, 'days').format('YYYY-MM-DD');
        const td = tr.createEl('td');
        if (day.slice(0, 7) !== monthDate.format('YYYY-MM')) td.addClass('is-outside');
        const placement = miniDateClick(this.settings.miniDateClickAction, this.miniOnly);
        const button = this.button(td, String(Number(day.slice(-2))), () => {
          this.selectedDay = day; this.calendar?.gotoDate(day); this.renderMini();
          if (placement) void this.openDay(day, placement);
        }, placement ? `Open Daily Note for ${day}` : `Navigate to ${day}`);
        if (day === this.today()) button.addClass('is-today');
        if (day === this.selectedDay) button.addClass('is-selected');
        const holiday = this.holidays.get(day);
        if (holiday) {
          button.addClass('is-holiday');
          if (holiday.color) button.style.setProperty('--cn-holiday-color', holiday.color);
          else button.addClass('is-holiday-unshaded');
          button.title = holiday.titles.join(', ');
          button.setAttribute('aria-label', `${button.getAttribute('aria-label') ?? day} (${holiday.titles.join(', ')})`);
        }
      }
    }
    return card;
  }
  private renderListDates(type: string, start: Date, end: Date): void {
    if (!this.listDatesEl) return;
    this.listDatesEl.empty();
    this.listDatesEl.classList.toggle('is-hidden', type !== 'listWeek');
    if (type !== 'listWeek') return;
    const row = this.listDatesEl.createDiv({ cls: 'cn-list-date-buttons' });
    const weekStart = dateAt(start, this.settings.timeZone).format('YYYY-MM-DD');
    this.weekButton(row, weekStart, `Week ${weekInfo(weekStart, resolveWeekRules(this.app, this.settings), this.settings.timeZone).number}`);
    let date = dateAt(start, this.settings.timeZone).locale('en');
    const last = dateAt(end, this.settings.timeZone);
    while (date.isBefore(last)) {
      const day = date.format('YYYY-MM-DD');
      if (!this.settings.workdaysOnly || (date.day() !== 0 && date.day() !== 6)) {
        this.button(row, date.format('ddd D'), () => void this.openDay(day), `Open Daily Note for ${day}`);
      }
      date.add(1, 'day');
    }
  }
  private installDateButtons(): void {
    const grid = this.containerEl.querySelector('.cn-calendar');
    if (!grid) return;
    const view = this.calendar?.view.type ?? this.viewType;
    const daygrid = view === 'dayGridMonth' || view === 'multiMonthYear';
    const selector = '.fc-list-day[data-date]';
    grid.querySelectorAll<HTMLElement>(selector).forEach(cell => {
      const date = cell.getAttribute('data-date');
      if (!date) return;
      const target = cell.querySelector('.fc-list-day-cushion') ?? cell;
      let button = target.querySelector<HTMLButtonElement>(':scope > .cn-date-open');
      if (!button) {
        button = document.createElement('button');
        button.className = 'cn-date-open'; button.type = 'button';
        button.textContent = dateAt(date, this.settings.timeZone).locale('en').format('ddd, MMM D');
        button.setAttribute('aria-label', `Open Daily Note for ${date}`);
        button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); void this.openDay(date); });
      }
      if (target.childNodes.length !== 1 || target.firstChild !== button) target.replaceChildren(button);
    });
    if (daygrid) grid.querySelectorAll<HTMLElement>('.fc-daygrid-day[data-date]').forEach(cell => {
      const date = cell.dataset.date;
      const number = cell.querySelector<HTMLElement>('.fc-daygrid-day-number');
      if (!date || !number || number.dataset.cnReady) return;
      number.dataset.cnReady = '1';
      number.setAttribute('role', 'button');
      number.setAttribute('tabindex', '0');
      number.setAttribute('aria-label', `Open Daily Note for ${date}`);
      const open = (event: Event) => { event.preventDefault(); event.stopPropagation(); void this.openDay(date); };
      number.addEventListener('click', open);
      number.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') open(event); });
    });
  }
  private eventInputs(): EventInput[] {
    const sources = this.settings.sources;
    const events: EventInput[] = this.plugin.events.filter(event => showsEvent(event, sources)).map(event => ({
      id: event.id, title: event.title, start: event.start,
      ...(!event.allDay && Date.parse(event.start) === Date.parse(event.end) ? {} : { end: event.end }),
      allDay: event.allDay,
      backgroundColor: sources.find(source => source.id === event.sourceId)?.color ?? undefined,
    }));
    // One whole-day background per holiday date: it fills the day's column in time grids and its cell in Month and Year.
    for (const [day, holiday] of this.holidays) {
      if (!holiday.color) continue;
      events.push({
        id: `holiday-background|${day}`, start: day, end: dateAt(day, this.settings.timeZone).add(1, 'day').format('YYYY-MM-DD'),
        allDay: true, display: 'background', backgroundColor: holiday.color, classNames: ['cn-holiday-background'], editable: false,
      });
    }
    return events;
  }
  /** Holidays come from every cached event of holiday calendars, so the mini calendar can mark months outside the main view. */
  private updateHolidays(): void {
    const all = this.plugin.subscriptions?.getEvents({ start: new Date(0).toISOString(), end: new Date(8640000000000000).toISOString() });
    this.holidays = holidayDays(all ?? this.plugin.events, this.settings.sources, this.settings.timeZone);
  }
  private updateSubscriptionFailure(): void {
    if (!this.subscriptionFailureEl) return;
    const message = subscriptionFailureMessage(this.settings, this.plugin.store.state.sourceCaches);
    this.subscriptionFailureEl.hidden = !message;
    this.subscriptionFailureEl.setText(message ?? '');
    this.subscriptionFailureEl.title = message ?? '';
  }
  refresh(): void {
    if (!this.calendar) return;
    this.historyEl?.setText(this.plugin.reviewCount ? `History (${this.plugin.reviewCount})` : 'History');
    if (this.problemsEl) {
      this.problemsEl.hidden = !this.plugin.problemCount;
      this.problemsEl.setText(`⚠ ${this.plugin.problemCount} note ${this.plugin.problemCount === 1 ? 'problem' : 'problems'}`);
    }
    this.updateSubscriptionFailure();
    this.updateHolidays();
    this.calendar.refetchEvents();
    this.renderMini();
  }
  settingsChanged(): void {
    if (!this.calendar) return;
    this.calendar.setOption('timeZone', this.settings.timeZone);
    this.calendar.setOption('locale', 'en');
    const rules = resolveWeekRules(this.app, this.settings);
    this.calendar.setOption('weekNumberCalculation', date => weekInfo(date, rules, this.settings.timeZone).number);
    this.calendar.setOption('firstDay', this.firstDay());
    this.calendar.setOption('weekends', !this.settings.workdaysOnly);
    this.calendar.setOption('slotDuration', { minutes: this.settings.snapMinutes });
    this.calendar.setOption('snapDuration', { minutes: this.settings.snapMinutes });
    this.calendar.setOption('views', {
      timeGridWeek: { weekNumbers: false }, timeGridDay: { weekNumbers: false },
      customDays: { type: 'timeGrid', duration: { days: this.settings.customDays }, weekNumbers: false },
      listWeek: {},
    });
    this.applySidebarLayout();
    this.updateDisplayControls();
    this.refresh();
  }
  private handleDateClick(arg: DateClickArg): void {
    // Day numbers and week numbers sit inside date cells and handle their own clicks.
    if ((arg.jsEvent.target as HTMLElement | null)?.closest('.cn-date-open, .fc-daygrid-day-number, .fc-daygrid-week-number')) return;
    const day = arg.dateStr.slice(0, 10);
    const action = mainDateClick(this.settings.mainDateClickAction, arg.view.type);
    if (action.kind === 'none') return;
    if (action.kind === 'daily') { void this.openDay(day, action.placement); return; }
    this.newEvent({ start: arg.allDay ? day : arg.date.toISOString(),
      end: arg.allDay ? dateAt(day, this.settings.timeZone).add(1, 'day').format('YYYY-MM-DD')
        : dateAt(arg.date, this.settings.timeZone).add(this.settings.defaultDurationMinutes, 'minutes').toISOString(), allDay: arg.allDay });
  }
  private handleEventClick(arg: EventClickArg): void {
    arg.jsEvent.preventDefault();
    if (Date.now() - this.lastDragAt < 600) return;
    const event = this.plugin.eventById(arg.event.id);
    if (event) this.actions.click(event);
  }
  /** Right-click: add an event here, or edit any event shown under the pointer. */
  private showSlotMenu(e: MouseEvent, clicked?: CalendarEvent): void {
    const span = this.pointerSpan(e, clicked);
    const menu = new Menu();
    menu.addItem(item => item.setTitle('New event').setIcon('plus').onClick(() => this.newEvent(this.newEventInterval(span))));
    const shown = this.plugin.events.filter(event => showsEvent(event, this.settings.sources));
    const events = eventsAt(shown, span, this.settings.timeZone, clicked);
    if (events.length) menu.addSeparator();
    for (const event of events) {
      menu.addItem(item => item.setTitle(editMenuTitle(event, this.settings.timeZone)).setIcon('pencil').onClick(() => this.actions.showDetails(event)));
    }
    menu.showAtMouseEvent(e);
  }
  private async handleMove(arg: EventDropArg | EventResizeDoneArg): Promise<void> {
    this.lastDragAt = Date.now();
    const event = this.plugin.eventById(arg.event.id);
    if (!event || !arg.event.start) { arg.revert(); return; }
    const dayStart = (date: Date) => moment.tz(isoDay(date, this.settings.timeZone), 'YYYY-MM-DD', true, this.settings.timeZone).format('YYYY-MM-DDTHH:mm:ssZ');
    const interval: Interval = { start: arg.event.allDay ? dayStart(arg.event.start) : arg.event.start.toISOString(),
      end: arg.event.end ? arg.event.allDay ? dayStart(arg.event.end) : arg.event.end.toISOString()
        : arg.event.allDay ? dateAt(dayStart(arg.event.start), this.settings.timeZone).add(1, 'day').format('YYYY-MM-DDTHH:mm:ssZ')
          : dateAt(arg.event.start, this.settings.timeZone).add(this.settings.defaultDurationMinutes, 'minutes').toISOString(), allDay: arg.event.allDay };
    try { await this.plugin.reschedule(event, interval); }
    catch (error) { arg.revert(); new Notice(error instanceof Error ? error.message : 'Could not reschedule event.'); }
  }
  /** A time-grid slot when the pointer is over one, otherwise the date of the cell or event under it. */
  private pointerSpan(e: MouseEvent, fallback?: CalendarEvent): PointerSpan {
    const grid = this.containerEl.querySelector<HTMLElement>('.cn-calendar');
    const within = (el: HTMLElement, horizontal: boolean) => {
      const r = el.getBoundingClientRect();
      return horizontal ? e.clientX >= r.left && e.clientX < r.right : e.clientY >= r.top && e.clientY < r.bottom;
    };
    const column = Array.from(grid?.querySelectorAll<HTMLElement>('.fc-timegrid-col[data-date]') ?? []).find(el => within(el, true));
    const slot = Array.from(grid?.querySelectorAll<HTMLElement>('.fc-timegrid-slot[data-time]') ?? []).find(el => within(el, false));
    if (column?.dataset.date && slot?.dataset.time) {
      const start = moment.tz(`${column.dataset.date}T${slot.dataset.time.slice(0, 5)}:00`, 'YYYY-MM-DDTHH:mm:ss', true, this.settings.timeZone);
      return { kind: 'slot', start: start.toISOString(), end: start.clone().add(this.settings.snapMinutes, 'minutes').toISOString() };
    }
    const cell = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-date]')?.dataset.date?.slice(0, 10);
    const date = cell ?? (fallback ? (fallback.allDay ? fallback.start.slice(0, 10) : dateAt(fallback.start, this.settings.timeZone).format('YYYY-MM-DD'))
      : this.selectedDay ?? this.today());
    return { kind: 'day', date };
  }
  private newEventInterval(span: PointerSpan): Interval {
    const start = span.kind === 'slot' ? span.start
      : moment.tz(`${span.date}T09:00:00`, 'YYYY-MM-DDTHH:mm:ss', true, this.settings.timeZone).toISOString();
    return { start, end: dateAt(start, this.settings.timeZone).add(this.settings.defaultDurationMinutes, 'minutes').toISOString(), allDay: false };
  }
  newEvent(initial?: Interval): void {
    const day = this.selectedDay ?? this.today();
    const start = initial?.start ?? moment.tz(`${day}T09:00:00`, 'YYYY-MM-DDTHH:mm:ss', true, this.settings.timeZone).toISOString();
    const interval = initial ?? { start, end: dateAt(start, this.settings.timeZone).add(this.settings.defaultDurationMinutes, 'minutes').toISOString() };
    this.actions.newEvent(interval);
  }
}
