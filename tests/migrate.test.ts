import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateLegacyData, type MigrationFiles } from '../src/migrate';

const plugins = '.obsidian/plugins';
const own = `${plugins}/event-notes`;

function memoryFiles(initial: Record<string, string>): MigrationFiles & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map(Object.entries(initial));
  const dirs = new Set<string>();
  return {
    files, dirs,
    async exists(path) { return files.has(path) || dirs.has(path) || [...files.keys()].some(key => key.startsWith(`${path}/`)); },
    async read(path) { const text = files.get(path); if (text === undefined) throw new Error(`missing ${path}`); return text; },
    async write(path, data) { files.set(path, data); },
    async mkdir(path) { dirs.add(path); },
  };
}

const manifest = (id: string, author: string) => JSON.stringify({ id, author });

test('imports data.json and recovery.json from Calendar Pro by the same author', async () => {
  const io = memoryFiles({
    [`${plugins}/calendar-pro/manifest.json`]: manifest('calendar-pro', 'rightson'),
    [`${plugins}/calendar-pro/data.json`]: '{"settings":{"a":1}}',
    [`${plugins}/calendar-pro/recovery.json`]: '{"writes":[]}',
  });
  const result = await migrateLegacyData(io, plugins, own);
  assert.deepEqual(result, { from: 'calendar-pro', name: 'Calendar Pro', files: ['data.json', 'recovery.json'] });
  assert.equal(io.files.get(`${own}/data.json`), '{"settings":{"a":1}}');
  assert.equal(io.files.get(`${own}/recovery.json`), '{"writes":[]}');
});

test('ignores a calendar-pro folder from another author and falls back to Calendar-Note', async () => {
  const io = memoryFiles({
    [`${plugins}/calendar-pro/manifest.json`]: manifest('calendar-pro', 'Kuzen'),
    [`${plugins}/calendar-pro/data.json`]: '{"other":true}',
    [`${plugins}/calendar-note/manifest.json`]: manifest('calendar-note', 'rightson'),
    [`${plugins}/calendar-note/data.json`]: '{"mine":true}',
  });
  const result = await migrateLegacyData(io, plugins, own);
  assert.equal(result?.from, 'calendar-note');
  assert.equal(io.files.get(`${own}/data.json`), '{"mine":true}');
});

test('does nothing when Event Notes already has settings', async () => {
  const io = memoryFiles({
    [`${own}/data.json`]: '{"current":true}',
    [`${plugins}/calendar-pro/manifest.json`]: manifest('calendar-pro', 'rightson'),
    [`${plugins}/calendar-pro/data.json`]: '{"old":true}',
  });
  assert.equal(await migrateLegacyData(io, plugins, own), null);
  assert.equal(io.files.get(`${own}/data.json`), '{"current":true}');
});

test('skips folders without a manifest, with broken JSON, or without data.json', async () => {
  const io = memoryFiles({
    [`${plugins}/calendar-pro/data.json`]: '{"noManifest":true}',
    [`${plugins}/calendar-note/manifest.json`]: manifest('calendar-note', 'rightson'),
    [`${plugins}/calendar-note/data.json`]: '{broken',
  });
  assert.equal(await migrateLegacyData(io, plugins, own), null);
  assert.equal(io.files.has(`${own}/data.json`), false);
});
