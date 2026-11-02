import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// ItemView's constructor assigns these, but obsidian.d.ts does not declare them,
// so TypeScript cannot catch a subclass field with the same name. With ES2022
// class fields such a field resets the member to undefined after super() and
// Obsidian's own load() then fails on it, leaving the view blank.
const UNDECLARED_ITEM_VIEW_MEMBERS = [
  'headerEl', 'titleContainerEl', 'titleParentEl', 'titleEl', 'actionsEl',
  'backButtonEl', 'forwardButtonEl', 'moreOptionsButtonEl', 'canDropAnywhere',
];

const srcDir = new URL('../src/', import.meta.url);

function viewFields(): Map<string, string[]> {
  const views = new Map<string, string[]>();
  for (const file of readdirSync(srcDir).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, srcDir), 'utf8');
    for (const match of source.matchAll(/^export class (\w+) extends (?:Item)?View\b[^\n]*\n([\s\S]*?)^}/gm)) {
      const fields = [...match[2].matchAll(/^ {2}(?:(?:private|protected|public|readonly|declare|override) )*(\w+)[?!]?\s*[:=]/gm)].map(field => field[1]);
      views.set(`${file}:${match[1]}`, fields);
    }
  }
  return views;
}

test('view classes do not redeclare members that ItemView assigns', () => {
  const views = viewFields();
  assert.ok(views.size >= 3, `expected the calendar, events, and months views, found ${[...views.keys()].join(', ')}`);
  for (const [view, fields] of views) {
    const clashes = fields.filter(field => UNDECLARED_ITEM_VIEW_MEMBERS.includes(field));
    assert.deepEqual(clashes, [], `${view} declares ${clashes.join(', ')}, which hides ItemView's own member`);
  }
});
