import assert from 'node:assert/strict';
import test from 'node:test';
import { annotationFields, ensureBlockId, formatDate, parseTaskLine, parseToken, renderTaskLine, updateTaskLine } from '../src/annotation';

const today = '2026-11-05';
const fields = (line: string) => annotationFields(parseTaskLine(line, today)?.annotation);

test('each token kind is recognised', () => {
  assert.deepEqual(parseToken('30%', today), { kind: 'progress', value: 30, sign: '%' });
  assert.deepEqual(parseToken('30％', today), { kind: 'progress', value: 30, sign: '％' });
  assert.deepEqual(parseToken('11/6', today), { kind: 'due', date: '2026-11-06', iso: false });
  assert.deepEqual(parseToken('2026-11-06', today), { kind: 'due', date: '2026-11-06', iso: true });
  assert.deepEqual(parseToken('11/1-11/6', today), { kind: 'range', start: '2026-11-01', end: '2026-11-06', sep: '-', startIso: false, endIso: false });
  assert.equal((parseToken('11/1–11/6', today) as { sep: string }).sep, '–');
  assert.equal((parseToken('11/1~11/6', today) as { sep: string }).sep, '~');
  assert.deepEqual(parseToken('2026-11-01-2026-11-06', today), { kind: 'range', start: '2026-11-01', end: '2026-11-06', sep: '-', startIso: true, endIso: true });
  assert.deepEqual(parseToken('◆ 11/30', today), { kind: 'milestone', date: '2026-11-30', iso: false, space: ' ' });
  assert.deepEqual(parseToken('@小王', today), { kind: 'assignee', name: '小王', style: 'at' });
  assert.deepEqual(parseToken('@[[小王]]', today), { kind: 'assignee', name: '小王', style: 'link' });
  assert.deepEqual(parseToken('@[[People/AAA|AAA]]', today), { kind: 'assignee', name: 'People/AAA', style: 'link', alias: 'AAA' });
  // The earlier `by [[name]]` form is still read.
  assert.deepEqual(parseToken('by [[小王]]', today), { kind: 'assignee', name: '小王', style: 'link' });
  assert.deepEqual(parseToken('by [[People/AAA|AAA]]', today), { kind: 'assignee', name: 'People/AAA', style: 'link', alias: 'AAA' });
});

test('impossible values are not tokens', () => {
  for (const text of ['130%', '2/30', '13/1', '2026-02-30', '11/6-2026-11-01', '@', 'by 小王', 'later', '11/6 morning']) {
    assert.equal(parseToken(text, today), undefined, text);
  }
});

test('a full annotation with every separator', () => {
  assert.deepEqual(fields('- 視覺稿 (30%, 11/4-11/10, @小王)'), {
    progress: 30, start: '2026-11-04', end: '2026-11-10', assignees: [{ name: '小王', style: 'at' }],
  });
  assert.deepEqual(fields('- 視覺稿 （30％，11/4-11/10、@小王）'), fields('- 視覺稿 (30%, 11/4-11/10, @小王)'));
  assert.deepEqual(fields('- API (11/9-11/22, @[[AAA]])').assignees, [{ name: 'AAA', style: 'link' }]);
  assert.deepEqual(fields('- API (11/9-11/22, by [[AAA]])').assignees, [{ name: 'AAA', style: 'link' }]);
  assert.equal(fields('- 發新聞稿 (◆ 11/30)').milestone, '2026-11-30');
  assert.equal(fields('## 設計 (11/20)').due, '2026-11-20');
});

test('half-width and full-width brackets both hold annotations', () => {
  assert.equal(parseTaskLine('- A (30%)', today)?.annotation?.open, '(');
  assert.equal(parseTaskLine('- A （30%）', today)?.annotation?.open, '（');
  assert.equal(parseTaskLine('- A (30%）', today)?.annotation, undefined);
});

test('a remark in brackets is not an annotation and is kept as text', () => {
  const line = parseTaskLine('- 前端 （跟 AAA 確認）', today)!;
  assert.equal(line.annotation, undefined);
  assert.equal(line.title, '前端 （跟 AAA 確認）');
  assert.equal(parseTaskLine('- A (補充說明)', today)?.annotation, undefined);
  // One unknown segment makes the whole bracket a remark.
  assert.equal(parseTaskLine('- A (30%, 待確認)', today)?.annotation, undefined);
  // Two values for one field are ambiguous.
  assert.equal(parseTaskLine('- A (30%, 40%)', today)?.annotation, undefined);
  assert.equal(parseTaskLine('- A (11/1, 11/3)', today)?.annotation, undefined);
  assert.equal(parseTaskLine('- A ()', today)?.annotation, undefined);
});

test('text outside the last bracket is never parsed', () => {
  assert.deepEqual(fields('- 完成 50% 的頁面'), { assignees: [] });
  assert.deepEqual(fields('- 完成 50% 的頁面 (11/6)'), { due: '2026-11-06', assignees: [] });
  assert.deepEqual(fields('- A (30%) 之後再說'), { assignees: [] });
  // Only the last bracket counts.
  assert.deepEqual(fields('- A (30%) (11/6)'), { due: '2026-11-06', assignees: [] });
});

test('a block ID after the annotation is kept', () => {
  const line = parseTaskLine('- A (30%) ^task-1', today)!;
  assert.equal(line.blockId, 'task-1');
  assert.equal(line.annotation?.segments[0].raw, '30%');
  assert.equal(updateTaskLine('- A (30%) ^task-1', { progress: 40 }, today), '- A (40%) ^task-1');
});

