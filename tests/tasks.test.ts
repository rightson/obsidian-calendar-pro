import assert from 'node:assert/strict';
import test from 'node:test';
import { canStep, demoteLine, isUnscheduled, linkedTaskNote, parseAssigneeInput, parseProject, promoteLine, retitleLine, stepProgress, taskNoteName, upgradeAssignee, type TaskNode } from '../src/tasks';
import { dateHint, assignHint, taskHints } from '../src/task-hints';

const today = '2026-11-05';
const EXAMPLE = `---
gantt: true
---
- 網站改版
  - 設計 (11/20)
    - 線框圖 (100%, 11/2-11/4)
    - 視覺稿 (30%, 11/4-11/10, @小王)
      - 補充說明：配色待定
  - 開發
    - API (11/9-11/22, by [[AAA]])
    - 前端 （跟 AAA 確認）
- 行銷
  - 發新聞稿 (◆ 11/30)
  - 社群貼文 下週一前
`;

const byTitle = (nodes: TaskNode[], title: string) => nodes.find(node => node.title === title)!;

test('the example outline becomes a WBS with position-based numbers', () => {
  const { nodes, roots } = parseProject(EXAMPLE, today);
  assert.deepEqual(roots.map(node => node.title), ['網站改版', '行銷']);
  assert.deepEqual(nodes.map(node => `${node.wbs} ${node.title}`), [
    '1 網站改版', '1.1 設計', '1.1.1 線框圖', '1.1.2 視覺稿', '1.1.2.1 補充說明：配色待定',
    '1.2 開發', '1.2.1 API', '1.2.2 前端 （跟 AAA 確認）', '2 行銷', '2.1 發新聞稿', '2.2 社群貼文 下週一前',
  ]);
  assert.equal(byTitle(nodes, '線框圖').line, 5);
});

test('plain text rows are rows, not tasks', () => {
  const { nodes } = parseProject(EXAMPLE, today);
  const visual = byTitle(nodes, '視覺稿');
  // A remark under a task does not turn it into a summary.
  assert.equal(visual.summary, false);
  assert.equal(visual.progress, 30);
  const note = byTitle(nodes, '補充說明：配色待定');
  assert.equal(note.isTask, false);
  assert.equal(note.progress, undefined);
  assert.equal(byTitle(nodes, '前端 （跟 AAA 確認）').isTask, false);
  assert.equal(isUnscheduled(byTitle(nodes, '前端 （跟 AAA 確認）')), true);
  assert.equal(isUnscheduled(byTitle(nodes, '社群貼文 下週一前')), true);
});

test('irregular indentation and headings build the tree', () => {
  const { nodes, roots } = parseProject([
    '# Plan',
    '## Phase 1',
    '- A',
    '   - A1',
    '  - A2',
    '      - A2a',
    '\t- A3',
    '### Detail',
    '- D',
    '## Phase 2',
    '* B',
    '1. C',
    '```',
    '- not a task (30%)',
    '```',
  ].join('\n'), today);
  const parent = (title: string) => byTitle(nodes, title).parent?.title;
  assert.deepEqual(roots.map(node => node.title), ['Plan']);
  assert.equal(parent('Phase 1'), 'Plan');
  assert.equal(parent('A'), 'Phase 1');
  assert.equal(parent('A1'), 'A');
  assert.equal(parent('A2'), 'A');
  assert.equal(parent('A2a'), 'A2');
  // A tab is four columns, so A3 sits deeper than A2.
  assert.equal(parent('A3'), 'A2');
  assert.equal(parent('Detail'), 'Phase 1');
  assert.equal(parent('D'), 'Detail');
  assert.equal(parent('Phase 2'), 'Plan');
  assert.equal(parent('B'), 'Phase 2');
  assert.equal(parent('C'), 'Phase 2');
  assert.equal(nodes.some(node => node.title.startsWith('not a task')), false);
  assert.deepEqual(nodes.filter(node => node.parent?.title === 'Phase 1').map(node => node.wbs), ['1.1.1', '1.1.2']);
});

