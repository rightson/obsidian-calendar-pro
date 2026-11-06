import { normalizePath, TFile, type App, type Plugin } from 'obsidian';
import type { RecoveryJournal, StoreIO } from './store';
import type { StoredState } from './state';

/** Vault backed compare-and-swap adapter. The store serializes transactions above it. */
export function createObsidianStoreIO(app: App, plugin: Plugin): StoreIO {
  const journalPath = `${plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`}/recovery.json`;
  const fileAt = (path: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(path);
    if (file === null) return null;
    if (!(file instanceof TFile)) throw new Error(`Expected Markdown file: ${path}`);
    return file;
  };
  const read = async (path: string): Promise<string | null> => {
    const file = fileAt(path);
    return file ? app.vault.read(file) : null;
  };
  const ensureParent = async (path: string): Promise<void> => {
    const parts = path.split('/');
    parts.pop();
    let folder = '';
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
    }
  };
  const adapter = app.vault.adapter;
  return {
    read,
    async write(path, before, after) {
      const actual = await read(path);
      if (actual !== before) throw new Error(`Note changed before write: ${path}`);
      if (before === after) return;
      if (after === null) {
        const file = fileAt(path);
        if (file) await app.fileManager.trashFile(file);
      } else if (before === null) {
        await ensureParent(path);
        await app.vault.create(path, after);
      } else {
        const file = fileAt(path);
        if (!file) throw new Error(`Note disappeared before write: ${path}`);
        await app.vault.process(file, current => {
          if (current !== before) throw new Error(`Note changed before write: ${path}`);
          return after;
        });
      }
    },
    async listMarkdown() { return app.vault.getMarkdownFiles().map(file => file.path); },
    async loadData() { return (await plugin.loadData() as StoredState | null) ?? null; },
    async saveData(state) { await plugin.saveData(state); },
    async loadJournal() {
      if (!await adapter.exists(journalPath)) return null;
      return JSON.parse(await adapter.read(journalPath)) as RecoveryJournal;
    },
    async saveJournal(journal) {
      const parent = normalizePath(journalPath.slice(0, journalPath.lastIndexOf('/')));
      if (!await adapter.exists(parent)) await adapter.mkdir(parent);
      await adapter.write(journalPath, JSON.stringify(journal));
    },
    async clearJournal() { if (await adapter.exists(journalPath)) await adapter.remove(journalPath); },
  };
}
