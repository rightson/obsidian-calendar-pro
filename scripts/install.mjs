import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const vaultArg = process.argv[2];
if (process.argv.length !== 3 || !vaultArg || !isAbsolute(vaultArg)) {
  throw new Error('Usage: node scripts/install.mjs /absolute/path/to/test-vault');
}
const vault = resolve(vaultArg);
if (vault === root || !basename(vault).toLowerCase().includes('test')) {
  throw new Error('The explicit destination must be a dedicated test Vault (include "test" in its folder name).');
}
const vaultInfo = await stat(vault);
if (!vaultInfo.isDirectory()) throw new Error('The test Vault path must be a directory.');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (manifest.id !== 'calendar-pro') throw new Error('Unexpected plugin ID in manifest.');
await stat(join(root, 'main.js'));
const target = join(vault, '.obsidian', 'plugins', manifest.id);
await mkdir(target, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  if ((await readdir(root)).includes(name)) await copyFile(join(root, name), join(target, name));
}
console.log(`Installed ${manifest.id} into ${target}`);
