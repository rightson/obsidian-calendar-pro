import assert from 'node:assert/strict';
import test from 'node:test';
import type { Workspace, WorkspaceLeaf } from 'obsidian';
import { calendarOpenModeForClick, ensureSidebarView, FILE_EXPLORER_VIEW_TYPE, leafBelowFileExplorer, noteSplitLeaf, oppositeTabLeaf, openCalendarLeaf, sideTabLeaf } from '../src/calendar-open';

const viewType = 'calendar-pro-view';

test('only Ctrl or Cmd changes a ribbon click to a right split', () => {
  assert.equal(calendarOpenModeForClick({ ctrlKey: false, metaKey: false }), 'tab');
  assert.equal(calendarOpenModeForClick({ ctrlKey: true, metaKey: false }), 'right-split');
  assert.equal(calendarOpenModeForClick({ ctrlKey: false, metaKey: true }), 'right-split');
  assert.equal(calendarOpenModeForClick({ ctrlKey: true, metaKey: true }), 'right-split');
});

function fakeWorkspace() {
  const calls: string[] = [];
  const activeNote = { view: { getViewType: () => 'markdown' }, path: 'Notes/Current.md' };
  const oldCalendar = { view: { getViewType: () => viewType } };
  const created: Array<{ mode: string; leaf: WorkspaceLeaf }> = [];
  const workspace = {
    activeLeaf: activeNote,
    getLeavesOfType: () => [oldCalendar],
    getLeaf(mode: string, direction?: string) {
      calls.push(`getLeaf:${mode}:${direction ?? ''}`);
      const leaf = {
        view: { getViewType: () => 'empty' },
        async setViewState(state: { type: string; active: boolean }) {
          calls.push(`setViewState:${state.type}:${state.active}`);
          this.view = { getViewType: () => state.type };
        },
      };
      created.push({ mode, leaf: leaf as unknown as WorkspaceLeaf });
      return leaf as unknown as WorkspaceLeaf;
    },
    async revealLeaf(leaf: WorkspaceLeaf) {
      assert.equal(leaf, created.at(-1)?.leaf);
      calls.push('revealLeaf');
    },
  } as unknown as Workspace;
  return { workspace, calls, activeNote, oldCalendar, created };
}

test('normal opening creates a fresh tab, then reveals it without replacing the active note', async () => {
  const { workspace, calls, activeNote, oldCalendar, created } = fakeWorkspace();
  const leaf = await openCalendarLeaf(workspace, viewType, 'tab');
  assert.equal(leaf, created[0].leaf);
  assert.notEqual(leaf, oldCalendar);
  assert.equal(workspace.activeLeaf, activeNote);
  assert.equal(activeNote.view.getViewType(), 'markdown');
  assert.deepEqual(calls, ['getLeaf:tab:', `setViewState:${viewType}:true`, 'revealLeaf']);
});

test('modified opening creates a vertical split to the right before revealing it', async () => {
  const { workspace, calls, activeNote, created } = fakeWorkspace();
  const leaf = await openCalendarLeaf(workspace, viewType, 'right-split');
  assert.equal(leaf, created[0].leaf);
  assert.equal(created[0].mode, 'split');
  assert.equal(workspace.activeLeaf, activeNote);
  assert.deepEqual(calls, ['getLeaf:split:vertical', `setViewState:${viewType}:true`, 'revealLeaf']);
});

type Item = { name?: string; parent?: Item | null; children?: Item[]; direction?: string; activeTime?: number; getRoot?: () => Item };