test('years: this year by default, ranges crossing into the next year', () => {
  assert.equal(fields('- A (1/3)').due, '2026-01-03');
  assert.deepEqual(fields('- A (12/28-1/5)'), { start: '2026-12-28', end: '2027-01-05', assignees: [] });
  assert.deepEqual(fields('- A (2027-12-28-1/5)'), { start: '2027-12-28', end: '2028-01-05', assignees: [] });
  assert.deepEqual(fields('- A (2027-03-01-3/5)'), { start: '2027-03-01', end: '2027-03-05', assignees: [] });
  assert.equal(formatDate('2026-11-06', today), '11/6');
  assert.equal(formatDate('2027-01-05', today), '2027-01-05');
  assert.equal(formatDate('2026-11-06', today, true), '2026-11-06');
});

test('round trip keeps an untouched line byte for byte', () => {
  for (const text of [
    '- 視覺稿 （30％，11/4–11/10、@小王）',
    '    * [ ] A ( 30% ,11/1~11/6 ) ^abc',
    '## 設計 (2026-11-20) ##',
    '1. 線框圖 (100%, 11/2-11/4)',
    '- 前端 （跟 AAA 確認）',
  ]) assert.equal(renderTaskLine(parseTaskLine(text, today)!), text);
});

test('writing back changes only the touched token and keeps the line format', () => {
  assert.equal(updateTaskLine('- 視覺稿 （30％，11/4–11/10、@小王）', { progress: 50 }, today), '- 視覺稿 （50％，11/4–11/10、@小王）');
  assert.equal(updateTaskLine('- 視覺稿 （30％，11/4–11/10、@小王）', { schedule: { start: '2026-11-05', end: '2026-11-12' } }, today),
    '- 視覺稿 （30％，11/5–11/12、@小王）');
  assert.equal(updateTaskLine('- A (2026-11-01-2026-11-06)', { schedule: { start: '2026-11-02', end: '2026-11-07' } }, today),
    '- A (2026-11-02-2026-11-07)');
  // A date outside this year is written in full.
  assert.equal(updateTaskLine('- A (12/28-12/30)', { schedule: { start: '2026-12-28', end: '2027-01-04' } }, today), '- A (12/28-2027-01-04)');
  assert.equal(updateTaskLine('- A (11/6)', { schedule: { due: '2027-02-01' } }, today), '- A (2027-02-01)');
  assert.equal(updateTaskLine('- A (11/6)', { schedule: { start: '2026-11-01', end: '2026-11-06' } }, today), '- A (11/1-11/6)');
  assert.equal(updateTaskLine('- A (◆ 11/30)', { milestone: '2026-12-01' }, today), '- A (◆ 12/1)');
  assert.equal(updateTaskLine('- A (@小王)', { assignees: [{ name: '小王', style: 'link' }] }, today), '- A (@[[小王]])');
  // A legacy `by [[name]]` is kept as written when another field changes.
  assert.equal(updateTaskLine('- A (11/6, by [[AAA]])', { progress: 20, assignees: [{ name: 'AAA', style: 'link' }] }, today), '- A (11/6, by [[AAA]], 20%)');
});

test('a line without an annotation gains (30%, 11/1-11/6); 0% is left out', () => {
  assert.equal(updateTaskLine('- A', { progress: 30, schedule: { start: '2026-11-01', end: '2026-11-06' } }, today), '- A (30%, 11/1-11/6)');
  assert.equal(updateTaskLine('- A', { progress: 0, schedule: { start: '2026-11-01', end: '2026-11-06' } }, today), '- A (11/1-11/6)');
  assert.equal(updateTaskLine('- A ^id', { schedule: { due: '2026-11-09' } }, today), '- A (11/9) ^id');
  assert.equal(updateTaskLine('- 前端 （跟 AAA 確認）', { schedule: { due: '2026-11-09' } }, today), '- 前端 （跟 AAA 確認） (11/9)');
  assert.equal(updateTaskLine('## 設計', { schedule: { due: '2026-11-20' } }, today), '## 設計 (11/20)');
});

test('new tokens join an existing annotation with its separator', () => {
  assert.equal(updateTaskLine('- A （11/6）', { progress: 20 }, today), '- A （11/6，20%）');
  assert.equal(updateTaskLine('- A (11/6、@小王)', { progress: 20 }, today), '- A (11/6、@小王、20%)');
  assert.equal(updateTaskLine('- A (11/6)', { progress: 20 }, today), '- A (11/6, 20%)');
});

test('removing every token removes the brackets', () => {
  assert.equal(updateTaskLine('- A (30%)', { progress: 0 }, today), '- A');
  assert.equal(updateTaskLine('- A (30%, 11/6)', { progress: 0 }, today), '- A (11/6)');
  assert.equal(updateTaskLine('- A (11/6, 30%)', { schedule: null }, today), '- A (30%)');
  assert.equal(updateTaskLine('- A (30%) ^x', { progress: 0 }, today), '- A ^x');
});

test('a checkbox stands for 100%', () => {
  assert.equal(updateTaskLine('- [ ] A (90%)', { progress: 100 }, today), '- [x] A');
  assert.equal(updateTaskLine('- [x] A', { progress: 40 }, today), '- [ ] A (40%)');
  assert.equal(updateTaskLine('- [ ] A', { progress: 10 }, today), '- [ ] A (10%)');
});

test('a block ID is added once', () => {
  const made = ensureBlockId('- A (30%)', today, () => 'abc123');
  assert.deepEqual(made, { text: '- A (30%) ^abc123', id: 'abc123' });
  assert.deepEqual(ensureBlockId(made.text, today, () => 'other'), made);
});
