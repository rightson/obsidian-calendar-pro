/** Imports settings from this plugin's earlier IDs the first time Event Notes starts. */

/** Earlier IDs of this plugin, newest first. */
export const LEGACY_PLUGIN_IDS = ['calendar-pro', 'calendar-note'] as const;
export const LEGACY_AUTHOR = 'rightson';
const LEGACY_NAMES: Record<string, string> = { 'calendar-pro': 'Calendar Pro', 'calendar-note': 'Calendar-Note' };

/** The file operations the migration needs; Obsidian's DataAdapter provides all of them. */
export interface MigrationFiles {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface MigrationResult { from: string; name: string; files: string[] }

/**
 * When the plugin folder has no data.json, copies data.json and recovery.json from the
 * newest earlier folder of this plugin. A folder is only used when its manifest names
 * this plugin's author, so another plugin that reuses the same ID is never imported.
 */
export async function migrateLegacyData(files: MigrationFiles, pluginsDir: string, ownDir: string): Promise<MigrationResult | null> {
  if (await files.exists(`${ownDir}/data.json`)) return null;
  for (const id of LEGACY_PLUGIN_IDS) {
    const dir = `${pluginsDir}/${id}`;
    if (!await isOwnLegacyFolder(files, dir, id)) continue;
    const data = await readJsonObject(files, `${dir}/data.json`);
    if (data === null) continue;
    // A pending journal only makes sense with the state it was written against.
    const journal = await readJsonObject(files, `${dir}/recovery.json`);
    if (!await files.exists(ownDir)) await files.mkdir(ownDir);
    if (journal !== null) await files.write(`${ownDir}/recovery.json`, journal);
    await files.write(`${ownDir}/data.json`, data);
    return { from: id, name: LEGACY_NAMES[id] ?? id, files: journal === null ? ['data.json'] : ['data.json', 'recovery.json'] };
  }
  return null;
}

async function isOwnLegacyFolder(files: MigrationFiles, dir: string, id: string): Promise<boolean> {
  const path = `${dir}/manifest.json`;
  if (!await files.exists(path)) return false;
  try {
    const manifest = JSON.parse(await files.read(path)) as { id?: unknown; author?: unknown };
    return manifest.id === id && manifest.author === LEGACY_AUTHOR;
  } catch { return false; }
}

async function readJsonObject(files: MigrationFiles, path: string): Promise<string | null> {
  if (!await files.exists(path)) return null;
  const text = await files.read(path);
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? text : null;
  } catch { return null; }
}
