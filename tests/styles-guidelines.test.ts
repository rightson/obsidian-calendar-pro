import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

test('styles.css does not use !important', () => {
  assert.doesNotMatch(css, /!important/);
});

test('styles.css uses the gap shorthand instead of column-gap', () => {
  assert.doesNotMatch(css, /column-gap/);
});

test('styles.css does not use the underline dotted shorthand', () => {
  assert.doesNotMatch(css, /underline\s+dotted/);
});
