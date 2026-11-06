import assert from 'node:assert/strict';
import test from 'node:test';
import moment from 'moment-timezone';
import type { App } from 'obsidian';
import { dateAt, formatAt, weekInfo } from '../src/date';
import { cleanSegment, dailyNoteFolder, dailyNotePath, eventNotePath, folderPath, formatNotePath, weeklyNotePath } from '../src/paths';
import { DEFAULT_SETTINGS, resolveDailySettings, resolveWeekRules, resolveWeeklySettings } from '../src/settings';
import type { CalendarEvent, PluginSettings, WeekRules, WeekStart } from '../src/types';

const zone = 'Asia/Taipei';
const settings = (changes: Partial<PluginSettings> = {}): PluginSettings => ({ ...DEFAULT_SETTINGS, ...changes });
const app = (plugins: Record<string, unknown> = {}, enabled = Object.keys(plugins), daily?: unknown): App => ({
  plugins: { plugins, enabledPlugins: new Set(enabled) },
  internalPlugins: { plugins: { 'daily-notes': daily } },
}) as unknown as App;

test('US locale, UK locale, and ISO give their own week-year at the 2027 boundary', () => {
  const us: WeekRules = { locale: 'en', weekMode: 'calendar', weekStart: 'locale' };
  const uk: WeekRules = { locale: 'en-gb', weekMode: 'calendar', weekStart: 'locale' };
  const iso: WeekRules = { locale: 'en', weekMode: 'iso', weekStart: 'locale' };
  assert.deepEqual(weekInfo('2027-01-01', us, zone), {
    number: 1, year: 2027, label: '2027-W01', start: '2026-12-27', end: '2027-01-02',
    key: 'calendar:en:0:6:2026-12-27',
  });
  for (const rules of [uk, iso]) {
    assert.equal(weekInfo('2027-01-01', rules, zone).label, '2026-W53');
    assert.equal(weekInfo('2027-01-01', rules, zone).start, '2026-12-28');
  }
  assert.equal(formatAt('2027-01-01', 'gggg-[W]ww / GGGG-[W]WW', us, zone), '2027-W01 / 2026-W53');
  assert.equal(formatAt('2027-01-01', 'gggg-[W]ww / GGGG-[W]WW', uk, zone), '2026-W53 / 2026-W53');
});

test('a first-day override retains the locale first-week rule and does not mutate Moment globally', () => {
  const originalLocale = moment.locale();
  const originalUsWeek = [moment.localeData('en').firstDayOfWeek(), moment.localeData('en').firstDayOfYear()];
  const originalUkWeek = [moment.localeData('en-gb').firstDayOfWeek(), moment.localeData('en-gb').firstDayOfYear()];
  try {
    const sundayUk: WeekRules = { locale: 'en-gb', weekMode: 'calendar', weekStart: 'sunday' };
    const january = weekInfo('2027-01-01', sundayUk, zone);
    assert.equal(january.label, '2026-W53');
    assert.equal(january.start, '2026-12-27');
    assert.equal(formatAt('2027-01-01', 'gggg-[W]ww', sundayUk, zone), '2026-W53');
    assert.equal(weekInfo('2027-01-01', { locale: 'en', weekMode: 'calendar', weekStart: 'locale' }, zone).label, '2027-W01');
    assert.equal(moment.locale(), originalLocale);
    assert.deepEqual([moment.localeData('en').firstDayOfWeek(), moment.localeData('en').firstDayOfYear()], originalUsWeek);
    assert.deepEqual([moment.localeData('en-gb').firstDayOfWeek(), moment.localeData('en-gb').firstDayOfYear()], originalUkWeek);
  } finally {
    moment.locale(originalLocale);
  }
});

