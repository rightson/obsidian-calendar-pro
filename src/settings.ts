import type { App } from 'obsidian';
import type { EventClickAction, EventPropertiesDefault, MainDateClickAction, MiniDateClickAction, PluginSettings, ResolvedNoteSettings, WeekRules, WeekStart } from './types';
import { normalizeSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from './sidebar-layout';

export const DEFAULT_SETTINGS: PluginSettings = {
  sources: [],
  eventPattern: '[Calendar Notes]/{title}',
  moveEventNotes: true,
  eventPropertiesDefault: 'collapsed',
  eventClickAction: 'dialog',
  miniDateClickAction: 'navigate',
  mainDateClickAction: 'auto',
  dailyFolder: 'Daily Notes',
  dailyFormat: 'YYYY-MM-DD',
  dailyTemplate: '',
  weeklyFolder: 'Weekly Notes',
  weeklyFormat: 'gggg-[W]ww',
  weeklyTemplate: '',
  weekMode: 'calendar',
  weekStart: 'locale',
  locale: 'en',
  timeZone: 'Asia/Taipei',
  snapMinutes: 15,
  defaultDurationMinutes: 60,
  syncIntervalMinutes: 15,
  customDays: 3,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  sidebarCollapsed: false,
  mainCollapsed: false,
  workdaysOnly: false,
  monthsOnStartup: true,
  monthsMinimum: 3,
  agendaKeepTime: true,
  ganttPeopleFolder: 'People',
  ganttConfirmWrites: true,
};

type RecordLike = Record<string, unknown>;
const record = (value: unknown): RecordLike | undefined =>
  value !== null && typeof value === 'object' ? value as RecordLike : undefined;
const string = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;

/** Coerce new layout preferences while retaining older plugin data without them. */
export function normalizePluginSettings(raw: unknown, fallback: PluginSettings = DEFAULT_SETTINGS): PluginSettings {
  const input = record(raw) ?? {};
  const sidebarCollapsed = typeof input.sidebarCollapsed === 'boolean' ? input.sidebarCollapsed : fallback.sidebarCollapsed;
  const mainCollapsed = typeof input.mainCollapsed === 'boolean' ? input.mainCollapsed : fallback.mainCollapsed;
  return {
    ...fallback,
    ...input,
    sidebarWidth: normalizeSidebarWidth(input.sidebarWidth, fallback.sidebarWidth),
    sidebarCollapsed,
    // Both panels hidden would leave an empty view, so the main calendar wins.
    mainCollapsed: mainCollapsed && !sidebarCollapsed,
    workdaysOnly: typeof input.workdaysOnly === 'boolean' ? input.workdaysOnly : fallback.workdaysOnly,
    moveEventNotes: typeof input.moveEventNotes === 'boolean' ? input.moveEventNotes : fallback.moveEventNotes,
    monthsOnStartup: typeof input.monthsOnStartup === 'boolean' ? input.monthsOnStartup : fallback.monthsOnStartup,
    monthsMinimum: isMonthsMinimum(input.monthsMinimum) ? input.monthsMinimum : fallback.monthsMinimum,
    agendaKeepTime: typeof input.agendaKeepTime === 'boolean' ? input.agendaKeepTime : fallback.agendaKeepTime,
    ganttPeopleFolder: typeof input.ganttPeopleFolder === 'string' ? input.ganttPeopleFolder : fallback.ganttPeopleFolder,
    ganttConfirmWrites: typeof input.ganttConfirmWrites === 'boolean' ? input.ganttConfirmWrites : fallback.ganttConfirmWrites,
    eventPropertiesDefault: isEventPropertiesDefault(input.eventPropertiesDefault)
      ? input.eventPropertiesDefault : fallback.eventPropertiesDefault,
    eventClickAction: isEventClickAction(input.eventClickAction) ? input.eventClickAction : fallback.eventClickAction,
    miniDateClickAction: isMiniDateClickAction(input.miniDateClickAction) ? input.miniDateClickAction : fallback.miniDateClickAction,
    mainDateClickAction: isMainDateClickAction(input.mainDateClickAction) ? input.mainDateClickAction : fallback.mainDateClickAction,
  };
}

export const MONTHS_MINIMUM_MAX = 12;

export function isMonthsMinimum(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MONTHS_MINIMUM_MAX;
}

export function isEventClickAction(value: unknown): value is EventClickAction {
  return value === 'dialog' || value === 'split' || value === 'tab';
}

export function isMiniDateClickAction(value: unknown): value is MiniDateClickAction {
  return value === 'navigate' || value === 'split' || value === 'tab';
}

export function isMainDateClickAction(value: unknown): value is MainDateClickAction {
  return value === 'auto' || value === 'event' || value === 'split' || value === 'tab' || value === 'none';
}

export function isEventPropertiesDefault(value: unknown): value is EventPropertiesDefault {
  return value === 'obsidian' || value === 'collapsed' || value === 'expanded';
}

/** Internal plugin settings are feature-detected because Obsidian does not expose a public provider API. */
function communityPlugin(app: App, id: string): RecordLike | undefined {
  const plugins = record((app as unknown as RecordLike).plugins);
  const instances = record(plugins?.plugins);
  const instance = record(instances?.[id]);
  if (!instance) return undefined;
  const enabled = plugins?.enabledPlugins;
  if (enabled instanceof Set && !enabled.has(id)) return undefined;
  return instance;
}

function communitySettings(app: App, id: string): RecordLike | undefined {
  const instance = communityPlugin(app, id);
  return record(instance?.settings) ?? record(instance?.options) ?? record(instance?.data);
}

function dailyCoreSettings(app: App): RecordLike | undefined {
  const internal = record((app as unknown as RecordLike).internalPlugins);
  const plugins = record(internal?.plugins);
  const daily = record(plugins?.['daily-notes']);
  if (!daily || daily.enabled !== true) return undefined;
  return record(record(daily.instance)?.options) ?? record(daily.options);
}

export function resolveDailySettings(app: App, settings: PluginSettings): ResolvedNoteSettings {
  const core = dailyCoreSettings(app);
  if (core) return {
    folder: string(core.folder),
    format: string(core.format) || DEFAULT_SETTINGS.dailyFormat,
    template: string(core.template),
    provider: 'daily-notes',
  };
  return {
    folder: settings.dailyFolder,
    format: settings.dailyFormat || DEFAULT_SETTINGS.dailyFormat,
    template: settings.dailyTemplate,
    provider: 'calendar-note',
  };
}

export function resolveWeeklySettings(app: App, settings: PluginSettings): ResolvedNoteSettings {
  const periodic = communitySettings(app, 'periodic-notes');
  const weekly = record(periodic?.weekly);
  if (weekly?.enabled === true) return {
    folder: string(weekly.folder),
    format: string(weekly.format) || DEFAULT_SETTINGS.weeklyFormat,
    template: string(weekly.template),
    provider: 'periodic-notes',
  };
  const calendar = communitySettings(app, 'calendar');
  if (calendar) return {
    folder: string(calendar.weeklyNoteFolder),
    format: string(calendar.weeklyNoteFormat) || DEFAULT_SETTINGS.weeklyFormat,
    template: string(calendar.weeklyNoteTemplate),
    provider: 'calendar',
  };
  return {
    folder: settings.weeklyFolder,
    format: settings.weeklyFormat || DEFAULT_SETTINGS.weeklyFormat,
    template: settings.weeklyTemplate,
    provider: 'calendar-note',
  };
}

export function resolveWeekRules(app: App, settings: PluginSettings): WeekRules {
  const calendar = communitySettings(app, 'calendar');
  const localeSetting = calendar?.localeOverride ?? calendar?.overrideLocale;
  const hostMoment = (globalThis as typeof globalThis & { moment?: { locale?: () => string } }).moment;
  const hostLocale = typeof hostMoment?.locale === 'function' ? hostMoment.locale() : undefined;
  const locale = typeof localeSetting === 'string' && localeSetting.trim() && localeSetting !== 'system-default'
    ? localeSetting.toLowerCase() : calendar ? hostLocale || settings.locale : settings.locale;
  const firstDay = calendar?.weekStart ?? calendar?.firstDayOfWeek ?? calendar?.startWeekOn;
  let weekStart: WeekStart = settings.weekStart;
  if (firstDay === 0 || firstDay === 'sunday') weekStart = 'sunday';
  else if (firstDay === 1 || firstDay === 'monday') weekStart = 'monday';
  else if (firstDay === 'locale' || firstDay === -1) weekStart = 'locale';
  else if (typeof firstDay === 'string' && ['tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].includes(firstDay)) weekStart = firstDay as WeekStart;
  return { locale, weekMode: settings.weekMode, weekStart };
}
