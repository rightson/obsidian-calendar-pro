import { ItemView, Menu, Notice, setIcon, setTooltip, type HoverParent, type HoverPopover, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import { dateAt, weekInfo } from './date';
import { resolveWeekRules } from './settings';
import type CalendarNotePlugin from './main';
import type { CalendarEvent, PluginSettings } from './types';
import { EventActions } from './event-actions';
import { showsEvent } from './holidays';
import {
  AGENDA_HOUR_HEIGHT, AGENDA_LIST_DAYS, AGENDA_MIN_BLOCK_MINUTES, addDays, agendaDays, centeredScrollTop, dayRange, daysWithEvents,
  draggedInterval, eventTimeLabel, eventsOnDay, instantAt, nextDayPreviewHours, previousDayPreviewHours, snappedMinutes, weekDays, type PlacedEvent,
} from './agenda-layout';

export const AGENDA_VIEW_TYPE = 'calendar-pro-agenda';
/** Page preview source for hovering an event in the sidebar; listed under Settings → Page preview. */
export const AGENDA_HOVER_SOURCE = 'calendar-pro-events';

export type AgendaMode = 'day' | 'list';
const isAgendaMode = (value: unknown): value is AgendaMode => value === 'day' || value === 'list';
/** Pointer travel before a press on an event becomes a drag instead of a click. */
const DRAG_THRESHOLD = 4;
const HOUR = AGENDA_HOUR_HEIGHT;

/** Hours of the neighbouring days shown dimmed above and below the selected day's timeline. */
interface Preview { before: number; after: number }
const samePreview = (a: Preview, b: Preview) => a.before === b.before && a.after === b.after;

interface DragState {
  pointerId: number;
  block: HTMLElement;
  timeEl: HTMLElement;
  placed: PlacedEvent;
  mode: 'move' | 'resize';
  startY: number;
  top: number;
  height: number;
  minutes: number;
  active: boolean;
}

/**
 * The events sidebar: a week strip over one day's timeline, like a phone
 * calendar, or a list of the coming days. Hovering an event previews its
 * Event Note, clicking follows the Clicking an event setting, dragging moves
 * or resizes it, and right-clicking offers the rest.
 */
export class AgendaView extends ItemView implements HoverParent {
  hoverPopover: HoverPopover | null = null;
  private readonly actions: EventActions;
  private mode: AgendaMode = 'day';
  private selectedDay = '';
  private headingTitleEl?: HTMLElement;
  private weekEl?: HTMLButtonElement;
  private modeButtons = new Map<AgendaMode, HTMLButtonElement>();
  private stripEl?: HTMLElement;
  private dayTitleEl?: HTMLButtonElement;
  private bodyEl?: HTMLElement;
  private scrollEl?: HTMLElement;
  private nowEl?: HTMLElement;
  private scrollPending = true;
  /** While true, today's timeline keeps the current time in the middle; scrolling by hand turns it off. */
  private followNow = false;
  /** The scroll offset the view last set itself, to tell its own scrolling from the user's. */
  private autoScrollTop?: number;
  /** A scroll offset to restore on the next render instead of the usual one. */
  private nextScrollTop?: number;
  /** Hours of the previous and next day previewed around today's timeline in the current render. */
  private preview: Preview = { before: 0, after: 0 };
  private rangeKey = '';
  private drag?: DragState;
  private suppressClickUntil = 0;
  private wheelX = 0;
  private renderedToday = '';

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CalendarNotePlugin) {
    super(leaf);
    this.actions = new EventActions(plugin, () => this.leaf);
  }

  getViewType(): string { return AGENDA_VIEW_TYPE; }
  getDisplayText(): string { return 'Calendar Pro events'; }
  getIcon(): string { return 'calendar-clock'; }

  getState(): Record<string, unknown> { return { ...super.getState(), mode: this.mode }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const mode = (state as { mode?: unknown } | null)?.mode;
    if (isAgendaMode(mode) && mode !== this.mode) { this.mode = mode; this.scrollPending = true; this.render(); }
    await super.setState(state, result);
  }

  /** The events the main calendar shows: holiday calendars set to hide their events stay out here too. */
  private shownEvents(): CalendarEvent[] {
    return this.plugin.events.filter(event => showsEvent(event, this.settings.sources));
  }
  private get settings(): PluginSettings { return this.plugin.store.state.settings; }
  private get zone(): string { return this.settings.timeZone; }
  private today(): string { return dateAt(new Date(), this.zone).format('YYYY-MM-DD'); }
  private firstDay(): number {
    const rules = resolveWeekRules(this.app, this.settings);
    if (rules.weekMode === 'iso') return 1;
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return rules.weekStart === 'locale' ? dateAt(new Date(), this.zone).locale(rules.locale).localeData().firstDayOfWeek() : names.indexOf(rules.weekStart);
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass('cn-agenda-view');
    this.selectedDay = this.today();
    this.renderedToday = this.selectedDay;

    const header = root.createDiv({ cls: 'cn-agenda-header' });
    const heading = header.createDiv({ cls: 'cn-agenda-heading' });
    this.headingTitleEl = heading.createEl('strong', { cls: 'cn-agenda-title' });
    this.weekEl = heading.createEl('button', { cls: 'cn-agenda-week-number clickable-icon', attr: { type: 'button' } });
    this.weekEl.addEventListener('click', () => void this.plugin.runAction(() => this.plugin.notes.openWeekly(this.selectedDay, this.actions.tabTarget)));
    const tools = heading.createDiv({ cls: 'cn-agenda-tools' });
    const todayButton = tools.createEl('button', { text: 'Today', cls: 'cn-agenda-today', attr: { type: 'button', 'aria-label': 'Show today' } });
    todayButton.addEventListener('click', () => this.select(this.today()));
    this.iconButton(tools, 'plus', 'New event', () => this.newEventAt());
    this.iconButton(tools, 'calendar-days', 'Open the main calendar', () => void this.plugin.openCalendar());

    const modes = header.createDiv({ cls: 'cn-agenda-modes', attr: { role: 'group', 'aria-label': 'Sidebar layout' } });
    for (const [mode, label] of [['day', 'Day'], ['list', 'List']] as const) {
      const button = modes.createEl('button', { text: label, attr: { type: 'button' } });
      button.addEventListener('click', () => this.setMode(mode));
      this.modeButtons.set(mode, button);
    }

    const strip = root.createDiv({ cls: 'cn-agenda-strip' });
    this.iconButton(strip, 'chevron-left', 'Previous week', () => this.select(addDays(this.selectedDay, -7, this.zone)));
    this.stripEl = strip.createDiv({ cls: 'cn-agenda-days', attr: { role: 'group', 'aria-label': 'Days of the week' } });
    this.iconButton(strip, 'chevron-right', 'Next week', () => this.select(addDays(this.selectedDay, 7, this.zone)));
    // A horizontal trackpad swipe over the strip pages a week, as on a phone.
    strip.addEventListener('wheel', event => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      this.wheelX += event.deltaX;
      if (Math.abs(this.wheelX) < 80) return;
      const weeks = this.wheelX > 0 ? 1 : -1;
      this.wheelX = 0;
      this.select(addDays(this.selectedDay, weeks * 7, this.zone));
    }, { passive: false });
    this.stripEl.addEventListener('keydown', event => {
      const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      if (!step) return;
      event.preventDefault();
      this.select(addDays(this.selectedDay, step, this.zone));
      this.stripEl?.querySelector<HTMLButtonElement>('.is-selected')?.focus();
    });

    this.dayTitleEl = root.createEl('button', { cls: 'cn-agenda-day-title', attr: { type: 'button' } });
    this.dayTitleEl.addEventListener('click', () => void this.openDaily(this.selectedDay));
    this.bodyEl = root.createDiv({ cls: 'cn-agenda-body' });

    // A sidebar opened, resized, or revealed after being collapsed recentres the current time.
    const resize = new ResizeObserver(() => this.layoutChanged());
    resize.observe(this.bodyEl);
    this.register(() => resize.disconnect());
    this.registerInterval(window.setInterval(() => this.tick(), 60_000));
    this.registerDomEvent(window, 'keydown', event => { if (event.key === 'Escape' && this.drag) this.cancelDrag(); });
    this.render();
  }

  async onClose(): Promise<void> {
    this.cancelDrag();
    this.plugin.releaseVisibleRange(this);
  }

  refresh(): void { this.render(); }
  settingsChanged(): void { this.rangeKey = ''; this.render(); }

  private iconButton(parent: HTMLElement, icon: string, label: string, click: () => void): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'clickable-icon', attr: { type: 'button', 'aria-label': label } });
    setIcon(button, icon);
    button.addEventListener('click', click);
    return button;
  }

  private setMode(mode: AgendaMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.scrollPending = true;
    this.render();
    this.app.workspace.requestSaveLayout();
  }

  private select(day: string): void {
    // Choosing today again (the Today button) scrolls back to the current time.
    if (day !== this.selectedDay || day === this.today()) this.scrollPending = true;
    this.selectedDay = day;
    this.render();
  }

  /** Follows the timeline into the previous or next day, keeping the hours on screen where they were. */
  private showAdjacentDay(offset: -1 | 1): void {
    const scrollTop = this.scrollEl?.scrollTop ?? 0;
    this.selectedDay = addDays(this.selectedDay, offset, this.zone);
    this.scrollPending = false;
    this.followNow = false;
    // The hours on screen keep their place: today's midnight sat below the previous day's preview.
    this.nextScrollTop = Math.max(0, scrollTop - this.preview.before * HOUR - offset * 24 * HOUR);
    this.render();
  }

  /** Today's timeline previews the neighbouring day once the centred current time nears midnight. */
  private wantedPreview(): Preview {
    if (this.mode !== 'day' || this.selectedDay !== this.today()) return { before: 0, after: 0 };
    const now = dateAt(new Date(), this.zone);
    const minute = now.hours() * 60 + now.minutes();
    const height = this.bodyEl?.clientHeight ?? 0;
    return { before: previousDayPreviewHours(minute, height, HOUR), after: nextDayPreviewHours(minute, height, HOUR) };
  }

  private layoutChanged(): void {
    if (this.mode !== 'day' || this.drag) return;
    if (!samePreview(this.wantedPreview(), this.preview)) this.render();
    else if (this.followNow) this.centerNow();
  }

  /** Scrolls today's timeline so the current time sits in the middle of the view. */
  private centerNow(): void {
    const scroll = this.scrollEl;
    const grid = scroll?.querySelector<HTMLElement>('.cn-agenda-grid');
    if (!scroll || !grid || this.mode !== 'day' || this.selectedDay !== this.today()) return;
    // A collapsed sidebar has no height yet; the resize observer centres it once shown.
    if (!scroll.clientHeight) return;
    const now = dateAt(new Date(), this.zone);
    const gridTop = grid.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
    scroll.scrollTop = centeredScrollTop(now.hours() * 60 + now.minutes(), scroll.clientHeight, gridTop + this.preview.before * HOUR, HOUR);
    this.autoScrollTop = scroll.scrollTop;
  }

  /** The minute tick moves the now line, and follows today past midnight when today was shown. */
  private tick(): void {
    const today = this.today();
    if (today !== this.renderedToday) {
      if (this.selectedDay === this.renderedToday) this.selectedDay = today;
      this.renderedToday = today;
      this.render();
      return;
    }
    if (this.mode === 'list' || !samePreview(this.wantedPreview(), this.preview)) { if (!this.drag) this.render(); return; }
    this.placeNowLine();
    if (this.followNow && !this.drag) this.centerNow();
  }

  private openDaily(day: string): Promise<unknown> {
    return this.plugin.runAction(() => this.plugin.notes.openDaily(day, this.actions.tabTarget));
  }

  /** Feeds are expanded over the shown week and the list's days. */
  private reportRange(days: string[]): void {
    const listEnd = addDays(this.selectedDay, AGENDA_LIST_DAYS - 1, this.zone);
    const from = days[0] < this.selectedDay ? days[0] : this.selectedDay;
    const until = days[6] > listEnd ? days[6] : listEnd;
    const range = dayRange(from, until, this.zone);
    const key = `${range.start}/${range.end}`;
    if (key === this.rangeKey) return;
    this.rangeKey = key;
    void this.plugin.onVisibleRange(range, this);
  }

  private render(): void {
    if (!this.bodyEl || !this.stripEl) return;
    const zone = this.zone;
    let selected;
    try { selected = dateAt(this.selectedDay, zone).locale('en'); }
    catch { this.selectedDay = this.today(); selected = dateAt(this.selectedDay, zone).locale('en'); }
    const today = this.today();
    const days = weekDays(this.selectedDay, this.firstDay(), zone);
    this.reportRange(days);

    this.headingTitleEl?.setText(selected.format('MMMM YYYY'));
    const week = weekInfo(this.selectedDay, resolveWeekRules(this.app, this.settings), zone);
    if (this.weekEl) {
      this.weekEl.setText(`W${week.number}`);
      this.weekEl.setAttribute('aria-label', `${week.label}, ${week.start} through ${week.end}. Open Weekly Note.`);
    }
    for (const [mode, button] of this.modeButtons) {
      button.toggleClass('is-active', mode === this.mode);
      button.setAttribute('aria-pressed', String(mode === this.mode));
    }

    const busy = daysWithEvents(this.shownEvents(), days, zone);
    this.stripEl.empty();
    for (const day of days) {
      const date = dateAt(day, zone).locale('en');
      const cell = this.stripEl.createEl('button', { cls: 'cn-agenda-day', attr: {
        type: 'button', 'aria-label': date.format('dddd, MMMM D'), 'aria-pressed': String(day === this.selectedDay),
        tabindex: day === this.selectedDay ? '0' : '-1',
      } });
      cell.createSpan({ cls: 'cn-agenda-day-name', text: date.format('dd') });
      cell.createSpan({ cls: 'cn-agenda-day-number', text: date.format('D') });
      cell.createSpan({ cls: 'cn-agenda-day-dot' });
      cell.toggleClass('is-today', day === today);
      cell.toggleClass('is-selected', day === this.selectedDay);
      cell.toggleClass('has-events', busy.has(day));
      cell.addEventListener('click', () => this.select(day));
    }

    if (this.dayTitleEl) {
      const relative = this.selectedDay === today ? 'Today · ' : this.selectedDay === addDays(today, 1, zone) ? 'Tomorrow · '
        : this.selectedDay === addDays(today, -1, zone) ? 'Yesterday · ' : '';
      this.dayTitleEl.setText(`${relative}${selected.format('dddd, MMMM D')}`);
      this.dayTitleEl.setAttribute('aria-label', `Open Daily Note for ${this.selectedDay}`);
      this.dayTitleEl.toggleClass('is-hidden', this.mode !== 'day');
    }

    const previousScroll = this.scrollEl?.scrollTop ?? 0;
    this.bodyEl.empty();
    this.nowEl = undefined;
    this.scrollEl = undefined;
    this.preview = { before: 0, after: 0 };
    if (this.mode === 'day') this.renderDay(previousScroll);
    else this.renderList(previousScroll);
  }

  private renderDay(previousScroll: number): void {
    const body = this.bodyEl!;
    const { allDay, timed } = eventsOnDay(this.shownEvents(), this.selectedDay, this.zone);
    if (allDay.length) {
      const row = body.createDiv({ cls: 'cn-agenda-allday' });
      row.createSpan({ cls: 'cn-agenda-allday-label', text: 'all-day' });
      const chips = row.createDiv({ cls: 'cn-agenda-allday-events' });
      for (const event of allDay) {
        const chip = chips.createDiv({ cls: 'cn-agenda-chip' });
        this.decorate(chip, event);
        chip.createSpan({ cls: 'cn-agenda-event-title', text: event.title });
      }
    }
    const scroll = body.createDiv({ cls: 'cn-agenda-scroll' });
    this.scrollEl = scroll;
    scroll.addEventListener('scroll', () => {
      // Any scroll the view did not make itself is the user's: stop keeping the current time centred.
      if (this.followNow && this.autoScrollTop !== undefined && Math.abs(scroll.scrollTop - this.autoScrollTop) > 1) this.followNow = false;
    }, { passive: true });
    const preview = this.wantedPreview();
    this.preview = preview;
    const dayTop = preview.before * HOUR;
    const grid = scroll.createDiv({ cls: 'cn-agenda-grid' });
    grid.style.height = `${(preview.before + 24 + preview.after) * HOUR}px`;
    for (let hour = 0; hour < 24; hour++) {
      const line = grid.createDiv({ cls: 'cn-agenda-hour' });
      line.style.top = `${dayTop + hour * HOUR}px`;
      line.dataset.minute = String(hour * 60);
      // With the previous day above it, midnight is a boundary worth labelling.
      line.toggleClass('is-midnight', hour === 0 && preview.before > 0);
      if (hour || preview.before) line.createSpan({ cls: 'cn-agenda-hour-label', text: `${String(hour).padStart(2, '0')}:00` });
    }
    const lane = grid.createDiv({ cls: 'cn-agenda-lane' });
    lane.style.top = `${dayTop}px`;
    lane.style.height = `${24 * HOUR}px`;
    lane.addEventListener('dblclick', event => {
      if (event.target !== lane) return;
      this.newEventAt(this.minuteAt(lane, event));
    });
    lane.addEventListener('contextmenu', event => {
      if (event.target !== lane) return;
      event.preventDefault();
      const minute = this.minuteAt(lane, event);
      const start = instantAt(this.selectedDay, minute, this.settings.snapMinutes, this.zone);
      const menu = new Menu();
      menu.addItem(item => item.setTitle(`New event at ${dateAt(start, this.zone).format('HH:mm')}`).setIcon('plus')
        .onClick(() => this.newEventAt(minute)));
      menu.addItem(item => item.setTitle('Open Daily Note').setIcon('calendar').onClick(() => void this.openDaily(this.selectedDay)));
      menu.showAtMouseEvent(event);
    });
    for (const placed of timed) this.renderBlock(lane, placed);
    if (preview.before) this.renderAdjacentDay(grid, -1, preview.before, 0);
    if (preview.after) this.renderAdjacentDay(grid, 1, preview.after, dayTop + 24 * HOUR);
    this.placeNowLine(grid);

    const isToday = this.selectedDay === this.today();
    if (this.nextScrollTop !== undefined) {
      const top = this.nextScrollTop;
      this.nextScrollTop = undefined;
      scroll.scrollTop = top;
    } else if (this.scrollPending) {
      this.scrollPending = false;
      this.followNow = isToday;
      if (isToday) this.centerNow();
      else {
        const first = timed.find(item => !item.continuesBefore)?.startMinute;
        scroll.scrollTop = Math.max(0, (first !== undefined ? first - 30 : 8 * 60) / 60 * HOUR);
      }
    } else if (this.followNow && isToday) {
      this.centerNow();
    } else {
      this.followNow = false;
      scroll.scrollTop = previousScroll;
    }
  }

  /**
   * The last hours of the previous day above today's midnight, or the first
   * hours of the next day below it, dimmed, so the current time can stay
   * centred around midnight. Clicking them shows that day.
   */
  private renderAdjacentDay(grid: HTMLElement, offset: -1 | 1, hours: number, top: number): void {
    const day = addDays(this.selectedDay, offset, this.zone);
    const date = dateAt(day, this.zone).locale('en');
    const name = offset > 0 ? 'Tomorrow' : 'Yesterday';
    // Wall-clock minutes of that day the preview covers.
    const from = offset > 0 ? 0 : (24 - hours) * 60;
    const until = from + hours * 60;
    const section = grid.createDiv({ cls: `cn-agenda-adjacent-day ${offset > 0 ? 'is-next' : 'is-previous'}`, attr: {
      role: 'button', tabindex: '0', 'aria-label': `Show ${name.toLowerCase()}, ${date.format('dddd, MMMM D')}`,
    } });
    section.style.top = `${top}px`;
    section.style.height = `${hours * HOUR}px`;
    for (let minute = from; minute < until; minute += 60) {
      const line = section.createDiv({ cls: 'cn-agenda-hour' });
      line.toggleClass('is-midnight', minute === 0);
      line.style.top = `${(minute - from) / 60 * HOUR}px`;
      // Minutes relative to the selected day's midnight, so the now line can hide a label it overlaps.
      line.dataset.minute = String(minute + offset * 24 * 60);
      line.createSpan({ cls: 'cn-agenda-hour-label', text: `${String(minute / 60).padStart(2, '0')}:00` });
    }
    section.createDiv({ cls: 'cn-agenda-adjacent-day-title', text: `${name} · ${date.format('ddd, MMM D')}` });
    const lane = section.createDiv({ cls: 'cn-agenda-lane' });
    for (const { event, startMinute, endMinute, column, columns } of eventsOnDay(this.shownEvents(), day, this.zone).timed) {
      const end = Math.max(endMinute, startMinute + AGENDA_MIN_BLOCK_MINUTES);
      if (startMinute >= until || end <= from) continue;
      const shownStart = Math.max(startMinute, from);
      const block = lane.createDiv({ cls: 'cn-agenda-event' });
      const color = this.settings.sources.find(source => source.id === event.sourceId)?.color;
      if (color) block.style.setProperty('--cn-event-color', color);
      block.style.top = `${(shownStart - from) / 60 * HOUR}px`;
      block.style.height = `${(Math.min(end, until) - shownStart) / 60 * HOUR - 2}px`;
      block.style.left = `calc(${column / columns * 100}% + 1px)`;
      block.style.width = `calc(${100 / columns}% - 3px)`;
      block.toggleClass('is-short', Math.min(endMinute, until) - shownStart < 45);
      block.createDiv({ cls: 'cn-agenda-event-title', text: event.title });
      block.createDiv({ cls: 'cn-agenda-event-time', text: eventTimeLabel(event, day, this.zone) });
    }
    section.addEventListener('click', () => this.showAdjacentDay(offset));
    section.addEventListener('keydown', key => {
      if (key.key !== 'Enter' && key.key !== ' ') return;
      key.preventDefault();
      this.showAdjacentDay(offset);
    });
  }

  private renderBlock(lane: HTMLElement, placed: PlacedEvent): void {
    const { event, startMinute, endMinute, column, columns } = placed;
    const block = lane.createDiv({ cls: 'cn-agenda-event' });
    const height = Math.max(endMinute - startMinute, AGENDA_MIN_BLOCK_MINUTES) / 60 * HOUR;
    block.style.top = `${startMinute / 60 * HOUR}px`;
    block.style.height = `${height - 2}px`;
    block.style.left = `calc(${column / columns * 100}% + 1px)`;
    block.style.width = `calc(${100 / columns}% - 3px)`;
    block.toggleClass('is-short', endMinute - startMinute < 45);
    block.toggleClass('continues-before', placed.continuesBefore);
    block.toggleClass('continues-after', placed.continuesAfter);
    this.decorate(block, event);
    block.createDiv({ cls: 'cn-agenda-event-title', text: event.title });
    const timeEl = block.createDiv({ cls: 'cn-agenda-event-time', text: eventTimeLabel(event, this.selectedDay, this.zone) });
    if (event.location?.trim()) block.createDiv({ cls: 'cn-agenda-event-location', text: event.location.trim() });
    block.addEventListener('pointerdown', down => this.startDrag(down, block, timeEl, placed, 'move'));
    if (!placed.continuesAfter && Date.parse(event.end) > Date.parse(event.start)) {
      const handle = block.createDiv({ cls: 'cn-agenda-resize', attr: { 'aria-hidden': 'true' } });
      handle.addEventListener('pointerdown', down => { down.stopPropagation(); this.startDrag(down, block, timeEl, placed, 'resize'); });
    }
  }

  private renderList(previousScroll: number): void {
    const scroll = this.bodyEl!.createDiv({ cls: 'cn-agenda-scroll cn-agenda-list' });
    this.scrollEl = scroll;
    const today = this.today();
    const now = Date.now();
    for (const { day, events } of agendaDays(this.shownEvents(), this.selectedDay, AGENDA_LIST_DAYS, this.zone)) {
      const section = scroll.createDiv({ cls: 'cn-agenda-list-day' });
      const date = dateAt(day, this.zone).locale('en');
      const head = section.createEl('button', { cls: 'cn-agenda-list-heading', attr: { type: 'button', 'aria-label': `Open Daily Note for ${day}` } });
      head.createSpan({ text: day === today ? `Today · ${date.format('ddd, MMM D')}` : date.format('dddd, MMM D') });
      head.toggleClass('is-today', day === today);
      head.addEventListener('click', () => void this.openDaily(day));
      if (!events.length) section.createDiv({ cls: 'cn-agenda-empty', text: 'No events' });
      for (const event of events) {
        const row = section.createDiv({ cls: 'cn-agenda-row' });
        this.decorate(row, event);
        row.toggleClass('is-past', !event.allDay && Date.parse(event.end) < now);
        row.createDiv({ cls: 'cn-agenda-row-time', text: eventTimeLabel(event, day, this.zone) });
        const main = row.createDiv({ cls: 'cn-agenda-row-main' });
        main.createDiv({ cls: 'cn-agenda-event-title', text: event.title });
        const meta = [event.location?.trim(), this.actions.calendarName(event)].filter(Boolean).join(' · ');
        main.createDiv({ cls: 'cn-agenda-row-meta', text: meta });
      }
    }
    scroll.scrollTop = this.scrollPending ? 0 : previousScroll;
    this.scrollPending = false;
  }

  /** Colour, keyboard access, and the click, hover preview and menu every event surface shares. */
  private decorate(el: HTMLElement, event: CalendarEvent): void {
    const color = this.settings.sources.find(source => source.id === event.sourceId)?.color;
    if (color) el.style.setProperty('--cn-event-color', color);
    el.addClass('cn-agenda-item');
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.dataset.eventId = event.id;
    const path = this.actions.notePath(event);
    if (!path) {
      const time = event.allDay ? 'All day' : eventTimeLabel(event, this.selectedDay, this.zone);
      setTooltip(el, [event.title, time, event.location?.trim()].filter(Boolean).join('\n'));
    }
    el.addEventListener('click', click => {
      click.preventDefault();
      if (Date.now() < this.suppressClickUntil) return;
      this.actions.click(event);
    });
    el.addEventListener('keydown', key => {
      if (key.key !== 'Enter' && key.key !== ' ') return;
      key.preventDefault();
      this.actions.click(event);
    });
    el.addEventListener('contextmenu', menuEvent => {
      menuEvent.preventDefault();
      menuEvent.stopPropagation();
      const menu = new Menu();
      this.actions.addEventItems(menu, event);
      menu.addSeparator();
      const day = event.allDay ? event.start.slice(0, 10) : dateAt(event.start, this.zone).format('YYYY-MM-DD');
      menu.addItem(item => item.setTitle('Open Daily Note').setIcon('calendar').onClick(() => void this.openDaily(day)));
      menu.showAtMouseEvent(menuEvent);
    });
    el.addEventListener('mouseover', hover => {
      const current = this.actions.notePath(event);
      if (!current || this.drag) return;
      this.app.workspace.trigger('hover-link', {
        event: hover, source: AGENDA_HOVER_SOURCE, hoverParent: this, targetEl: el, linktext: current, sourcePath: current,
      });
    });
  }

  private minuteAt(lane: HTMLElement, event: MouseEvent): number {
    return (event.clientY - lane.getBoundingClientRect().top) / HOUR * 60;
  }

  /** New event at `minute` on the selected day; without one, the next whole hour today or 09:00 on another day. */
  private newEventAt(minute?: number): void {
    const now = dateAt(new Date(), this.zone);
    const at = minute ?? (this.selectedDay === this.today() ? Math.min(23, now.hours() + 1) * 60 : 9 * 60);
    const start = instantAt(this.selectedDay, at, this.settings.snapMinutes, this.zone);
    this.actions.newEvent({ start, end: dateAt(start, this.zone).add(this.settings.defaultDurationMinutes, 'minutes').toISOString(), allDay: false });
  }

  private placeNowLine(grid = this.scrollEl?.querySelector<HTMLElement>('.cn-agenda-grid') ?? undefined): void {
    if (!grid || this.mode !== 'day') return;
    const hours = Array.from(grid.querySelectorAll<HTMLElement>('.cn-agenda-hour'));
    if (this.selectedDay !== this.today()) {
      this.nowEl?.remove(); this.nowEl = undefined;
      for (const hour of hours) hour.removeClass('is-near-now');
      return;
    }
    const now = dateAt(new Date(), this.zone);
    const minute = now.hours() * 60 + now.minutes();
    this.nowEl ??= grid.createDiv({ cls: 'cn-agenda-now', attr: { 'aria-hidden': 'true' } });
    this.nowEl.style.top = `${this.preview.before * HOUR + minute / 60 * HOUR}px`;
    this.nowEl.dataset.time = now.format('HH:mm');
    // The current time's label replaces an hour label it would overlap.
    for (const hour of hours) hour.toggleClass('is-near-now', Math.abs(Number(hour.dataset.minute) - minute) < 15);
  }

  private startDrag(down: PointerEvent, block: HTMLElement, timeEl: HTMLElement, placed: PlacedEvent, mode: DragState['mode']): void {
    if (down.button !== 0 || this.drag) return;
    this.drag = {
      pointerId: down.pointerId, block, timeEl, placed, mode, startY: down.clientY,
      top: parseFloat(block.style.top), height: parseFloat(block.style.height), minutes: 0, active: false,
    };
    block.setPointerCapture(down.pointerId);
    const move = (event: PointerEvent) => this.moveDrag(event);
    const up = (event: PointerEvent) => {
      block.removeEventListener('pointermove', move);
      block.removeEventListener('pointerup', up);
      block.removeEventListener('pointercancel', up);
      if (event.type === 'pointercancel') this.cancelDrag();
      else void this.finishDrag();
    };
    block.addEventListener('pointermove', move);
    block.addEventListener('pointerup', up);
    block.addEventListener('pointercancel', up);
  }

  private moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = event.clientY - drag.startY;
    if (!drag.active && Math.abs(dy) < DRAG_THRESHOLD) return;
    if (!drag.active) { drag.active = true; drag.block.addClass('is-dragging'); this.hoverPopover?.hoverEl.hide(); }
    const snap = this.settings.snapMinutes;
    drag.minutes = snappedMinutes(dy, HOUR, snap);
    const shift = drag.minutes / 60 * HOUR;
    if (drag.mode === 'move') drag.block.style.top = `${drag.top + shift}px`;
    else drag.block.style.height = `${Math.max(Math.max(15, snap) / 60 * HOUR - 2, drag.height + shift)}px`;
    const interval = draggedInterval(drag.placed.event, drag.minutes, drag.mode, Math.max(15, snap));
    drag.timeEl.setText(`${dateAt(interval.start, this.zone).format('HH:mm')}–${dateAt(interval.end, this.zone).format('HH:mm')}`);
  }

  private async finishDrag(): Promise<void> {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag?.active) return;
    // The pointerup that ends a drag also clicks the block; that click is not a request to open it.
    this.suppressClickUntil = Date.now() + 400;
    if (!drag.minutes) { this.render(); return; }
    const interval = draggedInterval(drag.placed.event, drag.minutes, drag.mode, Math.max(15, this.settings.snapMinutes));
    try { await this.plugin.reschedule(drag.placed.event, interval); }
    catch (error) { new Notice(error instanceof Error ? error.message : 'Could not reschedule event.'); }
    this.render();
  }

  private cancelDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (!drag) return;
    if (drag.block.hasPointerCapture(drag.pointerId)) drag.block.releasePointerCapture(drag.pointerId);
    if (drag.active) { this.suppressClickUntil = Date.now() + 400; this.render(); }
  }
}
