import assert from 'node:assert/strict';
import test from 'node:test';
import { bands, dayWidthOf, fitDayWidth, isoWeek, isZoom, levelFor, scale, stepZoom } from '../src/gantt-scale';

test('ISO week numbers, including around New Year', () => {
  assert.equal(isoWeek('2026-11-06'), 45);
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2027-01-01'), 53);
  assert.equal(isoWeek('2027-01-04'), 1);
  assert.equal(isoWeek('2024-12-30'), 1);
});

test('each zoom level labels its own unit', () => {
  const from = '2026-10-26';
  const to = '2026-12-06';
  const day = scale(from, to, 'day');
  assert.equal(day.minor.length, 42);
  assert.deepEqual(day.major.map(band => [band.label, band.offset, band.days]), [['Oct 2026', 0, 6], ['Nov 2026', 6, 30], ['Dec 2026', 36, 6]]);
  assert.equal(day.minor.find(band => band.start === '2026-11-01')?.weekend, true);
  assert.equal(day.minor[0].label, '26');
  const week = scale(from, to, 'week');
  assert.deepEqual(week.minor.map(band => band.label), ['W44', 'W45', 'W46', 'W47', 'W48', 'W49']);
  assert.ok(week.minor.every(band => band.days === 7));
  const month = scale('2026-10-26', '2027-03-10', 'month');
  assert.deepEqual(month.minor.map(band => band.label), ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar']);
  assert.deepEqual(month.major.map(band => band.label), ['2026', '2027']);
  const quarter = scale('2026-08-03', '2027-05-01', 'quarter');
  assert.deepEqual(quarter.minor.map(band => band.label), ['Q3', 'Q4', 'Q1', 'Q2']);
  assert.deepEqual(quarter.minor.map(band => band.days), [59, 92, 90, 31]);
});

test('bands cover the range without gaps', () => {
  for (const unit of ['day', 'week', 'month', 'quarter', 'year'] as const) {
    const list = bands('2026-02-11', '2027-09-03', unit);
    let offset = 0;
    for (const band of list) { assert.equal(band.offset, offset); offset += band.days; }
    assert.equal(offset, 570);
  }
});

test('zoom steps, fitting, and the levels a width reads as', () => {
  assert.equal(isZoom('quarter'), true);
  assert.equal(isZoom('fit'), true);
  assert.equal(isZoom('year'), false);
  assert.equal(stepZoom('day', 24, 1), 'week');
  assert.equal(stepZoom('day', 24, -1), 'day');
  assert.equal(stepZoom('quarter', 1.2, 1), 'quarter');
  assert.equal(stepZoom('month', 3, -1), 'week');
  // From a fitted width between week (8) and day (24): in goes to day, out to week.
  assert.equal(levelFor(10), 'week');
  assert.equal(stepZoom('fit', 10, -1), 'day');
  assert.equal(stepZoom('fit', 10, 1), 'week');
  assert.equal(stepZoom('fit', 8, 1), 'month');
  assert.equal(fitDayWidth(100, 800), 8);
  assert.equal(fitDayWidth(10_000, 800), 0.5);
  assert.equal(fitDayWidth(5, 800), 40);
  assert.equal(fitDayWidth(0, 800), dayWidthOf('day'));
  assert.equal(levelFor(dayWidthOf('month')), 'month');
  assert.equal(levelFor(dayWidthOf('quarter')), 'quarter');
});
