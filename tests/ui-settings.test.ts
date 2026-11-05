import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import { DEFAULT_SETTINGS, resolveDailySettings, resolveWeekRules, resolveWeeklySettings } from '../src/settings';

test('Calendar system locale comes from the host Moment setting', () => {
  const host = globalThis as unknown as Record<string, unknown>;
  const previous = host.moment;
  host.moment = { locale: () => 'en-gb' };
  try {
    const app = { plugins: { enabledPlugins: new Set(['calendar']), plugins: {
      calendar: { settings: { localeOverride: 'system-default', weekStart: 0 } },
    } } } as unknown as App;
    assert.deepEqual(resolveWeekRules(app, DEFAULT_SETTINGS), { locale: 'en-gb', weekMode: 'calendar', weekStart: 'sunday' });
  } finally { host.moment = previous; }
});

test('enabled note providers override fallbacks without changing their blank root folder', () => {
  const app = { internalPlugins: { plugins: { 'daily-notes': { enabled: true, instance: { options: {
    folder: '', format: 'YYYY/MM/DD', template: 'Templates/Day',
  } } } } }, plugins: { enabledPlugins: new Set(['periodic-notes', 'calendar']), plugins: {
    'periodic-notes': { settings: { weekly: { enabled: true, folder: '', format: 'GGGG-[W]WW', template: '' } } },
    calendar: { settings: { weeklyNoteFolder: 'Calendar weeks', weeklyNoteFormat: 'gggg-[W]ww' } },
  } } } as unknown as App;
  assert.deepEqual(resolveDailySettings(app, DEFAULT_SETTINGS), { folder: '', format: 'YYYY/MM/DD', template: 'Templates/Day', provider: 'daily-notes' });
  assert.deepEqual(resolveWeeklySettings(app, DEFAULT_SETTINGS), { folder: '', format: 'GGGG-[W]WW', template: '', provider: 'periodic-notes' });
});

test('the month calendar joins the right sidebar at startup unless turned off', async () => {
  const { normalizePluginSettings } = await import('../src/settings');
  assert.equal(normalizePluginSettings({}).monthsOnStartup, true);
  assert.equal(normalizePluginSettings({ monthsOnStartup: false }).monthsOnStartup, false);
  assert.equal(normalizePluginSettings({ monthsOnStartup: 'no' }).monthsOnStartup, true);
});

test('the minimum month count is a whole number from 1 to 12, else 3', async () => {
  const { normalizePluginSettings } = await import('../src/settings');
  assert.equal(normalizePluginSettings({}).monthsMinimum, 3);
  assert.equal(normalizePluginSettings({ monthsMinimum: 1 }).monthsMinimum, 1);
  assert.equal(normalizePluginSettings({ monthsMinimum: 12 }).monthsMinimum, 12);
  for (const bad of [0, 13, 2.5, '4', null]) assert.equal(normalizePluginSettings({ monthsMinimum: bad }).monthsMinimum, 3);
});

test('the events sidebar keeps the time of day by default', async () => {
  const { normalizePluginSettings } = await import('../src/settings');
  assert.equal(normalizePluginSettings({}).agendaKeepTime, true);
  assert.equal(normalizePluginSettings({ agendaKeepTime: false }).agendaKeepTime, false);
  assert.equal(normalizePluginSettings({ agendaKeepTime: 'no' }).agendaKeepTime, true);
});