test('summaries roll up dates and day-weighted progress', () => {
  const { nodes } = parseProject(EXAMPLE, today);
  const design = byTitle(nodes, '設計');
  assert.equal(design.summary, true);
  assert.equal(design.start, '2026-11-02');
  assert.equal(design.end, '2026-11-10');
  // 線框圖 3 days at 100%, 視覺稿 7 days at 30%: (300 + 210) / 10.
  assert.equal(design.progress, 51);
  const site = byTitle(nodes, '網站改版');
  // Leaves: 線框圖 3d 100%, 視覺稿 7d 30%, API 14d 0%.
  assert.equal(site.progress, Math.round((300 + 210) / 24));
  assert.equal(site.start, '2026-11-02');
  assert.equal(site.end, '2026-11-22');
  const marketing = byTitle(nodes, '行銷');
  // Only the milestone is a task; the plain row with a date phrase is not.
  assert.equal(marketing.start, '2026-11-30');
  assert.equal(marketing.end, '2026-11-30');
});

test('deadlines and unscheduled tasks weigh 1 day', () => {
  const { nodes } = parseProject(['- P', '  - A (100%, 11/1-11/10)', '  - B (50%, 11/20)', '  - [ ] C', '  - [x] D'].join('\n'), today);
  // (10*100 + 1*50 + 1*0 + 1*100) / 13
  assert.equal(byTitle(nodes, 'P').progress, Math.round(1150 / 13));
  assert.equal(byTitle(nodes, 'P').end, '2026-11-20');
});

test('nested summaries are weighted by their leaves, not by their own value', () => {
  const { nodes } = parseProject(['- P', '  - S (90%)', '    - A (0%, 11/1-11/4)', '  - B (100%, 11/5)'].join('\n'), today);
  assert.equal(byTitle(nodes, 'S').progress, 0);
  assert.equal(byTitle(nodes, 'P').progress, 20);
});

test('a summary date is the branch target; a later rolled-up end is late', () => {
  const { nodes } = parseProject(EXAMPLE, today);
  const design = byTitle(nodes, '設計');
  assert.equal(design.target, '2026-11-20');
  assert.equal(design.late, false);
  const late = parseProject(['- 設計 (11/8)', '  - 線框圖 (11/2-11/4)', '  - 視覺稿 (11/4-11/10)'].join('\n'), today).nodes[0];
  assert.equal(late.target, '2026-11-08');
  assert.equal(late.end, '2026-11-10');
  assert.equal(late.late, true);
  const range = parseProject(['- S (11/1-11/12)', '  - A (11/2-11/12)'].join('\n'), today).nodes[0];
  assert.equal(range.target, '2026-11-12');
  assert.equal(range.late, false);
});

test('assignees are inherited until a node names its own', () => {
  const { nodes } = parseProject(['- P (@PM)', '  - A (11/1)', '    - A1 (11/2)', '  - B (11/3, @小王)', '    - B1 (11/4)'].join('\n'), today);
  assert.deepEqual(byTitle(nodes, 'A').assignees, [{ name: 'PM', style: 'at' }]);
  assert.equal(byTitle(nodes, 'A').inherited, true);
  assert.deepEqual(byTitle(nodes, 'A1').assignees, [{ name: 'PM', style: 'at' }]);
  assert.deepEqual(byTitle(nodes, 'B').assignees, [{ name: '小王', style: 'at' }]);
  assert.equal(byTitle(nodes, 'B').inherited, false);
  assert.deepEqual(byTitle(nodes, 'B1').assignees, [{ name: '小王', style: 'at' }]);
  assert.equal(byTitle(nodes, 'P').inherited, false);
});

