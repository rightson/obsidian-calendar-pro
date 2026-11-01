import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agendaDays, dayRange, daysWithEvents, draggedInterval, eventTimeLabel, eventsOnDay, instantAt, snappedMinutes,
  unionRange, weekDays,
} from '../src/agenda-layout';
import type { CalendarEvent } from '../src/types';

const zone = 'Asia/Taipei';
const event = (id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id, sourceId: 'local', uid: id, title: id, start, end, allDay: false, ...extra });
const at = (time: string, day = '2026-10-22') => `${day}T${time}:00+08:00`;

test('the week strip starts on the configured first day', () => {
  // 2026-10-22 is a Thursday.
  assert.deepEqual(weekDays('2026-10-22', 0, zone), ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  assert.deepEqual(weekDays('2026-10-22', 1, zone)[0], '2026-10-19');
  assert.deepEqual(weekDays('2026-10-18', 1, zone)[0], '2026-10-12');
  assert.deepEqual(weekDays('2026-10-19', 1, zone)[6], '2026-10-25');
});

test('a day splits into all-day and timed events, leaving out cancelled and removed ones', () => {
  const events = [
    event('Standup', at('10:00'), at('10:30')),
    event('Holiday', '2026-10-22T00:00:00+08:00', '2026-10-23T00:00:00+08:00', { allDay: true }),
    event('Cancelled', at('11:00'), at('12:00'), { status: 'cancelled' }),
    event('Removed', at('13:00'), at('14:00'), { status: 'removed' }),
    event('Tomorrow', at('10:00', '2026-10-23'), at('11:00', '2026-10-23')),
  ];
  const day = eventsOnDay(events, '2026-10-22', zone);
  assert.deepEqual(day.allDay.map(item => item.id), ['Holiday']);
  assert.deepEqual(day.timed.map(item => [item.event.id, item.startMinute, item.endMinute]), [['Standup', 600, 630]]);
});

test('events crossing midnight are clipped to the day and marked as continuing', () => {
  const late = event('Late', at('23:00', '2026-10-21'), at('01:30'));
  const night = event('Night', at('23:00'), '2026-10-23T00:00:00+08:00');
  const [before] = eventsOnDay([late], '2026-10-22', zone).timed;
  assert.deepEqual([before.startMinute, before.endMinute, before.continuesBefore, before.continuesAfter], [0, 90, true, false]);
  const [after] = eventsOnDay([late], '2026-10-21', zone).timed;
  assert.deepEqual([after.startMinute, after.endMinute, after.continuesBefore, after.continuesAfter], [1380, 1440, false, true]);
  // Ending exactly at midnight stays on its day and reaches the bottom of the grid.
  const [toMidnight] = eventsOnDay([night], '2026-10-22', zone).timed;
  assert.deepEqual([toMidnight.startMinute, toMidnight.endMinute, toMidnight.continuesAfter], [1380, 1440, false]);
  assert.equal(eventsOnDay([night], '2026-10-23', zone).timed.length, 0);
});

test('overlapping events share the width; separate groups use the full width', () => {
  const events = [
    event('A', at('09:00'), at('10:30')),
    event('B', at('09:30'), at('10:00')),
    event('C', at('10:00'), at('11:00')),
    event('D', at('12:00'), at('13:00')),
  ];
  const placed = Object.fromEntries(eventsOnDay(events, '2026-10-22', zone).timed.map(item => [item.event.id, [item.column, item.columns]]));
  // B ends when C starts, so C reuses B's column.
  assert.deepEqual(placed, { A: [0, 2], B: [1, 2], C: [1, 2], D: [0, 1] });
});

test('zero-duration events still take room in the layout', () => {
  const events = [event('Reminder', at('10:00'), at('10:00')), event('Next', at('10:10'), at('10:40'))];
  const placed = eventsOnDay(events, '2026-10-22', zone).timed;
  assert.deepEqual(placed.map(item => [item.event.id, item.column, item.columns]), [['Reminder', 0, 2], ['Next', 1, 2]]);
});

test('the list keeps the first day and days with events, in order', () => {
  const events = [event('Later', at('09:00', '2026-10-25'), at('10:00', '2026-10-25')), event('Soon', at('15:00', '2026-10-23'), at('16:00', '2026-10-23'))];
  assert.deepEqual(agendaDays(events, '2026-10-22', 7, zone).map(day => [day.day, day.events.map(item => item.id)]),
    [['2026-10-22', []], ['2026-10-23', ['Soon']], ['2026-10-25', ['Later']]]);
  assert.deepEqual(agendaDays(events, '2026-10-22', 2, zone).map(day => day.day), ['2026-10-22', '2026-10-23']);
});

test('the week strip marks the days that have events', () => {
  const events = [event('Late', at('23:00', '2026-10-21'), at('01:00')), event('Gone', at('09:00', '2026-10-24'), at('10:00', '2026-10-24'), { status: 'removed' })];
  assert.deepEqual([...daysWithEvents(events, weekDays('2026-10-22', 0, zone), zone)], ['2026-10-21', '2026-10-22']);
});

test('time labels read from the day being shown', () => {
  const late = event('Late', at('23:00', '2026-10-21'), at('01:30'));
  assert.equal(eventTimeLabel(event('A', at('09:00'), at('10:30')), '2026-10-22', zone), '09:00–10:30');
  assert.equal(eventTimeLabel(late, '2026-10-21', zone), '23:00 →');
  assert.equal(eventTimeLabel(late, '2026-10-22', zone), '→ 01:30');
  assert.equal(eventTimeLabel(event('R', at('10:00'), at('10:00')), '2026-10-22', zone), '10:00');
  assert.equal(eventTimeLabel(event('H', '2026-10-22T00:00:00+08:00', '2026-10-23T00:00:00+08:00', { allDay: true }), '2026-10-22', zone), 'All day');
  assert.equal(eventTimeLabel(event('M', at('23:00'), '2026-10-23T00:00:00+08:00'), '2026-10-22', zone), '23:00–00:00');
  assert.equal(eventTimeLabel(event('Long', at('09:00', '2026-10-21'), at('09:00', '2026-10-23')), '2026-10-22', zone), 'All day');
});

test('drags move in whole snap steps', () => {
  assert.equal(snappedMinutes(0, 48, 15), 0);
  assert.equal(snappedMinutes(5, 48, 15), 0);
  assert.equal(snappedMinutes(-5, 48, 15), 0);
  assert.equal(snappedMinutes(12, 48, 15), 15);
  assert.equal(snappedMinutes(48, 48, 15), 60);
  assert.equal(snappedMinutes(-30, 48, 15), -45);
  assert.equal(snappedMinutes(20, 48, 30), 30);
});

test('moving shifts both ends; resizing moves the end but keeps the minimum length', () => {
  const standup = event('Standup', at('10:00'), at('10:30'));
  assert.deepEqual(draggedInterval(standup, 45, 'move', 15), { start: '2026-10-22T02:45:00.000Z', end: '2026-10-22T03:15:00.000Z', allDay: false });
  assert.deepEqual(draggedInterval(standup, 30, 'resize', 15), { start: '2026-10-22T02:00:00.000Z', end: '2026-10-22T03:00:00.000Z', allDay: false });
  assert.deepEqual(draggedInterval(standup, -60, 'resize', 15), { start: '2026-10-22T02:00:00.000Z', end: '2026-10-22T02:15:00.000Z', allDay: false });
});

test('a pointer position on the timeline becomes a snapped instant on that day', () => {
  assert.equal(instantAt('2026-10-22', 10 * 60 + 7, 15, zone), '2026-10-22T02:00:00.000Z');
  assert.equal(instantAt('2026-10-22', 10 * 60 + 16, 15, zone), '2026-10-22T02:15:00.000Z');
  assert.equal(instantAt('2026-10-22', -20, 15, zone), '2026-10-21T16:00:00.000Z');
  assert.equal(instantAt('2026-10-22', 24 * 60 + 30, 15, zone), '2026-10-22T15:45:00.000Z');
});

test('wall-clock positions follow the display zone across DST changes', () => {
  // America/New_York falls back on 2026-11-01: 01:00–02:00 happens twice.
  const ny = 'America/New_York';
  const [placed] = eventsOnDay([event('Brunch', '2026-11-01T11:00:00-05:00', '2026-11-01T12:00:00-05:00')], '2026-11-01', ny).timed;
  assert.deepEqual([placed.startMinute, placed.endMinute], [660, 720]);
  assert.equal(instantAt('2026-11-01', 11 * 60, 15, ny), '2026-11-01T16:00:00.000Z');
});

test('visible ranges merge into the smallest range covering them', () => {
  assert.equal(unionRange([]), undefined);
  assert.deepEqual(unionRange([dayRange('2026-10-18', '2026-10-24', zone), dayRange('2026-10-22', '2026-11-04', zone)]),
    { start: '2026-10-17T16:00:00.000Z', end: '2026-11-04T16:00:00.000Z' });
  assert.deepEqual(unionRange([{ start: 'not a date', end: 'x' }, dayRange('2026-10-22', '2026-10-22', zone)]),
    { start: '2026-10-21T16:00:00.000Z', end: '2026-10-22T16:00:00.000Z' });
});
