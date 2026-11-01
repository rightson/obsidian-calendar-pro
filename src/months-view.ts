import { ItemView, Keymap, TFile, type WorkspaceLeaf } from 'obsidian';
import type moment from 'moment-timezone';
import { dateAt, firstWeekday, weekInfo } from './date';
import { resolveWeekRules } from './settings';
import { dailyNotePath } from './paths';
import { miniMonthColumns } from './calendar-layout';
import { chooseMonthDensity, eventCountsByDay, MONTH_DENSITIES, monthSpanLabel, type MonthDensity } from './months-layout';
import { holidayDays, showsEvent } from './holidays';
import type { PluginSettings, WeekRules } from './types';
import type CalendarNotePlugin from './main';

export const MONTHS_VIEW_TYPE = 'calendar-pro-months';
const MAX_DOTS = 3;

/**
 * A compact month calendar meant for a sidebar. It starts at the chosen month
 * and keeps adding the following months while whole cards still fit its height.
 */
export class MonthsView extends ItemView {
  private monthsEl?: HTMLElement;
  private titleEl?: HTMLElement;
  private firstMonth = '';
  private resizeObserver?: ResizeObserver;
  private frame?: number;
  private lastSize = '';

  constructor(leaf: WorkspaceLeaf, private readonly plugin: CalendarNotePlugin) { super(leaf); }
  getViewType(): string { return MONTHS_VIEW_TYPE; }
  getDisplayText(): string { return 'Calendar Pro months'; }
  getIcon(): string { return 'calendar-range'; }
  private get settings(): PluginSettings { return this.plugin.store.state.settings; }
  private today(): string { return dateAt(new Date(), this.settings.timeZone).format('YYYY-MM-DD'); }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('cn-months-view');
    const heading = root.createDiv({ cls: 'cn-months-heading' });
    const prev = heading.createEl('button', { text: '‹', attr: { type: 'button', 'aria-label': 'Previous month' } });
    this.titleEl = heading.createEl('span', { cls: 'cn-months-title' });
    const today = heading.createEl('button', { text: 'Today', attr: { type: 'button', 'aria-label': 'Show this month first' } });
    const next = heading.createEl('button', { text: '›', attr: { type: 'button', 'aria-label': 'Next month' } });
    this.monthsEl = root.createDiv({ cls: 'cn-months' });
    this.firstMonth = this.thisMonth();
    prev.addEventListener('click', () => this.shift(-1));
    next.addEventListener('click', () => this.shift(1));
    today.addEventListener('click', () => { this.firstMonth = this.thisMonth(); this.render(); });
    // Scrolling pages through months, unless one tall card needs to scroll itself.
    let lastWheel = 0;
    this.monthsEl.addEventListener('wheel', event => {
      const el = this.monthsEl!;
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX) || el.scrollHeight > el.clientHeight + 1) return;
      event.preventDefault();
      if (Math.abs(event.deltaY) < 4 || event.timeStamp - lastWheel < 250) return;
      lastWheel = event.timeStamp;
      this.shift(event.deltaY > 0 ? 1 : -1);
    }, { passive: false });
    this.resizeObserver = new ResizeObserver(() => {
      const size = `${this.monthsEl?.clientWidth}x${this.monthsEl?.clientHeight}`;
      if (size === this.lastSize) return;
      this.lastSize = size;
      this.scheduleRender();
    });
    this.resizeObserver.observe(this.monthsEl);
    this.registerEvent(this.app.workspace.on('file-open', () => this.scheduleRender()));
    this.render();
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  /** Called by the plugin when events, notes, or settings change. */
  refresh(): void { this.scheduleRender(); }

  private thisMonth(): string { return dateAt(this.today(), this.settings.timeZone).startOf('month').format('YYYY-MM-DD'); }
  private shift(months: number): void {
    this.firstMonth = dateAt(this.firstMonth, this.settings.timeZone).add(months, 'months').format('YYYY-MM-DD');
    this.render();
  }
  private scheduleRender(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.render(); });
  }

  private render(): void {
    const container = this.monthsEl;
    if (!container || !this.firstMonth) return;
    const zone = this.settings.timeZone;
    const rules = resolveWeekRules(this.app, this.settings);
    const columns = miniMonthColumns(container.clientWidth);
    container.style.setProperty('--cn-months-columns', String(columns));
    const first = dateAt(this.firstMonth, zone).locale('en');
    const span = { from: first.clone().subtract(7, 'days').format('YYYY-MM-DD'), to: first.clone().add(25, 'months').format('YYYY-MM-DD') };
    const context = this.renderContext(rules, span);
    // Measure one real card at each size, keep the roomiest that shows enough
    // months, then add the following months while whole cards fit.
    const cards = MONTH_DENSITIES.map(density => {
      this.setDensity(container, density.name, density.gap);
      container.empty();
      return { height: this.renderMonth(container, first, context).getBoundingClientRect().height, gap: density.gap };
    });
    const { index, count } = chooseMonthDensity(container.clientHeight, cards, columns, this.settings.monthsMinimum);
    const density = MONTH_DENSITIES[index]!;
    this.setDensity(container, density.name, density.gap);
    container.empty();
    for (let month = 0; month < count; month++) this.renderMonth(container, first.clone().add(month, 'months'), context);
    this.titleEl?.setText(monthSpanLabel(this.firstMonth, count, zone));
    if (this.titleEl) this.titleEl.title = count === 1 ? 'Showing one month' : `Showing ${count} months`;
  }

  private setDensity(container: HTMLElement, name: MonthDensity, gap: number): void {
    for (const density of MONTH_DENSITIES) container.toggleClass(`is-${density.name}`, density.name === name);
    container.style.setProperty('--cn-months-gap', `${gap}px`);
  }

  private renderContext(rules: WeekRules, span: { from: string; to: string }) {
    const zone = this.settings.timeZone;
    const active = this.app.workspace.getActiveFile();
    return {
      rules,
      zone,
      firstDay: firstWeekday(rules, zone),
      today: this.today(),
      currentWeek: weekInfo(this.today(), rules, zone).start,
      activePath: active?.path,
      // Same events as the main calendar shows: holiday calendars set to hide their events add no dots.
      counts: eventCountsByDay(this.plugin.events.filter(event => showsEvent(event, this.settings.sources)), zone, span.from, span.to),
      // Holidays come from every cached event of holiday calendars, not only the main calendar's range.
      holidays: holidayDays(this.plugin.subscriptions?.getEvents({ start: new Date(0).toISOString(), end: new Date(8640000000000000).toISOString() })
        ?? this.plugin.events, this.settings.sources, zone),
    };
  }

  private renderMonth(parent: HTMLElement, month: moment.Moment, context: ReturnType<MonthsView['renderContext']>): HTMLElement {
    const { rules, zone, firstDay } = context;
    const card = parent.createDiv({ cls: 'cn-months-card' });
    const title = card.createEl('h3', { text: month.format('MMMM YYYY') });
    if (month.format('YYYY-MM') === context.today.slice(0, 7)) title.addClass('is-current-month');
    const table = card.createEl('table');
    const head = table.createEl('thead').createEl('tr');
    head.createEl('th', { text: 'Wk', cls: 'cn-months-week' });
    for (let d = 0; d < 7; d++) {
      const weekday = dateAt('2026-10-18', zone).add((firstDay + d) % 7, 'days').locale('en');
      head.createEl('th', { text: weekday.format('dd'), attr: { title: weekday.format('dddd') } });
    }
    const body = table.createEl('tbody');
    const start = month.clone().subtract((month.day() - firstDay + 7) % 7, 'days');
    const monthKey = month.format('YYYY-MM');
    // Always six rows, so every card has the same height and the fit stays stable.
    for (let row = 0; row < 6; row++) {
      const tr = body.createEl('tr');
      const rowStart = start.clone().add(row * 7, 'days').format('YYYY-MM-DD');
      const week = weekInfo(rowStart, rules, zone);
      const weekButton = tr.createEl('td', { cls: 'cn-months-week' }).createEl('button', {
        text: String(week.number), attr: { type: 'button', 'aria-label': `${week.label}, ${week.start} through ${week.end}. Open Weekly Note.` },
      });
      weekButton.title = weekButton.getAttribute('aria-label') ?? '';
      if (week.start === context.currentWeek) weekButton.addClass('is-current-week');
      weekButton.addEventListener('click', event => void this.openWeek(week.start, event));
      for (let col = 0; col < 7; col++) {
        const day = start.clone().add(row * 7 + col, 'days').format('YYYY-MM-DD');
        const td = tr.createEl('td');
        const outside = day.slice(0, 7) !== monthKey;
        if (outside) td.addClass('is-outside');
        const button = td.createEl('button', { cls: 'cn-months-day', attr: { type: 'button' } });
        button.createSpan({ text: String(Number(day.slice(-2))) });
        const count = context.counts.get(day) ?? 0;
        const label = [`Open Daily Note for ${day}`];
        if (count) label.push(`${count} ${count === 1 ? 'event' : 'events'}`);
        if (!outside) {
          const path = this.dailyPath(day);
          if (path && this.app.vault.getAbstractFileByPath(path) instanceof TFile) { button.addClass('has-note'); label.push('Daily Note exists'); }
          if (path && path === context.activePath) button.addClass('is-active');
        }
        const holiday = context.holidays.get(day);
        if (holiday) {
          button.addClass('is-holiday');
          if (holiday.color) button.style.setProperty('--cn-holiday-color', holiday.color);
          else button.addClass('is-holiday-unshaded');
          label.push(holiday.titles.join(', '));
        }
        button.setAttribute('aria-label', label.join('. '));
        button.title = label.join(' · ');
        const dots = button.createDiv({ cls: 'cn-months-dots' });
        for (let i = 0; i < Math.min(MAX_DOTS, count); i++) dots.createSpan({ cls: 'cn-months-dot' });
        if (day === context.today) button.addClass('is-today');
        button.addEventListener('click', event => void this.openDay(day, event));
      }
    }
    return card;
  }

  private dailyPath(day: string): string | undefined {
    try { return dailyNotePath(day, this.app, this.settings); } catch { return undefined; }
  }
  /** Plain click reuses the main-area note; Ctrl/Cmd-click opens a new tab, as in other note lists. */
  private target(event: MouseEvent): () => WorkspaceLeaf {
    const mode = Keymap.isModEvent(event);
    return () => this.app.workspace.getLeaf(mode || false);
  }
  private async openDay(day: string, event: MouseEvent): Promise<void> {
    await this.plugin.runAction(() => this.plugin.notes.openDaily(day, this.target(event)));
    this.scheduleRender();
  }
  private async openWeek(day: string, event: MouseEvent): Promise<void> {
    await this.plugin.runAction(() => this.plugin.notes.openWeekly(day, this.target(event)));
  }
}