test('Calendar supports each explicit weekday and locale default as the week start', () => {
  const names: WeekStart[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const starts = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-17'];
  names.forEach((name, index) => {
    const rules = resolveWeekRules(app({ calendar: { settings: { weekStart: name } } }), settings());
    assert.equal(rules.weekStart, name);
    assert.equal(weekInfo('2026-10-23', rules, zone).start, starts[index]);
  });
  assert.equal(resolveWeekRules(app({ calendar: { settings: { weekStart: 0 } } }), settings()).weekStart, 'sunday');
  assert.equal(resolveWeekRules(app({ calendar: { settings: { firstDayOfWeek: 1 } } }), settings()).weekStart, 'monday');
  assert.equal(resolveWeekRules(app({ calendar: { settings: { startWeekOn: -1 } } }), settings({ weekStart: 'thursday' })).weekStart, 'locale');
});

test('Calendar locale override and host locale resolve without changing host settings', () => {
  const host = globalThis as unknown as Record<string, unknown>;
  // Obsidian exposes its Moment instance as window.moment.
  const previous = host.window;
  host.window = { moment: { locale: () => 'en-gb' } };
  try {
    assert.deepEqual(resolveWeekRules(app({ calendar: { options: { localeOverride: 'en', weekStart: 'sunday' } } }), settings({ locale: 'zh-tw' })),
      { locale: 'en', weekMode: 'calendar', weekStart: 'sunday' });
    assert.deepEqual(resolveWeekRules(app({ calendar: { options: { localeOverride: 'system-default' } } }), settings({ locale: 'zh-tw' })),
      { locale: 'en-gb', weekMode: 'calendar', weekStart: 'locale' });
    assert.deepEqual(resolveWeekRules(app({}, []), settings({ locale: 'zh-tw' })),
      { locale: 'zh-tw', weekMode: 'calendar', weekStart: 'locale' });
  } finally {
    host.window = previous;
  }
});

test('weekly provider precedence respects enabled flags, blank root folders, defaults, and templates', () => {
  const periodic = { settings: { weekly: { enabled: true, folder: '', format: 'GGGG/[W]WW', template: 'Templates/Periodic' } } };
  const calendar = { options: { weeklyNoteFolder: 'Calendar Weeks', weeklyNoteFormat: 'gggg-[W]ww', weeklyNoteTemplate: 'Templates/Calendar' } };
  const fallback = settings({ weeklyFolder: 'Own Weeks', weeklyFormat: 'YYYY-[week]ww', weeklyTemplate: 'Templates/Own' });
  assert.deepEqual(resolveWeeklySettings(app({ 'periodic-notes': periodic, calendar }), fallback),
    { folder: '', format: 'GGGG/[W]WW', template: 'Templates/Periodic', provider: 'periodic-notes' });
  // The weekly file formats the US week anchor (Dec 27), whose ISO week is W52.
  assert.equal(weeklyNotePath('2027-01-01', app({ 'periodic-notes': periodic, calendar }), fallback), '2026/W52.md');
  assert.deepEqual(resolveWeeklySettings(app({ 'periodic-notes': periodic, calendar }, ['calendar']), fallback),
    { folder: 'Calendar Weeks', format: 'gggg-[W]ww', template: 'Templates/Calendar', provider: 'calendar' });
  assert.equal(weeklyNotePath('2027-01-01', app({ 'periodic-notes': periodic, calendar }, ['calendar']), fallback), 'Calendar Weeks/2027-W01.md');
  assert.deepEqual(resolveWeeklySettings(app({ 'periodic-notes': { settings: { weekly: { enabled: false } } }, calendar }), fallback),
    { folder: 'Calendar Weeks', format: 'gggg-[W]ww', template: 'Templates/Calendar', provider: 'calendar' });
  assert.deepEqual(resolveWeeklySettings(app({ calendar: { settings: { weeklyNoteFolder: '', weeklyNoteFormat: '', weeklyNoteTemplate: '' } } }), fallback),
    { folder: '', format: DEFAULT_SETTINGS.weeklyFormat, template: '', provider: 'calendar' });
  assert.deepEqual(resolveWeeklySettings(app({}, []), fallback),
    { folder: 'Own Weeks', format: 'YYYY-[week]ww', template: 'Templates/Own', provider: 'calendar-note' });
});

test('Daily Notes uses enabled core settings and otherwise its independent fallback', () => {
  const own = settings({ dailyFolder: 'Own Days', dailyFormat: 'YYYY/MM/DD', dailyTemplate: 'Templates/Own', weeklyFolder: 'Own Weeks' });
  const daily = { enabled: true, instance: { options: { folder: '', format: 'YYYY/MM/DD', template: 'Templates/Core' } } };
  const periodic = { settings: { daily: { enabled: true, folder: 'Periodic Days', format: 'DD-MM-YYYY' } } };
  assert.deepEqual(resolveDailySettings(app({ 'periodic-notes': periodic }, ['periodic-notes'], daily), own),
    { folder: '', format: 'YYYY/MM/DD', template: 'Templates/Core', provider: 'daily-notes' });
  assert.equal(dailyNotePath('2026-10-23', app({}, [], daily), own), '2026/10/23.md');
  assert.deepEqual(resolveDailySettings(app({ 'periodic-notes': periodic }, ['periodic-notes'], { ...daily, enabled: false }), own),
    { folder: 'Own Days', format: 'YYYY/MM/DD', template: 'Templates/Own', provider: 'calendar-note' });
  assert.equal(dailyNotePath('2026-10-23', app({}, [], { enabled: false }), own), 'Own Days/2026/10/23.md');
  assert.equal(resolveDailySettings(app({}, [], { enabled: true, instance: { options: { folder: '', format: '' } } }), own).format,
    DEFAULT_SETTINGS.dailyFormat);
});

test('calendar-date anchors map different event times on one display day to one Daily Note', () => {
  const configured = settings({ dailyFolder: '', dailyFormat: 'YYYY-MM-DD-[at]-HH-mm' });
  const providerApp = app({}, []);
  const eventStarts = ['2026-10-22T17:30:00Z', '2026-10-23T14:15:00+08:00'];
  const paths = eventStarts.map(start => {
    const calendarDate = dateAt(start, zone).format('YYYY-MM-DD');
    return dailyNotePath(calendarDate, providerApp, configured);
  });
  assert.deepEqual(paths, ['2026-10-23-at-00-00.md', '2026-10-23-at-00-00.md']);
  assert.equal(dailyNotePath('2026-10-23', providerApp, configured), paths[0]);
});

test('event variables are sanitized after Moment formatting and cannot create path segments', () => {
  const event: CalendarEvent = {
    id: 'local:uid', sourceId: 'local', uid: 'UID/YYYY/../../CON', title: 'YYYY/MMM: Q4?*',
    start: '2026-10-23T09:00:00+08:00', end: '2026-10-23T10:00:00+08:00', allDay: false,
  };
  assert.equal(eventNotePath(event, 'Team/2026', app({}, []), settings({ eventPattern: '[Calendar Notes]/YYYY/MMMM/{title} - {calendar} - {uid}' })),
    'Calendar Notes/2026/October/YYYY MMM Q4 - Team 2026 - UID YYYY .. .. CON.md');
  assert.equal(formatNotePath('[literal]/YYYY/MM/DD/\\{title}', '2026-10-23', settings(), zone),
    'literal/2026/10/23/{title}.md');
});

test('a leading {daily} files Event Notes in the folder of their Daily Note', () => {
  const event: CalendarEvent = {
    id: 'local:uid', sourceId: 'local', uid: 'uid', title: 'Standup',
    start: '2026-10-22T17:30:00Z', end: '2026-10-22T18:00:00Z', allDay: false,
  };
  const core = { enabled: true, instance: { options: { folder: 'Journal', format: 'YYYY/MM/YYYY-MM-DD' } } };
  const coreApp = app({}, [], core);
  // 17:30Z is already 2026-10-23 in Taipei, the same day that selects the Daily Note.
  assert.equal(dailyNotePath('2026-10-23', coreApp, settings()), 'Journal/2026/10/2026-10-23.md');
  assert.equal(eventNotePath(event, 'Local', coreApp, settings({ eventPattern: '{daily}/{title}' })),
    'Journal/2026/10/Standup.md');
  assert.equal(eventNotePath(event, 'Local', coreApp, settings({ eventPattern: ' {Daily}/[Events]/HHmm {title} ' })),
    'Journal/2026/10/Events/0130 Standup.md');
  // The Daily Note folder is not read as Moment tokens.
  const fallback = settings({ dailyFolder: 'Days', dailyFormat: 'YYYY-MM-DD', eventPattern: '{daily}/{title}' });
  assert.equal(eventNotePath(event, 'Local', app({}, []), fallback), 'Days/Standup.md');
  // A Daily Note at the Vault root leaves the Event Note at the root too.
  assert.equal(dailyNoteFolder('2026-10-23', app({}, []), settings({ dailyFolder: '' })), '');
  assert.equal(eventNotePath(event, 'Local', app({}, []), settings({ dailyFolder: '', eventPattern: '{daily}/{title}' })),
    'Standup.md');
  // All-day events use their calendar date, not the instant converted to the display zone.
  const allDay = { ...event, start: '2026-10-23', end: '2026-10-24', allDay: true };
  assert.equal(eventNotePath(allDay, 'Local', coreApp, settings({ eventPattern: '{daily}/{title}', timeZone: 'America/Los_Angeles' })),
    'Journal/2026/10/Standup.md');
  for (const pattern of ['{daily}', '{daily}/', 'Notes/{daily}/{title}', '{title} {daily}', '{daily}/{daily}/{title}']) {
    assert.throws(() => eventNotePath(event, 'Local', coreApp, settings({ eventPattern: pattern })), pattern);
  }
  assert.equal(eventNotePath(event, 'Local', coreApp, settings({ eventPattern: '\\{daily}/{title}' })), '{daily}/Standup.md');
});

test('nested formats, literal folders, and all dates in one week give one weekly path', () => {
  const configured = settings({ weeklyFormat: '[Weekly Notes]/gggg/[W]ww', weeklyFolder: '', locale: 'en-gb' });
  const providerApp = app({}, []);
  const first = weeklyNotePath('2027-01-01', providerApp, configured);
  assert.equal(first, 'Weekly Notes/2026/W53.md');
  for (const date of ['2026-12-28', '2026-12-31', '2027-01-03']) {
    assert.equal(weeklyNotePath(date, providerApp, configured), first);
  }
  assert.equal(formatNotePath('YYYY/MMMM/YYYY-MMM-DD/{title}', '2026-10-23', settings(), zone, { title: 'Planning' }),
    '2026/October/2026-Oct-23/Planning.md');
});

test('path helpers reject unknown placeholders, traversal, absolute paths, and event variables in date paths', () => {
  for (const pattern of ['../{title}', '/{title}', '~/notes/{title}', 'C:/notes/{title}', 'a//{title}', 'a/{unknown}', 'a/{title', 'a/{title}/..']) {
    assert.throws(() => formatNotePath(pattern, '2026-10-23', settings(), zone, { title: 'Meeting' }), pattern);
  }
  assert.throws(() => formatNotePath('{title}', '2026-10-23', settings(), zone, { title: 'Meeting' }, true));
  for (const folder of ['/absolute', '../parent', 'a//b', 'C:/drive', 'a\\b', 'CON', 'a/{title}']) {
    assert.throws(() => folderPath(folder), folder);
  }
});

test('sanitization respects Unicode byte limits and Windows device names', () => {
  assert.equal(cleanSegment('CON'), '_CON');
  assert.equal(cleanSegment('lpt9.txt'), '_lpt9.txt');
  assert.equal(cleanSegment('a/b\\c:*?'), 'a b c');
  assert.equal(cleanSegment('..'), 'Untitled event');
  assert.equal(cleanSegment('e\u0301'), 'é');
  const long = cleanSegment('😀'.repeat(100));
  assert.ok(new TextEncoder().encode(long).length <= 180);
  assert.ok([...long].length <= 120);
  assert.equal(long, '😀'.repeat(45));
  assert.throws(() => folderPath('😀'.repeat(64)));
});
