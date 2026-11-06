import { MarkdownView, Modal, Notice, TFile, type App, type EditorChange } from 'obsidian';
import { ensureGanttKey, lineHunks, replaceLine } from './project-edit';
import type { PluginSettings } from './types';

/** Change one line, or a whole note, from its current text. */
export type Transform = (content: string) => string;

interface WriterHost {
  app: App;
  settings(): PluginSettings;
  updateSettings(change: (settings: PluginSettings) => void): Promise<void>;
  /** A Project Note changed through the writer. */
  written(path: string): void;
}

/**
 * Writes Gantt edits to Project Notes, one at a time. The open editor gets an
 * editor transaction so its cursor and undo history stay intact; a closed note
 * is changed with `vault.process`. Every write also marks the note with
 * `gantt: true`, and the first write to a note in a session can be previewed.
 */
export class ProjectWriter {
  private queue: Promise<unknown> = Promise.resolve();
  private confirmed = new Set<string>();

  constructor(private readonly host: WriterHost) {}

  private get app(): App { return this.host.app; }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  /** The source-mode editor showing this note, if any. */
  editorFor(path: string): MarkdownView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source') return view;
    }
    return undefined;
  }

  /** The note's text as the user currently sees it, unsaved editor changes included. */
  async read(file: TFile): Promise<string> {
    return this.editorFor(file.path)?.editor.getValue() ?? this.app.vault.read(file);
  }

  /** Apply `transform`; resolves false when nothing changed or the preview was cancelled. */
  write(path: string, transform: Transform): Promise<boolean> {
    return this.serialized(async () => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`${path} no longer exists.`);
      const full = (content: string) => ensureGanttKey(transform(content));
      const current = await this.read(file);
      const next = full(current);
      if (next === current) return false;
      if (this.host.settings().ganttConfirmWrites && !this.confirmed.has(path)) {
        const answer = await new DiffModal(this.app, path, current, next).choose();
        if (!answer) return false;
        if (answer === 'always') await this.host.updateSettings(settings => { settings.ganttConfirmWrites = false; });
      }
      this.confirmed.add(path);
      const view = this.editorFor(path);
      if (view) {
        // Recompute against the editor as it is now; the user may have typed while the preview was open.
        const before = view.editor.getValue();
        const after = full(before);
        const changes: EditorChange[] = lineHunks(before, after).map(hunk => ({
          from: view.editor.offsetToPos(hunk.from), to: view.editor.offsetToPos(hunk.to), text: hunk.text,
        }));
        if (changes.length) view.editor.transaction({ changes }, 'event-notes-gantt');
      } else {
        await this.app.vault.process(file, full);
      }
      this.host.written(path);
      return true;
    });
  }

  /** Change one line, then offer to put it back. */
  async writeLine(path: string, line: number, expected: string, compute: (text: string) => string, label?: string): Promise<boolean> {
    let written = expected;
    const changed = await this.write(path, content => replaceLine(content, line, expected, text => (written = compute(text))));
    if (changed && label) this.undoNotice(label, path, content => replaceLine(content, line, written, () => expected));
    return changed;
  }

  undoNotice(message: string, path: string, undo: Transform): void {
    this.actionNotice(message, () => this.write(path, undo));
  }

  /** A notice whose Undo link runs `undo`. */
  actionNotice(message: string, undo: () => Promise<unknown>): void {
    const notice = new Notice(createFragment(fragment => {
      fragment.appendText(`${message} `);
      fragment.createEl('a', { text: 'Undo', href: '#', cls: 'cp-gantt-undo' });
    }), 6000);
    notice.messageEl.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('.cp-gantt-undo')) return;
      event.preventDefault();
      notice.hide();
      undo().catch(error => new Notice(error instanceof Error ? error.message : 'Could not undo the change.'));
    });
  }

  /**
   * Ask before renaming a Task Note from a Project, when the first change to
   * that Project would be previewed; a confirmed rename counts as that change.
   */
  async previewRename(path: string, from: string, to: string): Promise<boolean> {
    if (!this.host.settings().ganttConfirmWrites || this.confirmed.has(path)) return true;
    const answer = await new RenameModal(this.app, from, to).choose();
    if (!answer) return false;
    if (answer === 'always') await this.host.updateSettings(settings => { settings.ganttConfirmWrites = false; });
    this.confirmed.add(path);
    return true;
  }
}

