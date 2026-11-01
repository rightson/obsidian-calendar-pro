import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundledLicenses } from './licenses.mjs';

const root = resolve(import.meta.dirname, '..');
const packageRoot = join(root, 'dist', 'calendar-pro');
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
if (manifest.id !== 'calendar-pro') throw new Error('Unexpected plugin ID in manifest.');
await stat(join(root, 'main.js'));
await rm(packageRoot, { recursive: true, force: true });
await mkdir(packageRoot, { recursive: true });
for (const name of ['main.js', 'manifest.json', 'LICENSE']) {
  await copyFile(join(root, name), join(packageRoot, name));
}
const optional = ['styles.css'];
for (const name of optional) {
  if ((await readdir(root)).includes(name)) await copyFile(join(root, name), join(packageRoot, name));
}
await writeFile(join(packageRoot, 'THIRD_PARTY_LICENSES.txt'), await bundledLicenses(root));
const dist = join(root, 'dist');
const archive = join(dist, 'calendar-pro.zip');
await rm(archive, { force: true });
const zip = spawnSync('zip', ['-q', '-X', '-r', archive, 'calendar-pro'], { cwd: dist, stdio: 'inherit' });
if (zip.error) throw zip.error;
if (zip.status !== 0) throw new Error(`zip exited with status ${zip.status}`);
console.log(`Packaged ${packageRoot} and ${archive}`);