/** A minimal Obsidian layout tree: splits and tab groups hold children; leaves know their root. */
function layout() {
  const rootSplit: Item = { name: 'root', parent: null, children: [], direction: 'vertical' };
  const rightSplit: Item = { name: 'right sidebar', parent: null, children: [], direction: 'horizontal' };
  const leftSplit: Item = { name: 'left sidebar', parent: null, children: [], direction: 'horizontal' };
  const add = (parent: Item, item: Item) => { item.parent = parent; parent.children!.push(item); return item; };
  const rootOf = (item: Item) => { let node = item; while (node.parent) node = node.parent; return node; };
  const leaf = (tabs: Item, name: string, activeTime = 0) => add(tabs, { name, activeTime, getRoot() { return rootOf(this as Item); } });
  const tabs = (parent: Item) => add(parent, { children: [] });
  const leaves = () => {
    const all: Item[] = [];
    const walk = (item: Item) => item.children ? item.children.forEach(walk) : all.push(item);
    [rootSplit, leftSplit, rightSplit].forEach(walk);
    return all;
  };
  const splits: Array<{ from: unknown; direction: string; before?: boolean }> = [];
  const workspace = {
    rootSplit, leftSplit, rightSplit,
    iterateAllLeaves(callback: (leaf: WorkspaceLeaf) => void) { leaves().forEach(item => callback(item as unknown as WorkspaceLeaf)); },
    getMostRecentLeaf(root: Item) {
      const inside = leaves().filter(item => { for (let node: Item | null | undefined = item; node; node = node.parent) if (node === root) return true; return false; });
      return (inside.sort((a, b) => (b.activeTime ?? 0) - (a.activeTime ?? 0))[0] ?? null) as unknown as WorkspaceLeaf | null;
    },
    createLeafInParent(parent: Item, index: number) {
      const created: Item = { name: 'new tab', parent, getRoot() { return rootOf(this as Item); } };
      parent.children!.splice(index, 0, created);
      return created as unknown as WorkspaceLeaf;
    },
    createLeafBySplit(from: Item, direction: string, before?: boolean) {
      splits.push({ from, direction, ...before ? { before } : {} });
      const split = add(from.parent!.parent!, { children: [] });
      return leaf(split, `split ${splits.length}`) as unknown as WorkspaceLeaf;
    },
  } as unknown as Workspace;
  return { workspace, rootSplit, leftSplit, rightSplit, tabs, leaf, splits };
}
const asLeaf = (item: Item) => item as unknown as WorkspaceLeaf;

test('a calendar on the right opens notes in a new tab of the pane on its left', () => {
  const { workspace, rootSplit, tabs, leaf } = layout();
  const left = tabs(rootSplit);
  leaf(left, 'older', 1);
  const recent = leaf(left, 'recent', 2);
  const calendar = leaf(tabs(rootSplit), 'calendar', 3);
  const opened = oppositeTabLeaf(workspace, asLeaf(calendar)) as unknown as Item;
  assert.equal(opened.parent, left);
  assert.equal(left.children!.indexOf(opened), left.children!.indexOf(recent) + 1);
});

test('a calendar on the left opens notes in the pane on its right', () => {
  const { workspace, rootSplit, tabs, leaf } = layout();
  const calendar = leaf(tabs(rootSplit), 'calendar');
  const right = tabs(rootSplit);
  leaf(right, 'note');
  assert.equal((oppositeTabLeaf(workspace, asLeaf(calendar)) as unknown as Item).parent, right);
});

test('panes stacked above or below the calendar do not count as its far side', () => {
  const { workspace, rootSplit, tabs, leaf } = layout();
  const left = tabs(rootSplit);
  leaf(left, 'note');
  const column: Item = { parent: rootSplit, children: [], direction: 'horizontal' };
  rootSplit.children!.push(column);
  leaf(tabs(column), 'below');
  const calendar = leaf(tabs(column), 'calendar');
  assert.equal((oppositeTabLeaf(workspace, asLeaf(calendar)) as unknown as Item).parent, left);
});

test('a calendar in a sidebar opens notes in the main area', () => {
  const { workspace, rootSplit, rightSplit, tabs, leaf } = layout();
  const main = tabs(rootSplit);
  leaf(main, 'note');
  const calendar = leaf(tabs(rightSplit), 'calendar');
  assert.equal((oppositeTabLeaf(workspace, asLeaf(calendar)) as unknown as Item).parent, main);
});

test('a calendar with nothing beside it has no far side', () => {
  const { workspace, rootSplit, tabs, leaf } = layout();
  const group = tabs(rootSplit);
  leaf(group, 'note');
  const calendar = leaf(group, 'calendar');
  assert.equal(oppositeTabLeaf(workspace, asLeaf(calendar)), undefined);
});

test('notes beside a lone calendar open in one split of it and reuse it while open', () => {
  const { workspace, rootSplit, tabs, leaf, splits } = layout();
  const calendar = asLeaf(leaf(tabs(rootSplit), 'calendar'));
  const first = noteSplitLeaf(workspace, calendar);
  assert.deepEqual(splits, [{ from: calendar, direction: 'vertical' }]);
  assert.equal(noteSplitLeaf(workspace, calendar, first), first);
  assert.equal(splits.length, 1);
  const group = (first as unknown as Item).parent!;
  rootSplit.children!.splice(rootSplit.children!.indexOf(group), 1);
  const second = noteSplitLeaf(workspace, calendar, first);
  assert.notEqual(second, first);
  assert.equal(splits.length, 2);
  assert.notEqual(noteSplitLeaf(workspace, calendar, calendar), calendar);
});