test('progress steps stop at 100 and Done sets 100', () => {
  assert.equal(stepProgress(30, 10), 40);
  assert.equal(stepProgress(30, 20), 50);
  assert.equal(stepProgress(30, 'done'), 100);
  assert.equal(canStep(90, 10), true);
  assert.equal(canStep(90, 20), false);
  assert.equal(canStep(95, 10), false);
  assert.equal(canStep(100, 'done'), false);
  assert.equal(canStep(0, 'done'), true);
  assert.equal(stepProgress(95, 10), 100);
});

test('promote and demote replace only the title', () => {
  assert.equal(taskNoteName('視覺稿 [[AAA|阿A]] / v2?'), '視覺稿 阿A v2');
  const promoted = promoteLine('    - 視覺稿 (30%, 11/4-11/10, @小王) ^v1', today, '視覺稿');
  assert.equal(promoted, '    - [[視覺稿]] (30%, 11/4-11/10, @小王) ^v1');
  assert.deepEqual(linkedTaskNote('[[視覺稿]]'), { target: '視覺稿' });
  assert.deepEqual(demoteLine(promoted, today), { text: '    - 視覺稿 (30%, 11/4-11/10, @小王) ^v1', target: '視覺稿' });
  assert.deepEqual(demoteLine('- [[Tasks/API|後端 API]]', today), { text: '- 後端 API', target: 'Tasks/API' });
  assert.equal(promoteLine('- [ ] 前端', today, '前端'), '- [ ] [[前端]]');
  assert.throws(() => promoteLine(promoted, today, 'x'));
  assert.throws(() => demoteLine('- 視覺稿', today));
  assert.equal(retitleLine('- [x] Old (30%) ^a', today, 'New'), '- [x] New (30%) ^a');
});

test('assignee cells and the @ to [[ ]] upgrade', () => {
  assert.deepEqual(parseAssigneeInput('小王, by [[AAA]]、[[B|Bee]]'), [
    { name: '小王', style: 'at' }, { name: 'AAA', style: 'link' }, { name: 'B', style: 'link', alias: 'Bee' }]);
  assert.deepEqual(parseAssigneeInput(''), []);
  assert.equal(parseAssigneeInput('two words'), undefined);
  assert.deepEqual(upgradeAssignee([{ name: '小王', style: 'at' }, { name: 'B', style: 'at' }], '小王'),
    [{ name: '小王', style: 'link' }, { name: 'B', style: 'at' }]);
});

test('fixed date phrases resolve against today (Thursday 2026-11-05)', () => {
  const at = (text: string) => dateHint(text, today)?.date;
  assert.equal(at('今天'), '2026-11-05');
  assert.equal(at('明天'), '2026-11-06');
  assert.equal(at('後天'), '2026-11-07');
  assert.equal(at('本週五'), '2026-11-06');
  assert.equal(at('本週一'), '2026-11-02');
  assert.equal(at('下週一'), '2026-11-09');
  assert.equal(at('下週日'), '2026-11-15');
  assert.equal(at('社群貼文 下週一前'), '2026-11-09');
  assert.equal(at('週四前'), '2026-11-05');
  assert.equal(at('週三前'), '2026-11-11');
  assert.equal(at('月底'), '2026-11-30');
  assert.equal(at('月初'), '2026-12-01');
  assert.equal(at('20號前'), '2026-11-20');
  assert.equal(at('3號前'), '2026-12-03');
  assert.equal(dateHint('12/31 月初', '2026-12-31')?.date, '2027-01-01');
  assert.equal(at('沒有日期'), undefined);
});

test('找小王 suggests an assignee; hints skip what the task already has', () => {
  assert.deepEqual(assignHint('找小王'), { name: '小王', phrase: '找小王' });
  assert.equal(assignHint('沒人'), undefined);
  assert.deepEqual(taskHints('找小王 明天', today, { dated: false, assigned: false }).map(hint => hint.kind), ['date', 'assign']);
  assert.deepEqual(taskHints('找小王 明天', today, { dated: true, assigned: true }), []);
});
