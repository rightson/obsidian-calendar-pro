import { TFile, type App, type CachedMetadata } from 'obsidian';
import { parseProject, projectTaskEvents, type TaskEvent } from './tasks';

/** Notes with a `gantt` frontmatter key, whatever its value. */
export function isProjectCache(cache: CachedMetadata | null | undefined): boolean {
  const frontmatter = cache?.frontmatter;
  return !!frontmatter && Object.prototype.hasOwnProperty.call(frontmatter, 'gantt');
}

/**
 * The dated tasks of every Project Note, for the calendar. Nothing is cached
 * beyond this session's memory: each change to a note re-reads its text.
 */
export class ProjectIndex {
  private projects = new Map<string, TaskEvent[]>();

  constructor(private readonly app: App, private readonly today: () => string, private readonly changed: () => void) {}

  events(): TaskEvent[] { return [...this.projects.values()].flat(); }

  find(id: string): TaskEvent | undefined { return this.events().find(event => event.id === id); }

  async scanAll(): Promise<void> {
    const next = new Map<string, TaskEvent[]>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!isProjectCache(this.app.metadataCache.getFileCache(file))) continue;
      next.set(file.path, projectTaskEvents(file.path, parseProject(await this.app.vault.cachedRead(file), this.today())));
    }
    this.projects = next;
    this.changed();
  }

  /** Re-read one note after the metadata cache saw it change. */
  update(file: TFile, content: string, cache: CachedMetadata | null): void {
    const was = this.projects.has(file.path);
    if (isProjectCache(cache)) this.projects.set(file.path, projectTaskEvents(file.path, parseProject(content, this.today())));
    else if (was) this.projects.delete(file.path);
    else return;
    this.changed();
  }

  remove(path: string): void {
    if (this.projects.delete(path)) this.changed();
  }

  async rename(file: TFile, oldPath: string): Promise<void> {
    if (!this.projects.delete(oldPath)) return;
    if (isProjectCache(this.app.metadataCache.getFileCache(file))) {
      this.projects.set(file.path, projectTaskEvents(file.path, parseProject(await this.app.vault.cachedRead(file), this.today())));
    }
    this.changed();
  }
}
