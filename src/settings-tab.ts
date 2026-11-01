import { Notice, PluginSettingTab, Setting, type App, type ToggleComponent } from 'obsidian';
import moment from 'moment-timezone';
import type CalendarNotePlugin from './main';
import type { CalendarSource, PluginSettings } from './types';
import { isEventClickAction, isEventPropertiesDefault, isMainDateClickAction, isMiniDateClickAction, isMonthsMinimum, MONTHS_MINIMUM_MAX, resolveDailySettings, resolveWeeklySettings } from './settings';
import { dailyNotePath, eventNotePath, weeklyNotePath, folderPath } from './paths';
import { patchSubscription, subscriptionStatus } from './subscription-settings';
import { PROBLEM_LABELS, PROBLEM_ORDER } from './note-problems';
import { holidayOptions, isCalendarKind, isHolidayShade } from './holidays';

const sample = { id: 'local|sample', sourceId: 'local', uid: 'sample', title: 'Sample event', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00+08:00', allDay: false };
type TextSettingKey = 'eventPattern' | 'dailyFolder' | 'dailyFormat' | 'dailyTemplate'
  | 'weeklyFolder' | 'weeklyFormat' | 'weeklyTemplate' | 'locale' | 'timeZone';

export function validatePluginSettings(app: App, settings: PluginSettings): { event: string; daily: string; weekly: string } {
  if (!moment.tz.zone(settings.timeZone)) throw new Error('Enter a valid IANA time zone.');
  if (![5, 10, 15, 20, 30, 60].includes(settings.snapMinutes)) throw new Error('Choose a valid snap interval.');
  if (!Number.isInteger(settings.defaultDurationMinutes) || settings.defaultDurationMinutes < 15 || settings.defaultDurationMinutes > 1440) throw new Error('Default duration must be 15–1440 minutes.');
  if (!Number.isInteger(settings.syncIntervalMinutes) || settings.syncIntervalMinutes < 1 || settings.syncIntervalMinutes > 1440) throw new Error('Sync interval must be 1–1440 minutes.');
  if (!Number.isInteger(settings.customDays) || settings.customDays < 2 || settings.customDays > 14) throw new Error('Custom days must be 2–14.');
  if (!isEventPropertiesDefault(settings.eventPropertiesDefault)) throw new Error('Choose a valid Event Note Properties default.');
  if (!isEventClickAction(settings.eventClickAction)) throw new Error('Choose a valid event click action.');
  if (!isMiniDateClickAction(settings.miniDateClickAction)) throw new Error('Choose a valid mini calendar click action.');
  if (!isMainDateClickAction(settings.mainDateClickAction)) throw new Error('Choose a valid main calendar click action.');
  if (!isMonthsMinimum(settings.monthsMinimum)) throw new Error(`Show at least 1–${MONTHS_MINIMUM_MAX} months.`);
  folderPath(settings.dailyFolder); folderPath(settings.weeklyFolder);
  const event = eventNotePath(sample, 'Local', app, settings);
  const daily = dailyNotePath('2026-10-23', app, settings);
  const weekly = weeklyNotePath('2026-10-23', app, settings);
  const normalized = [event, daily, weekly].map(path => path.normalize('NFC').toLocaleLowerCase('en-US'));
  if (new Set(normalized).size !== 3) throw new Error('Event, Daily, and Weekly Note paths collide for the sample date.');
  const seen = new Set<string>();
  for (const source of settings.sources) {
    if (!source.name.trim()) throw new Error('Every subscription needs a name.');
    if (!source.url.trim()) continue;
    let parsed: URL;
    try { parsed = new URL(source.url.trim()); } catch { throw new Error('Enter a valid HTTPS or webcal subscription URL.'); }
    if (!['https:', 'webcal:'].includes(parsed.protocol)) throw new Error('Use an HTTPS or webcal subscription URL.');
    if (seen.has(source.id)) throw new Error('Duplicate subscription identity.');
    if (source.kind !== undefined && !isCalendarKind(source.kind)) throw new Error('Choose a valid calendar type.');
    if (source.holidayShade !== undefined && !isHolidayShade(source.holidayShade)) throw new Error('Choose a valid holiday background.');
    seen.add(source.id);
  }
  return { event, daily, weekly };
}

export class CalendarNoteSettingTab extends PluginSettingTab {
  private statusElements = new Map<string, HTMLElement>();
  private samples: (() => void)[] = [];
  constructor(app: App, private plugin: CalendarNotePlugin) { super(app, plugin); }
  display(): void {
    const root = this.containerEl;
    // Emptying collapses the scroll height, which would snap the page back to the top.
    const scrollTop = root.scrollTop;
    root.empty();
    this.statusElements.clear();
    this.samples = [];
    const settings = this.plugin.store.state.settings;
    root.createEl('p', { text: 'Local events work without a calendar subscription.' });
    new Setting(root).setName('Note paths').setHeading();
    this.text(root, 'Event Note pattern', 'Moment date tokens, {title}, {calendar}, and {uid}. Start with {daily}/ to use the folder of the event’s Daily Note, such as {daily}/{title}.', 'eventPattern');
    this.sample(root, current => eventNotePath(sample, 'Local', this.app, current));
    this.toggle(root, 'Move Event Notes when dates change', 'When an event moves to another date, move its Event Note to the folder the pattern gives for that date, such as the new Daily Note’s folder with {daily}. Notes you moved yourself stay put.', 'moveEventNotes');
    this.dropdown(root, 'Event Note Properties', 'eventPropertiesDefault', [
      ['obsidian', 'Follow Obsidian'], ['collapsed', 'Collapsed'], ['expanded', 'Expanded'],
    ], 'Initial Properties state when an Event Note opens. You can toggle it in the note.');
    const daily = resolveDailySettings(this.app, settings);
    root.createEl('p', { text: `Daily Notes provider: ${daily.provider === 'calendar-note' ? 'Calendar Pro' : daily.provider}`, cls: 'setting-item-description' });
    this.text(root, 'Daily fallback folder', 'Used when core Daily Notes is disabled.', 'dailyFolder');
    this.text(root, 'Daily fallback format', 'Moment date format; no event placeholders.', 'dailyFormat');
    this.text(root, 'Daily fallback template', 'Vault-relative Markdown template path, optional.', 'dailyTemplate');
    this.sample(root, current => dailyNotePath('2026-10-23', this.app, current));
    const weekly = resolveWeeklySettings(this.app, settings);
    root.createEl('p', { text: `Weekly Notes provider: ${weekly.provider === 'calendar-note' ? 'Calendar Pro' : weekly.provider}`, cls: 'setting-item-description' });
    this.text(root, 'Weekly fallback folder', 'Used when Calendar and Periodic Notes have no active weekly settings.', 'weeklyFolder');
    this.text(root, 'Weekly fallback format', 'Moment locale week tokens: gggg and ww. ISO: GGGG and WW.', 'weeklyFormat');
    this.text(root, 'Weekly fallback template', 'Vault-relative Markdown template path, optional.', 'weeklyTemplate');
    this.sample(root, current => weeklyNotePath('2026-10-23', this.app, current));
    new Setting(root).setName('Calendar display').setHeading();
    this.dropdown(root, 'Week numbering', 'weekMode', [['calendar', 'Calendar locale'], ['iso', 'ISO 8601']]);
    this.dropdown(root, 'Week starts on', 'weekStart', [
      ['locale', 'Locale default'], ['sunday', 'Sunday'], ['monday', 'Monday'], ['tuesday', 'Tuesday'],
      ['wednesday', 'Wednesday'], ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
    ]);
    this.text(root, 'Date locale', 'For example en, en-gb, or zh-tw.', 'locale');
    this.text(root, 'Display time zone', 'IANA zone, such as Asia/Taipei.', 'timeZone');
    this.dropdown(root, 'Snap interval', 'snapMinutes', [['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]);
    this.number(root, 'Default event duration (minutes)', 'defaultDurationMinutes');
    this.number(root, 'Custom view days', 'customDays');
    new Setting(root).setName('Clicking').setHeading();
    this.dropdown(root, 'Clicking a date in the mini calendar', 'miniDateClickAction', [
      ['navigate', 'Go to the date in the main calendar'],
      ['split', 'Go to the date and open its Daily Note beside the calendar'],
      ['tab', 'Go to the date and open its Daily Note in a new tab'],
    ], 'The calendar on the left. With the main calendar hidden, going to a date opens its Daily Note beside the calendar. Week numbers always open the Weekly Note.');
    this.dropdown(root, 'Clicking an empty slot in the main calendar', 'mainDateClickAction', [
      ['auto', 'New event in Week and Day; Daily Note in Month and Year'],
      ['event', 'Always create a new event'],
      ['split', 'Open the Daily Note beside the calendar'],
      ['tab', 'Open the Daily Note in a new tab'],
      ['none', 'Do nothing'],
    ], 'A time slot or date cell with no event. A new event in Month or Year is all-day. Right-click still offers New event, and date headers and day numbers still open the Daily Note.');
    this.dropdown(root, 'Clicking an event', 'eventClickAction', [
      ['dialog', 'Show event details'], ['split', 'Open Event Note beside the calendar'], ['tab', 'Open Event Note in a new tab'],
    ], 'In the main calendar. The event details dialog can still open the Event Note either way.');
    new Setting(root).setName('Month calendar').setHeading();
    new Setting(root).setName('Add to the right sidebar at startup')
      .setDesc('Only when the month calendar is not already open. Drag its tab to move it; it stays where you put it.')
      .addToggle(toggle => toggle.setValue(settings.monthsOnStartup).onChange(value => void this.save(next => { next.monthsOnStartup = value; })));
    this.dropdown(root, 'Show at least', 'monthsMinimum',
      Array.from({ length: MONTHS_MINIMUM_MAX }, (_, i) => [String(i + 1), i ? `${i + 1} months` : '1 month'] as [string, string]),
      'In a short panel, month cards get smaller until this many months fit. A taller panel shows more at full size.');
    new Setting(root).setName('Place below the file explorer')
      .setDesc('Moves the month calendar to the left sidebar, under the file explorer.')
      .addButton(button => button.setButtonText('Move').onClick(() => void this.plugin.openMonths('below-explorer')));
    new Setting(root).setName('Subscriptions').setHeading();
    this.number(root, 'Refresh interval (minutes)', 'syncIntervalMinutes');
    for (const source of settings.sources) this.sourceSetting(root, source);
    new Setting(root).setName('Add subscription').setDesc('A blank URL stays inactive.').addButton(button => button.setButtonText('Add calendar').onClick(async () => {
      const id = crypto.randomUUID();
      await this.save(next => { next.sources.push({ id, name: 'New calendar', url: '', color: '#5885d8', enabled: false }); }, true);
    }));
    new Setting(root).setName('Event Note diagnostics').setHeading();
    const problems = this.plugin.notes.problems;
    if (!problems.length) root.createEl('p', { text: 'No invalid Event Notes found.', cls: 'setting-item-description' });
    else {
      const counts = PROBLEM_ORDER.map(kind => [PROBLEM_LABELS[kind], problems.filter(problem => problem.kind === kind).length] as const)
        .filter(([, count]) => count).map(([label, count]) => `${label}: ${count}`).join(' · ');
      new Setting(root).setName(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} found`)
        .setDesc(`${counts}. Compare the notes involved side by side and fix each one in place.`)
        .addButton(button => button.setButtonText('Review and fix…').setCta().onClick(() => this.plugin.showProblems()));
      const details = root.createEl('details', { cls: 'cn-diagnostics' });
      details.createEl('summary', { text: 'Show as text', cls: 'setting-item-description' });
      const list = details.createEl('ul');
      for (const diagnostic of this.plugin.notes.diagnostics) list.createEl('li', { text: diagnostic });
    }
    this.refreshSubscriptionStatus();
    root.scrollTop = scrollTop;
  }

  hide(): void {
    this.statusElements.clear();
    this.samples = [];
    super.hide();
  }

  refreshSubscriptionStatus(): void {
    for (const [id, element] of this.statusElements) {
      const source = this.plugin.store.state.settings.sources.find(item => item.id === id);
      if (!source) continue;
      const count = this.plugin.getVisibleRange()
        ? this.plugin.events.filter(event => event.sourceId === id && event.status !== 'cancelled' && event.status !== 'removed').length
        : undefined;
      element.setText(subscriptionStatus(source, this.plugin.store.state.sourceCaches[id], count));
    }
  }

  private sample(root: HTMLElement, path: (settings: PluginSettings) => string): void {
    const element = root.createEl('p', { cls: 'setting-item-description' });
    const update = () => element.setText('Sample: ' + path(this.plugin.store.state.settings));
    update();
    this.samples.push(update);
  }

  // Only adding or removing a subscription changes the page structure; every other edit
  // updates in place so focus, typed input, and scroll position survive the save.
  private async save(change: (settings: PluginSettings) => void, redraw = false): Promise<boolean> {
    try {
      await this.plugin.updateSettings(change, next => { validatePluginSettings(this.app, next); });
      if (redraw) this.display();
      else {
        for (const update of this.samples) update();
        this.refreshSubscriptionStatus();
      }
      return true;
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not save settings.');
      return false;
    }
  }
  private text(root: HTMLElement, name: string, description: string, key: TextSettingKey): void {
    new Setting(root).setName(name).setDesc(description).addText(input => {
      input.setValue(this.plugin.store.state.settings[key]);
      input.inputEl.addEventListener('blur', () => {
        const value = input.getValue().trim();
        if (value === this.plugin.store.state.settings[key]) return;
        void this.save(next => { (next as unknown as Record<string, unknown>)[key] = value; });
      });
      input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
    });
  }
  private toggle(root: HTMLElement, name: string, description: string, key: 'moveEventNotes'): void {
    new Setting(root).setName(name).setDesc(description).addToggle(toggle => {
      toggle.setValue(this.plugin.store.state.settings[key]).onChange(value => {
        void this.save(next => { next[key] = value; });
      });
    });
  }
  private number(root: HTMLElement, name: string, key: 'defaultDurationMinutes' | 'syncIntervalMinutes' | 'customDays'): void {
    new Setting(root).setName(name).addText(input => {
      input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.step = '1';
      input.setValue(String(this.plugin.store.state.settings[key]));
      input.inputEl.addEventListener('blur', () => {
        const value = Number(input.getValue());
        if (value === this.plugin.store.state.settings[key]) return;
        void this.save(next => { next[key] = value; });
      });
      input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
    });
  }
  private dropdown(root: HTMLElement, name: string, key: 'weekMode' | 'weekStart' | 'snapMinutes' | 'eventPropertiesDefault' | 'eventClickAction' | 'miniDateClickAction' | 'mainDateClickAction' | 'monthsMinimum', values: [string, string][], description?: string): void {
    const setting = new Setting(root).setName(name);
    if (description) setting.setDesc(description);
    setting.addDropdown(select => {
      for (const [value, label] of values) select.addOption(value, label);
      select.setValue(String(this.plugin.store.state.settings[key]));
      select.onChange(value => {
        void this.save(next => { (next as unknown as Record<string, unknown>)[key] = key === 'snapMinutes' || key === 'monthsMinimum' ? Number(value) : value; });
      });
    });
  }
  private sourceSetting(root: HTMLElement, source: CalendarSource): void {
    const section = root.createDiv({ cls: 'cn-source-settings' });
    const heading = new Setting(section).setName(source.name).setHeading();
    let enabledToggle: ToggleComponent | undefined;
    let syncingToggle = false;
    const update = (patch: Partial<CalendarSource>) => {
      void this.save(next => { patchSubscription(next, source.id, patch); }).then(saved => {
        if (saved && patch.name !== undefined) heading.setName(patch.name);
        const latest = this.plugin.store.state.settings.sources.find(item => item.id === source.id);
        if (latest && enabledToggle && enabledToggle.getValue() !== latest.enabled) {
          syncingToggle = true;
          try { enabledToggle.setValue(latest.enabled); }
          finally { syncingToggle = false; }
        }
      });
    };
    new Setting(section).setName('Name').addText(input => {
      input.setValue(source.name);
      input.inputEl.addEventListener('blur', () => update({ name: input.getValue().trim() }));
    });
    let currentUrl = () => source.url;
    new Setting(section).setName('Subscription URL').setDesc('HTTPS or webcal. Stored privately in plugin data.').addText(input => {
      input.setPlaceholder('https://example.com/calendar.ics').setValue(source.url);
      currentUrl = () => input.getValue().trim();
      input.inputEl.addEventListener('blur', () => update({ url: input.getValue().trim() }));
    });
    new Setting(section).setName('Color').addColorPicker(picker => picker.setValue(source.color).onChange(value => update({ color: value })));
    this.holidaySettings(section, source, update);
    new Setting(section).setName('Enabled').addToggle(toggle => {
      enabledToggle = toggle;
      toggle.setValue(source.enabled).onChange(value => {
        if (!syncingToggle) update({ url: currentUrl(), enabled: value });
      });
    });
    new Setting(section).setName('Remove subscription').setDesc('Existing Event Notes remain in the Vault and are reused if you add the same calendar again.').addButton(button => button.setButtonText('Remove').onClick(() => {
      void this.save(next => { next.sources = next.sources.filter(item => item.id !== source.id); }, true);
    }));
    this.statusElements.set(source.id, section.createEl('p', { cls: 'setting-item-description' }));
  }
  /** Holiday options appear only for holiday calendars, and the color only for a custom background. */
  private holidaySettings(section: HTMLElement, source: CalendarSource, update: (patch: Partial<CalendarSource>) => void): void {
    const initial = holidayOptions(source);
    let kind = initial.kind;
    let shade = initial.shade;
    const holidayOnly: HTMLElement[] = [];
    let colorSetting: Setting | undefined;
    const sync = () => {
      for (const element of holidayOnly) element.toggle(kind === 'holidays');
      colorSetting?.settingEl.toggle(kind === 'holidays' && shade === 'custom');
    };
    new Setting(section).setName('Calendar type')
      .setDesc('A holiday calendar marks the days its events cover, in the main calendar and the mini calendar.')
      .addDropdown(select => select.addOption('events', 'Events').addOption('holidays', 'Holidays').setValue(kind).onChange(value => {
        if (!isCalendarKind(value)) return;
        kind = value; sync(); update({ kind: value });
      }));
    const shadeSetting = new Setting(section).setName('Holiday background')
      .setDesc('Background for holiday dates. Gray follows the theme.')
      .addDropdown(select => select.addOption('gray', 'Gray').addOption('custom', 'Custom color').addOption('none', 'None').setValue(shade).onChange(value => {
        if (!isHolidayShade(value)) return;
        shade = value; sync(); update({ holidayShade: value });
      }));
    holidayOnly.push(shadeSetting.settingEl);
    colorSetting = new Setting(section).setName('Holiday background color')
      .addColorPicker(picker => picker.setValue(initial.color).onChange(value => update({ holidayColor: value })));
    const showSetting = new Setting(section).setName('Show holiday names')
      .setDesc('Show the holidays as events. When off, holiday dates keep their background and the mini calendar names them on hover.')
      .addToggle(toggle => toggle.setValue(initial.showEvents).onChange(value => update({ showHolidayEvents: value })));
    holidayOnly.push(showSetting.settingEl);
    sync();
  }
}
