/** Stable event identity is source ID + UID + original recurrence ID. */
export interface CalendarEvent {
  id: string;
  sourceId: string;
  uid: string;
  recurrenceId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  sequence?: number;
  status?: 'active' | 'cancelled' | 'removed';
  location?: string;
  description?: string;
}

/** A holiday calendar marks the days its events cover instead of only listing them. */
export type CalendarKind = 'events' | 'holidays';
/** How a holiday calendar colors the days it covers. */
export type HolidayShade = 'gray' | 'custom' | 'none';

export interface CalendarSource {
  id: string;
  name: string;
  url: string;
  color: string;
  enabled: boolean;
  /** Older saved subscriptions have no kind and stay ordinary event calendars. */
  kind?: CalendarKind;
  holidayShade?: HolidayShade;
  /** Day background when `holidayShade` is `custom`. */
  holidayColor?: string;
  /** Whether the holiday events themselves appear; their days stay shaded either way. */
  showHolidayEvents?: boolean;
}

export interface Interval {
  start: string;
  end: string;
  allDay?: boolean;
}

export type WeekMode = 'calendar' | 'iso';
export type WeekStart = 'locale' | 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
export type NoteProvider = 'calendar-note' | 'daily-notes' | 'periodic-notes' | 'calendar';
export type EventPropertiesDefault = 'obsidian' | 'collapsed' | 'expanded';
/** What clicking an event in the main calendar does. */
export type EventClickAction = 'dialog' | 'split' | 'tab';
/** What clicking a date in the mini calendar does besides moving the main calendar there. */
export type MiniDateClickAction = 'navigate' | 'split' | 'tab';
/** What clicking an empty time slot or date cell in the main calendar does. */
export type MainDateClickAction = 'auto' | 'event' | 'split' | 'tab' | 'none';

export interface WeekRules {
  locale: string;
  weekMode: WeekMode;
  weekStart: WeekStart;
}

export interface PluginSettings extends WeekRules {
  sources: CalendarSource[];
  eventPattern: string;
  /** Move an Event Note to its pattern path when the event's date changes. */
  moveEventNotes: boolean;
  eventPropertiesDefault: EventPropertiesDefault;
  eventClickAction: EventClickAction;
  miniDateClickAction: MiniDateClickAction;
  mainDateClickAction: MainDateClickAction;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string;
  weeklyFolder: string;
  weeklyFormat: string;
  weeklyTemplate: string;
  timeZone: string;
  snapMinutes: number;
  defaultDurationMinutes: number;
  syncIntervalMinutes: number;
  customDays: number;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  mainCollapsed: boolean;
  workdaysOnly: boolean;
  /** Add the month calendar to the right sidebar at startup when it is not open anywhere. */
  monthsOnStartup: boolean;
  /** Month cards shrink until at least this many months fit the panel. */
  monthsMinimum: number;
  /** Changing the events sidebar's date keeps the time of day on screen, instead of scrolling to the first event. */
  agendaKeepTime: boolean;
}

export interface ResolvedNoteSettings {
  folder: string;
  format: string;
  template: string;
  provider: NoteProvider;
}

export interface CalendarWeek {
  number: number;
  year: number;
  label: string;
  start: string;
  end: string;
  key: string;
}