/** Shows which Task Note a rename moves, and that Obsidian updates the links to it. */
class RenameModal extends Modal {
  private resolve?: (answer: 'once' | 'always' | undefined) => void;
  private answer: 'once' | 'always' | undefined;

  constructor(app: App, private readonly from: string, private readonly to: string) { super(app); }

  choose(): Promise<'once' | 'always' | undefined> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  onOpen(): void {
    this.modalEl.addClass('cp-gantt-diff-modal');
    this.titleEl.setText('Rename the Task Note?');
    const root = this.contentEl;
    root.createEl('p', { text: 'This task is a link to its own note, so renaming the task renames that note. Obsidian then updates the links to it, including the one in this project.' });
    const diff = root.createDiv({ cls: 'cp-gantt-diff' });
    diff.createDiv({ cls: 'cp-diff-line is-removed', text: `- ${this.from}` });
    diff.createDiv({ cls: 'cp-diff-line is-added', text: `+ ${this.to}` });
    const never = root.createEl('label', { cls: 'cp-gantt-never' });
    const check = never.createEl('input', { type: 'checkbox' });
    never.appendText(' Don’t ask again');
    const buttons = root.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: 'Rename', cls: 'mod-cta' });
    apply.addEventListener('click', () => { this.answer = check.checked ? 'always' : 'once'; this.close(); });
    window.setTimeout(() => apply.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.answer);
    this.resolve = undefined;
  }
}

/** Shows what a first write to a note will change. */
export class DiffModal extends Modal {
  private resolve?: (answer: 'once' | 'always' | undefined) => void;
  private answer: 'once' | 'always' | undefined;

  constructor(app: App, private readonly path: string, private readonly before: string, private readonly after: string) { super(app); }

  choose(): Promise<'once' | 'always' | undefined> {
    return new Promise(resolve => { this.resolve = resolve; this.open(); });
  }

  onOpen(): void {
    this.modalEl.addClass('cp-gantt-diff-modal');
    this.titleEl.setText('Change this note?');
    const root = this.contentEl;
    root.createEl('p', { text: `This change will be written to ${this.path}. Everything else in the note stays as it is.` });
    const diff = root.createDiv({ cls: 'cp-gantt-diff' });
    const before = this.before.split('\n');
    for (const hunk of lineHunks(this.before, this.after)) {
      const context = (from: number, to: number) => {
        for (let index = Math.max(0, from); index < Math.min(before.length, to); index++) diff.createDiv({ cls: 'cp-diff-line', text: `  ${before[index]}` });
      };
      if (diff.childElementCount) diff.createDiv({ cls: 'cp-diff-gap', text: '…' });
      context(hunk.line - 2, hunk.line);
      for (const line of hunk.removed) diff.createDiv({ cls: 'cp-diff-line is-removed', text: `- ${line}` });
      for (const line of hunk.added) diff.createDiv({ cls: 'cp-diff-line is-added', text: `+ ${line}` });
      context(hunk.line + hunk.removed.length, hunk.line + hunk.removed.length + 2);
    }
    const never = root.createEl('label', { cls: 'cp-gantt-never' });
    const check = never.createEl('input', { type: 'checkbox' });
    never.appendText(' Don’t ask again');
    const buttons = root.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
    const apply = buttons.createEl('button', { text: 'Apply', cls: 'mod-cta' });
    apply.addEventListener('click', () => { this.answer = check.checked ? 'always' : 'once'; this.close(); });
    window.setTimeout(() => apply.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve?.(this.answer);
    this.resolve = undefined;
  }
}

/** A yes/no question; resolves true only for the confirming button. */
export function confirmAction(app: App, title: string, message: string, action: string): Promise<boolean> {
  return new Promise(resolve => {
    let result = false;
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    modal.contentEl.createEl('p', { text: message });
    const buttons = modal.contentEl.createDiv({ cls: 'modal-button-container' });
    buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => modal.close());
    buttons.createEl('button', { text: action, cls: 'mod-warning' }).addEventListener('click', () => { result = true; modal.close(); });
    modal.onClose = () => resolve(result);
    modal.open();
  });
}
