import * as esbuild from 'esbuild';
import { watch } from 'node:fs';
import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { bundleOptions } from './build-options.mjs';

// Rebuilds main.js into a Vault's plugin folder on every source change, and
// copies manifest.json and styles.css when they change. With the Hot Reload
// community plugin installed, Obsidian reloads Calendar Pro after each write.
const root = resolve(import.meta.dirname, '..');
const given = process.argv[2] ?? process.env.CALENDAR_PRO_VAULT;
if (!given) {
  throw new Error('Usage: npm run dev -- /absolute/path/to/Vault (or set CALENDAR_PRO_VAULT)');
}
const expanded = given.replace(/^~(?=$|\/)/, homedir());
if (!isAbsolute(expanded)) throw new Error(`The Vault path must be absolute: ${given}`);
const vault = resolve(expanded);
if (vault === root) throw new Error('The Vault must not be this repository.');
const isDirectory = async path => (await stat(path).catch(() => null))?.isDirectory() ?? false;
if (!await isDirectory(join(vault, '.obsidian'))) {
  throw new Error(`Not an Obsidian Vault (no .obsidian folder): ${vault}`);
}
const target = join(vault, '.obsidian', 'plugins', 'calendar-pro');
await mkdir(target, { recursive: true });

const assets = ['manifest.json', 'styles.css'];
const copyAsset = async name => {
  try { await copyFile(join(root, name), join(target, name)); console.log(`${time()} copied ${name}`); }
  catch (error) { console.error(`${time()} could not copy ${name}: ${error.message}`); }
};
for (const name of assets) await copyAsset(name);
// Hot Reload watches plugin folders that contain this marker file.
await writeFile(join(target, '.hotreload'), '', { flag: 'a' });

// Editors often replace a file instead of writing it in place, so watch the
// folder rather than each file, and let a burst of events settle first.
const pending = new Map();
watch(root, (_event, name) => {
  if (!assets.includes(name)) return;
  clearTimeout(pending.get(name));
  pending.set(name, setTimeout(() => void copyAsset(name), 100));
});

const context = await esbuild.context({
  ...bundleOptions,
  outfile: join(target, 'main.js'),
  sourcemap: 'inline',
  logLevel: 'warning',
  plugins: [{
    name: 'report',
    setup(build) {
      build.onEnd(result => {
        console.log(result.errors.length
          ? `${time()} build failed; Obsidian keeps the last good main.js`
          : `${time()} rebuilt main.js`);
      });
    },
  }],
});
await context.watch();
console.log(`Watching src/ → ${target}`);
console.log('Install the Hot Reload community plugin to reload Calendar Pro after each build; otherwise toggle the plugin off and on. Press Ctrl+C to stop.');

const stop = async () => { await context.dispose(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function time() { return new Date().toLocaleTimeString(); }
