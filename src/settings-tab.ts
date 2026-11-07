import { Notice, PluginSettingTab, type App, type Setting, type SettingDefinition, type SettingDefinitionGroup, type SettingDefinitionItem, type SettingGroup, type ToggleComponent } from 'obsidian';
import moment from 'moment-timezone';
import type CalendarNotePlugin from './main';
import type { CalendarSource, PluginSettings } from './types';
import { isEventClickAction, isEventPropertiesDefault, isMainDateClickAction, isMiniDateClickAction, isMonthsMinimum, MONTHS_MINIMUM_MAX, resolveDailySettings, resolveWeeklySettings } from './settings';
import { dailyNotePath, eventNotePath, weeklyNotePath, folderPath } from './paths';
import { patchSubscription, subscriptionStatus } from './subscription-settings';
import { PROBLEM_LABELS, PROBLEM_ORDER } from './note-problems';
import { holidayOptions, isCalendarKind, isHolidayShade, type HolidayOptions } from './holidays';

const sample = { id: 'local|sample', sourceId: 'local', uid: 'sample', title: 'Sample event', start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00+08:00', allDay: false };
type TextSettingKey = 'eventPattern' | 'dailyFolder' | 'dailyFormat' | 'dailyTemplate'
  | 'weeklyFolder' | 'weeklyFormat' | 'weeklyTemplate' | 'locale' | 'timeZone' | 'ganttPeopleFolder';

const SOURCE_GROUP_CLASS = 'cn-source-settings';

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
  folderPath(settings.dailyFolder); folderPath(settings.weeklyFolder); folderPath(settings.ganttPeopleFolder);
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
  private samples = new Set<() => void>();
  private sourceGroups = new Map<string, SettingGroup>();
  private diagnostics = new Set<() => void>();
  // Rows are rendered while hidden, so visibility follows this count rather than the live scan.
  // Settings search reads visibility without rendering, so every scan has to set it too.
  private shownProblems = 0;
  constructor(app: App, private plugin: CalendarNotePlugin) { super(app, plugin); }

  // Reopening the tab reruns every render and visible callback but not this method, so
  // anything that can change has to be read inside those callbacks, not captured here.
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      { type: 'group', heading: 'Note paths', items: [
        this.text('Event Note pattern', 'Moment date tokens, {title}, {calendar}, and {uid}. Start with {daily}/ to use the folder of the event’s Daily Note, such as {daily}/{title}.', 'eventPattern'),
        this.live('Event Note sample', current => eventNotePath(sample, 'Local', this.app, current)),
        this.toggle('Move Event Notes when dates change', 'When an event moves to another date, move its Event Note to the folder the pattern gives for that date, such as the new Daily Note’s folder with {daily}. Notes you moved yourself stay put.', 'moveEventNotes'),
        this.dropdown('Event Note Properties', 'eventPropertiesDefault', [
          ['obsidian', 'Follow Obsidian'], ['collapsed', 'Collapsed'], ['expanded', 'Expanded'],
        ], 'Initial Properties state when an Event Note opens. You can toggle it in the note.'),
        this.live('Daily Notes provider', current => {
          const { provider } = resolveDailySettings(this.app, current);
          return provider === 'calendar-note' ? 'this plugin' : provider;
        }),
        this.text('Daily fallback folder', 'Used when core Daily Notes is disabled.', 'dailyFolder'),
        this.text('Daily fallback format', 'Moment date format; no event placeholders.', 'dailyFormat'),
        this.text('Daily fallback template', 'Vault-relative Markdown template path, optional.', 'dailyTemplate'),
        this.live('Daily Note sample', current => dailyNotePath('2026-10-23', this.app, current)),
        this.live('Weekly Notes provider', current => {
          const { provider } = resolveWeeklySettings(this.app, current);
          return provider === 'calendar-note' ? 'this plugin' : provider;
        }),
        this.text('Weekly fallback folder', 'Used when Calendar and Periodic Notes have no active weekly settings.', 'weeklyFolder'),
        this.text('Weekly fallback format', 'Moment locale week tokens: gggg and ww. ISO: GGGG and WW.', 'weeklyFormat'),
        this.text('Weekly fallback template', 'Vault-relative Markdown template path, optional.', 'weeklyTemplate'),
        this.live('Weekly Note sample', current => weeklyNotePath('2026-10-23', this.app, current)),
      ] },
      { type: 'group', heading: 'Calendar display', items: [
        this.dropdown('Week numbering', 'weekMode', [['calendar', 'Calendar locale'], ['iso', 'ISO 8601']]),
        this.dropdown('Week starts on', 'weekStart', [
          ['locale', 'Locale default'], ['sunday', 'Sunday'], ['monday', 'Monday'], ['tuesday', 'Tuesday'],
          ['wednesday', 'Wednesday'], ['thursday', 'Thursday'], ['friday', 'Friday'], ['saturday', 'Saturday'],
        ]),
        this.text('Date locale', 'For example en, en-gb, or zh-tw.', 'locale'),
        this.text('Display time zone', 'IANA zone, such as Asia/Taipei.', 'timeZone'),
        this.dropdown('Snap interval', 'snapMinutes', [['5', '5 minutes'], ['10', '10 minutes'], ['15', '15 minutes'], ['20', '20 minutes'], ['30', '30 minutes'], ['60', '60 minutes']]),
        this.number('Default event duration (minutes)', 'defaultDurationMinutes'),
        this.number('Custom view days', 'customDays'),
      ] },
      { type: 'group', heading: 'Clicking', items: [
        this.dropdown('Clicking a date in the mini calendar', 'miniDateClickAction', [
          ['navigate', 'Go to the date in the main calendar'],
          ['split', 'Go to the date and open its Daily Note beside the calendar'],
          ['tab', 'Go to the date and open its Daily Note in a new tab'],
        ], 'The calendar on the left. With the main calendar hidden, going to a date opens its Daily Note beside the calendar. Week numbers always open the Weekly Note.'),
        this.dropdown('Clicking an empty slot in the main calendar', 'mainDateClickAction', [
          ['auto', 'New event in Week and Day; Daily Note in Month and Year'],
          ['event', 'Always create a new event'],
          ['split', 'Open the Daily Note beside the calendar'],
          ['tab', 'Open the Daily Note in a new tab'],
          ['none', 'Do nothing'],
        ], 'A time slot or date cell with no event. A new event in Month or Year is all-day. Right-click still offers New event, and date headers and day numbers still open the Daily Note.'),
        this.dropdown('Clicking an event', 'eventClickAction', [
          ['dialog', 'Show event details'], ['split', 'Open Event Note beside the calendar'], ['tab', 'Open Event Note in a new tab'],
        ], 'In the main calendar. The event details dialog can still open the Event Note either way.'),
      ] },
      { type: 'group', heading: 'Month calendar', items: [
        this.toggle('Add to the right sidebar at startup', 'Only when the month calendar is not already open. Drag its tab to move it; it stays where you put it.', 'monthsOnStartup'),
        this.dropdown('Show at least', 'monthsMinimum',
          Array.from({ length: MONTHS_MINIMUM_MAX }, (_, i) => [String(i + 1), i ? `${i + 1} months` : '1 month'] as [string, string]),
          'In a short panel, month cards get smaller until this many months fit. A taller panel shows more at full size.'),
        { name: 'Place below the file explorer', desc: 'Moves the month calendar to the left sidebar, under the file explorer.', render: setting => {
          setting.addButton(button => button.setButtonText('Move').onClick(() => void this.plugin.openMonths('below-explorer')));
        } },
      ] },
      { type: 'group', heading: 'Events sidebar', items: [
        this.toggle('Keep the time of day when changing dates', 'Another date opens at the hours you were looking at. Turn it off to open each date at its first event (or 08:00). Today always opens at the current time.', 'agendaKeepTime'),
      ] },
      { type: 'group', heading: 'Gantt', items: [
        this.text('People folder', 'Where the + button next to a [[name]] assignee creates the person\'s note.', 'ganttPeopleFolder'),
        this.toggle('Preview the first change to each note', 'Show the change as a diff before the Gantt view first writes to a note in this session.', 'ganttConfirmWrites'),
      ] },
      { type: 'group', heading: 'Subscriptions', items: [this.number('Refresh interval (minutes)', 'syncIntervalMinutes')] },
      ...this.plugin.store.state.settings.sources.map(source => this.sourceGroup(source.id)),
      { type: 'group', items: [{ name: 'Add subscription', desc: 'Local events work without a calendar subscription. A blank URL stays inactive.', render: (setting, group) => {
        group.listEl.parentElement?.removeClass(SOURCE_GROUP_CLASS);
        setting.addButton(button => button.setButtonText('Add calendar').onClick(async () => {
          const id = crypto.randomUUID();
          await this.save(next => { next.sources.push({ id, name: 'New calendar', url: '', color: '#5885d8', enabled: false }); }, true);
        }));
      } }] },
      { type: 'group', heading: 'Event Note diagnostics', items: [
        { name: 'No invalid Event Notes found.', visible: () => !this.shownProblems },
        { name: 'Problems found', visible: () => !!this.shownProblems, render: setting => {
          setting.addButton(button => button.setButtonText('Review and fix…').setCta().onClick(() => this.plugin.showProblems()));
          return this.showDiagnostics(() => {
            const problems = this.plugin.notes.problems;
            const counts = PROBLEM_ORDER.map(kind => [PROBLEM_LABELS[kind], problems.filter(problem => problem.kind === kind).length] as const)
              .filter(([, count]) => count).map(([label, count]) => `${label}: ${count}`).join(' · ');
            this.shownProblems = problems.length;
            setting.setName(`${problems.length} ${problems.length === 1 ? 'problem' : 'problems'} found`)
              .setDesc(`${counts}. Compare the notes involved side by side and fix each one in place.`);
          });
        } },
        { name: 'Show as text', visible: () => !!this.shownProblems, render: setting => {
          setting.setName('');
          const details = setting.descEl.createEl('details', { cls: 'cn-diagnostics' });
          details.createEl('summary', { text: 'Show as text' });
          const list = details.createEl('ul');
          return this.showDiagnostics(() => {
            list.empty();
            for (const diagnostic of this.plugin.notes.diagnostics) list.createEl('li', { text: diagnostic });
          });
        } },
      ] },
    ];
  }

  refreshSubscriptionStatus(): void {
    for (const [id, element] of this.statusElements) this.showStatus(id, element);
  }

  refreshDiagnostics(): void {
    this.shownProblems = this.plugin.notes.problems.length;
    for (const update of this.diagnostics) update();
    this.refreshDomState();
  }

  private showDiagnostics(update: () => void): () => void {
    update();
    this.diagnostics.add(update);
    return () => { this.diagnostics.delete(update); };
  }

  private showStatus(id: string, element: HTMLElement): void {
    const source = this.plugin.store.state.settings.sources.find(item => item.id === id);
    if (!source) return;
    const count = this.plugin.getVisibleRange()
      ? this.plugin.events.filter(event => event.sourceId === id && event.status !== 'cancelled' && event.status !== 'removed').length
      : undefined;
    element.setText(subscriptionStatus(source, this.plugin.store.state.sourceCaches[id], count));
  }

  /** A read-only row whose description follows the settings. */
  private live(name: string, text: (settings: PluginSettings) => string): SettingDefinition {
    return { name, render: setting => {
      const update = () => { setting.setDesc(text(this.plugin.store.state.settings)); };
      update();
      this.samples.add(update);
      return () => { this.samples.delete(update); };
    } };
  }

  // Only adding or removing a subscription changes the page structure; every other edit
  // updates in place so focus, typed input, and scroll position survive the save.
  private async save(change: (settings: PluginSettings) => void, redraw = false): Promise<boolean> {
    try {
      await this.plugin.updateSettings(change, next => { validatePluginSettings(this.app, next); });
      if (redraw) this.update();
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
  private text(name: string, desc: string, key: TextSettingKey): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addText(input => {
        input.setValue(this.plugin.store.state.settings[key]);
        input.inputEl.addEventListener('blur', () => {
          const value = input.getValue().trim();
          if (value === this.plugin.store.state.settings[key]) return;
          void this.save(next => { (next as unknown as Record<string, unknown>)[key] = value; });
        });
        input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
      });
    } };
  }
  private toggle(name: string, desc: string, key: 'moveEventNotes' | 'monthsOnStartup' | 'agendaKeepTime' | 'ganttConfirmWrites'): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addToggle(toggle => {
        toggle.setValue(this.plugin.store.state.settings[key]).onChange(value => {
          void this.save(next => { next[key] = value; });
        });
      });
    } };
  }
  private number(name: string, key: 'defaultDurationMinutes' | 'syncIntervalMinutes' | 'customDays'): SettingDefinition {
    return { name, render: setting => {
      setting.addText(input => {
        input.inputEl.type = 'number'; input.inputEl.min = '1'; input.inputEl.step = '1';
        input.setValue(String(this.plugin.store.state.settings[key]));
        input.inputEl.addEventListener('blur', () => {
          const value = Number(input.getValue());
          if (value === this.plugin.store.state.settings[key]) return;
          void this.save(next => { next[key] = value; });
        });
        input.inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') input.inputEl.blur(); });
      });
    } };
  }
  private dropdown(name: string, key: 'weekMode' | 'weekStart' | 'snapMinutes' | 'eventPropertiesDefault' | 'eventClickAction' | 'miniDateClickAction' | 'mainDateClickAction' | 'monthsMinimum', values: [string, string][], desc?: string): SettingDefinition {
    return { name, desc, render: setting => {
      setting.addDropdown(select => {
        for (const [value, label] of values) select.addOption(value, label);
        select.setValue(String(this.plugin.store.state.settings[key]));
        select.onChange(value => {
          void this.save(next => { (next as unknown as Record<string, unknown>)[key] = key === 'snapMinutes' || key === 'monthsMinimum' ? Number(value) : value; });
        });
      });
    } };
  }
  /** Holiday options appear only for holiday calendars, and the color only for a custom background. */
  private sourceGroup(id: string): SettingDefinitionGroup {
    const current = () => this.plugin.store.state.settings.sources.find(item => item.id === id);
    let enabledToggle: ToggleComponent | undefined;
    let syncingToggle = false;
    let currentUrl = () => current()?.url ?? '';
    // A holiday choice shows at once; this holds it until the save reaches the store.
    let draft: Partial<CalendarSource> = {};
    const update = async (patch: Partial<CalendarSource>) => {
      const saved = await this.save(next => { patchSubscription(next, id, patch); });
      if (saved && patch.name !== undefined) this.sourceGroups.get(id)?.setHeading(patch.name);
      const latest = current();
      if (latest && enabledToggle && enabledToggle.getValue() !== latest.enabled) {
        syncingToggle = true;
        try { enabledToggle.setValue(latest.enabled); }
        finally { syncingToggle = false; }
      }
    };
    const choose = (patch: Partial<CalendarSource>) => {
      const choice = draft = { ...draft, ...patch };
      this.refreshDomState();
      void update(patch).then(() => {
        if (draft === choice) draft = {};
        this.refreshDomState();
      });
    };
    const row = (name: string, desc: string | undefined, build: (setting: Setting, source: CalendarSource, group: SettingGroup) => void | (() => void), shown: (options: HolidayOptions) => boolean = () => true): SettingDefinition => ({
      name, desc,
      visible: () => {
        const source = current();
        return !!source && shown(holidayOptions({ ...source, ...draft }));
      },
      render: (setting, settingGroup) => {
        const source = current();
        return source ? build(setting, source, settingGroup) : undefined;
      },
    });
    const holiday = (options: HolidayOptions) => options.kind === 'holidays';
    return { type: 'group', cls: SOURCE_GROUP_CLASS, items: [
      row('Name', undefined, (setting, source, settingGroup) => {
        // Group keys are positions, so adding a subscription can reuse a group built without cls.
        settingGroup.addClass(SOURCE_GROUP_CLASS).setHeading(source.name);
        this.sourceGroups.set(id, settingGroup);
        setting.addText(input => {
          input.setValue(source.name);
          input.inputEl.addEventListener('blur', () => void update({ name: input.getValue().trim() }));
        });
        return () => { if (this.sourceGroups.get(id) === settingGroup) this.sourceGroups.delete(id); };
      }),
      row('Subscription URL', 'HTTPS or webcal. Stored privately in plugin data.', (setting, source) => {
        setting.addText(input => {
          input.setPlaceholder('https://example.com/calendar.ics').setValue(source.url);
          currentUrl = () => input.getValue().trim();
          input.inputEl.addEventListener('blur', () => void update({ url: input.getValue().trim() }));
        });
      }),
      row('Color', undefined, (setting, source) => {
        setting.addColorPicker(picker => picker.setValue(source.color).onChange(value => void update({ color: value })));
      }),
      row('Calendar type', 'A holiday calendar marks the days its events cover, in the main calendar and the mini calendar.', (setting, source) => {
        setting.addDropdown(select => select.addOption('events', 'Events').addOption('holidays', 'Holidays').setValue(holidayOptions(source).kind).onChange(value => {
          if (isCalendarKind(value)) choose({ kind: value });
        }));
      }),
      row('Holiday background', 'Background for holiday dates. Gray follows the theme.', (setting, source) => {
        setting.addDropdown(select => select.addOption('gray', 'Gray').addOption('custom', 'Custom color').addOption('none', 'None').setValue(holidayOptions(source).shade).onChange(value => {
          if (isHolidayShade(value)) choose({ holidayShade: value });
        }));
      }, holiday),
      row('Holiday background color', undefined, (setting, source) => {
        setting.addColorPicker(picker => picker.setValue(holidayOptions(source).color).onChange(value => void update({ holidayColor: value })));
      }, options => holiday(options) && options.shade === 'custom'),
      row('Show holiday names', 'Show the holidays as events. When off, holiday dates keep their background and the mini calendar names them on hover.', (setting, source) => {
        setting.addToggle(toggle => toggle.setValue(holidayOptions(source).showEvents).onChange(value => void update({ showHolidayEvents: value })));
      }, holiday),
      row('Enabled', undefined, (setting, source) => {
        setting.addToggle(toggle => {
          enabledToggle = toggle;
          toggle.setValue(source.enabled).onChange(value => {
            if (!syncingToggle) void update({ url: currentUrl(), enabled: value });
          });
        });
      }),
      row('Remove subscription', 'Existing Event Notes remain in the Vault and are reused if you add the same calendar again.', setting => {
        setting.addButton(button => button.setButtonText('Remove').onClick(() => {
          void this.save(next => { next.sources = next.sources.filter(item => item.id !== id); }, true);
        }));
      }),
      row('Status', undefined, setting => {
        const element = setting.descEl;
        this.statusElements.set(id, element);
        this.showStatus(id, element);
        // A removed row's cleanup runs after its replacement rendered, possibly for this same id.
        return () => { if (this.statusElements.get(id) === element) this.statusElements.delete(id); };
      }),
    ] };
  }
}
