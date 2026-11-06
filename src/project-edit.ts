import { splitFrontmatter } from './notes';

/**
 * Text edits for Project Notes. Every Gantt write is a function from the
 * note's current text to its next text, applied to the open editor or to the
 * file; these helpers build and compare those texts.
 */

const strip = (text: string) => text.replace(/\r$/, '');

/**
 * Replace the line that read `expected`, at `line` or, when lines moved, the
 * one line in the note that still reads exactly `expected`.
 */
export function replaceLine(content: string, line: number, expected: string, compute: (text: string) => string): string {
  const lines = content.split('\n');
  let index = line;
  if (strip(lines[index] ?? '') !== strip(expected)) {
    const matches = lines.flatMap((text, at) => strip(text) === strip(expected) ? [at] : []);
    if (matches.length !== 1) throw new Error('That line changed in the note. The Gantt view has been reloaded; try again.');
    index = matches[0];
  }
  const cr = lines[index].endsWith('\r') ? '\r' : '';
  lines[index] = compute(strip(lines[index])) + cr;
  return lines.join('\n');
}

const GANTT_KEY = /^gantt\s*:/;

/** A note is a Project when its frontmatter has a `gantt` key, whatever its value. */
export function hasGanttKey(content: string): boolean {
  return splitFrontmatter(content).lines.some(line => GANTT_KEY.test(line));
}

/** Mark the note as a Project with `gantt: true`, leaving existing frontmatter as it is. */
export function ensureGanttKey(content: string): string {
  if (hasGanttKey(content)) return content;
  const fm = splitFrontmatter(content);
  const bom = content.startsWith('﻿') ? '﻿' : '';
  if (!fm.has) return `${bom}---${fm.newline}gantt: true${fm.newline}---${fm.newline}${content.slice(bom.length)}`;
  const lines = [...fm.lines.filter((line, index) => line.trim() || index < fm.lines.length - 1), 'gantt: true'];
  return `${bom}---${fm.newline}${lines.join(fm.newline)}${fm.newline}---${fm.newline}${fm.body}`;
}

/** A replaced span of the old text, by character offsets. */
export interface TextHunk { from: number; to: number; text: string; removed: string[]; added: string[]; line: number }

function lineStarts(lines: string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
  return starts;
}

/**
 * The changed line spans between two texts. Applying the hunks to `before`
 * from last to first yields `after`, so an editor keeps the cursor and the
 * untouched lines between two separate changes.
 */
export function lineHunks(before: string, after: string): TextHunk[] {
  if (before === after) return [];
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  // Pairs of matching middle lines, from a longest common subsequence when it is small enough to compute.
  const pairs: [number, number][] = [];
  if (midA.length * midB.length <= 4_000_000) {
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { pairs.push([i, j]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) i++;
      else j++;
    }
  }
  pairs.push([midA.length, midB.length]);
  const starts = lineStarts(a);
  const hunks: TextHunk[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of pairs) {
    if (pi > i || pj > j) {
      const fromA = head + i, toA = head + pi;
      const removed = a.slice(fromA, toA);
      const added = midB.slice(j, pj);
      let from: number, to: number, text: string;
      if (!added.length) {
        // A deletion also takes one newline: the one after it, or before it at the end.
        if (toA < a.length) { from = starts[fromA]; to = starts[toA]; }
        else { from = starts[fromA] - 1; to = before.length; }
        text = '';
      } else if (!removed.length) {
        if (fromA < a.length) { from = to = starts[fromA]; text = `${added.join('\n')}\n`; }
        else { from = to = before.length; text = `\n${added.join('\n')}`; }
      } else {
        from = starts[fromA];
        to = starts[toA - 1] + a[toA - 1].length;
        text = added.join('\n');
      }
      hunks.push({ from: Math.max(0, from), to, text, removed, added, line: fromA });
    }
    i = pi + 1; j = pj + 1;
  }
  return hunks;
}

export function applyHunks(before: string, hunks: TextHunk[]): string {
  return [...hunks].reverse().reduce((text, hunk) => text.slice(0, hunk.from) + hunk.text + text.slice(hunk.to), before);
}
