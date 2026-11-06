import type { Workspace, WorkspaceLeaf, WorkspaceParent, WorkspaceSplit } from 'obsidian';

export type CalendarOpenMode = 'tab' | 'right-split';

export function calendarOpenModeForClick(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>): CalendarOpenMode {
  return event.ctrlKey || event.metaKey ? 'right-split' : 'tab';
}

/** Always create a leaf; never replace the active note or reuse a previous calendar. */
export async function openCalendarLeaf(workspace: Workspace, viewType: string, mode: CalendarOpenMode): Promise<WorkspaceLeaf> {
  const leaf = mode === 'right-split' ? workspace.getLeaf('split', 'vertical') : workspace.getLeaf('tab');
  await leaf.setViewState({ type: viewType, active: true });
  await workspace.revealLeaf(leaf);
  return leaf;
}

/** Layout fields Obsidian keeps on workspace items at runtime but leaves out of its typings. */
interface LayoutItem { parent?: LayoutItem | null; children?: LayoutItem[]; direction?: string }

function newTabAfter(workspace: Workspace, anchor: WorkspaceLeaf): WorkspaceLeaf {
  const tabs = anchor.parent as unknown as LayoutItem;
  return workspace.createLeafInParent(tabs as unknown as WorkspaceSplit, (tabs.children?.indexOf(anchor) ?? -1) + 1);
}

function recentLeafIn(workspace: Workspace, item: LayoutItem): WorkspaceLeaf | undefined {
  const recent = workspace.getMostRecentLeaf(item as unknown as WorkspaceParent);
  if (recent) return recent;
  const leaves: WorkspaceLeaf[] = [];
  workspace.iterateAllLeaves(leaf => {
    for (let node: LayoutItem | null | undefined = leaf; node; node = node.parent) if (node === item) { leaves.push(leaf); return; }
  });
  return leaves[0];
}

export type NoteSide = 'left' | 'right';

/**
 * The leaf a note tab on one side of the calendar goes after: in the main area
 * when that side faces it from a sidebar, otherwise in the nearest pane on that
 * side. Panes stacked above or below the calendar do not count.
 */
function sideAnchor(workspace: Workspace, calendarLeaf: WorkspaceLeaf, side: NoteSide): WorkspaceLeaf | undefined {
  const root = calendarLeaf.getRoot();
  if (root === workspace.leftSplit || root === workspace.rightSplit) {
    const towardMain: NoteSide = root === workspace.rightSplit ? 'left' : 'right';
    return side === towardMain ? recentLeafIn(workspace, workspace.rootSplit) : undefined;
  }
  for (let node = calendarLeaf.parent as unknown as LayoutItem; node.parent; node = node.parent) {
    const { children, direction } = node.parent;
    if (direction !== 'vertical' || !children) continue;
    const neighbour = children[children.indexOf(node) + (side === 'left' ? -1 : 1)];
    const anchor = neighbour && recentLeafIn(workspace, neighbour);
    if (anchor) return anchor;
  }
  return undefined;
}

/**
 * A new tab on the far side of the calendar: the pane on its left when there is
 * one, else the one on its right, or the main area for a sidebar calendar.
 * Undefined when nothing is beside it.
 */
export function oppositeTabLeaf(workspace: Workspace, calendarLeaf: WorkspaceLeaf): WorkspaceLeaf | undefined {
  const anchor = sideAnchor(workspace, calendarLeaf, 'left') ?? sideAnchor(workspace, calendarLeaf, 'right');
  return anchor && newTabAfter(workspace, anchor);
}

/** A new tab in the pane on `side` of the calendar, splitting the calendar when nothing is there. */
export function sideTabLeaf(workspace: Workspace, calendarLeaf: WorkspaceLeaf, side: NoteSide): WorkspaceLeaf {
  const anchor = sideAnchor(workspace, calendarLeaf, side);
  return anchor ? newTabAfter(workspace, anchor) : workspace.createLeafBySplit(calendarLeaf, 'vertical', side === 'left');
}

/**
 * Notes opened beside the calendar go in one leaf, reused while it stays open:
 * a new tab on the far side when a pane is already there, else a split of the calendar.
 */
export function noteSplitLeaf(workspace: Workspace, calendarLeaf: WorkspaceLeaf, previous?: WorkspaceLeaf): WorkspaceLeaf {
  let open = false;
  if (previous && previous !== calendarLeaf) workspace.iterateAllLeaves(leaf => { if (leaf === previous) open = true; });
  return open ? previous! : oppositeTabLeaf(workspace, calendarLeaf) ?? workspace.createLeafBySplit(calendarLeaf, 'vertical');
}

export const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';

/**
 * A leaf stacked under the file explorer in the left sidebar, so the two share it
 * one above the other. Without an explorer there, a new group at the bottom of the
 * left sidebar.
 */
export function leafBelowFileExplorer(workspace: Workspace): WorkspaceLeaf | null {
  const explorer = workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE).find(leaf => leaf.getRoot() === workspace.leftSplit);
  return explorer ? workspace.createLeafBySplit(explorer, 'horizontal') : workspace.getLeftLeaf(true);
}

/**
 * Adds a view to the right sidebar unless one is already open anywhere, so a
 * tab the user dragged elsewhere (for example under the file explorer) stays put.
 * Returns the leaf it created, if any. It does not take focus.
 */
export async function ensureSidebarView(workspace: Workspace, viewType: string): Promise<WorkspaceLeaf | undefined> {
  if (workspace.getLeavesOfType(viewType).length) return undefined;
  const leaf = workspace.getRightLeaf(false);
  if (!leaf) return undefined;
  await leaf.setViewState({ type: viewType, active: false });
  return leaf;
}