test('notes beside a calendar use the pane already on its far side instead of splitting it', () => {
  const { workspace, rootSplit, tabs, leaf, splits } = layout();
  const left = tabs(rootSplit);
  leaf(left, 'note');
  const calendar = asLeaf(leaf(tabs(rootSplit), 'calendar'));
  const first = noteSplitLeaf(workspace, calendar);
  assert.equal((first as unknown as Item).parent, left);
  assert.equal(noteSplitLeaf(workspace, calendar, first), first);
  assert.equal(splits.length, 0);
});

test('Left and Right open a new tab in the pane on that side of the calendar', () => {
  const { workspace, rootSplit, tabs, leaf, splits } = layout();
  const left = tabs(rootSplit);
  leaf(left, 'left note');
  const calendar = asLeaf(leaf(tabs(rootSplit), 'calendar'));
  const right = tabs(rootSplit);
  leaf(right, 'right note');
  assert.equal((sideTabLeaf(workspace, calendar, 'left') as unknown as Item).parent, left);
  assert.equal((sideTabLeaf(workspace, calendar, 'right') as unknown as Item).parent, right);
  assert.equal(splits.length, 0);
});

test('Left or Right with no pane on that side splits the calendar on that side', () => {
  const { workspace, rootSplit, tabs, leaf, splits } = layout();
  leaf(tabs(rootSplit), 'note');
  const calendar = asLeaf(leaf(tabs(rootSplit), 'calendar'));
  assert.notEqual((sideTabLeaf(workspace, calendar, 'left') as unknown as Item).parent, (calendar as unknown as Item).parent);
  assert.equal(splits.length, 0);
  sideTabLeaf(workspace, calendar, 'right');
  assert.deepEqual(splits, [{ from: calendar, direction: 'vertical' }]);
  const alone = layout();
  const lone = asLeaf(alone.leaf(alone.tabs(alone.rootSplit), 'calendar'));
  sideTabLeaf(alone.workspace, lone, 'left');
  assert.deepEqual(alone.splits, [{ from: lone, direction: 'vertical', before: true }]);
});

test('from a right sidebar, Left opens in the main area and Right splits the sidebar', () => {
  const { workspace, rootSplit, rightSplit, tabs, leaf, splits } = layout();
  const main = tabs(rootSplit);
  leaf(main, 'note');
  const calendar = asLeaf(leaf(tabs(rightSplit), 'calendar'));
  assert.equal((sideTabLeaf(workspace, calendar, 'left') as unknown as Item).parent, main);
  sideTabLeaf(workspace, calendar, 'right');
  assert.deepEqual(splits, [{ from: calendar, direction: 'vertical' }]);
});

test('the month calendar goes below the file explorer in the left sidebar', () => {
  const leftSplit = {}; const rightSplit = {};
  const calls: unknown[][] = [];
  const explorer = { getRoot: () => leftSplit };
  const below = { name: 'below' };
  const workspace = {
    leftSplit, rightSplit,
    getLeavesOfType: (type: string) => type === FILE_EXPLORER_VIEW_TYPE ? [explorer] : [],
    createLeafBySplit: (...args: unknown[]) => { calls.push(args); return below; },
    getLeftLeaf: () => { throw new Error('should split the explorer'); },
  } as unknown as Workspace;
  assert.equal(leafBelowFileExplorer(workspace), below as unknown as WorkspaceLeaf);
  assert.deepEqual(calls, [[explorer, 'horizontal']]);
});

test('without a file explorer in the left sidebar the month calendar takes a new left group', () => {
  const leftSplit = {}; const fallback = { name: 'left' };
  const splits: boolean[] = [];
  const workspace = {
    leftSplit,
    getLeavesOfType: () => [{ getRoot: () => ({}) }],
    createLeafBySplit: () => { throw new Error('the explorer is not in the left sidebar'); },
    getLeftLeaf: (split: boolean) => { splits.push(split); return fallback; },
  } as unknown as Workspace;
  assert.equal(leafBelowFileExplorer(workspace), fallback as unknown as WorkspaceLeaf);
  assert.deepEqual(splits, [true]);
});

test('startup adds the month calendar to the right sidebar only when it is not open anywhere', async () => {
  const states: unknown[] = [];
  const right = { setViewState: async (state: unknown) => { states.push(state); } };
  let open: unknown[] = [];
  const workspace = { getLeavesOfType: () => open, getRightLeaf: () => right } as unknown as Workspace;
  assert.equal(await ensureSidebarView(workspace, 'months'), right as unknown as WorkspaceLeaf);
  assert.deepEqual(states, [{ type: 'months', active: false }]);
  open = [{}];
  assert.equal(await ensureSidebarView(workspace, 'months'), undefined);
  assert.equal(states.length, 1);
});
