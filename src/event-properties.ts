import { MarkdownView, TFile, type App, type Plugin } from 'obsidian';
import type { EventPropertiesDefault } from './types';
import { PropertiesOpenState, shouldRestoreProperties } from './event-properties-state';

/** Set an Event Note's initial native Properties state without taking over its toggle. */
export class EventPropertiesController {
  private observed = new Map<MarkdownView, { observer: MutationObserver; onClick: (event: MouseEvent) => void }>();
  private applied = new PropertiesOpenState<MarkdownView, HTMLElement>();
  private timers = new Map<number, number>();
  private opening = new WeakMap<MarkdownView, { path: string; settleUntil: number; retryUntil: number }>();
  private manualToggle = new WeakMap<MarkdownView, string>();
  private nativeClickInProgress = false;
  private disposed = false;

  constructor(
    private app: App,
    private preference: () => EventPropertiesDefault,
    private isEventNote: (file: TFile) => boolean,
  ) {}

  start(plugin: Plugin): void {
    const refresh = () => this.refresh();
    plugin.registerEvent(this.app.workspace.on('file-open', file => {
      if (!file) return;
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      // A file can be reopened in the same view before a delayed scan ever
      // sees the intervening note. Every file open starts a new default.
      if (activeView) {
        this.restoreView(activeView);
        this.applied.opened(activeView);
        this.manualToggle.delete(activeView);
        // The file-open event precedes Obsidian's final Properties render.
        this.opening.set(activeView, { path: file.path, settleUntil: Date.now() + 80, retryUntil: Date.now() + 500 });
      }
      this.refresh();
    }));
    plugin.registerEvent(this.app.workspace.on('active-leaf-change', refresh));
    plugin.registerEvent(this.app.workspace.on('layout-change', refresh));
    plugin.registerEvent(this.app.metadataCache.on('changed', refresh));
    this.app.workspace.onLayoutReady(() => { if (!this.disposed) this.refresh(); });
  }

  /** Apply a newly selected preference to currently open Event Notes. */
  settingsChanged(): void {
    this.restoreApplied();
    this.applied.clear();
    this.manualToggle = new WeakMap();
    this.opening = new WeakMap();
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    for (const [view, entry] of this.observed) {
      entry.observer.disconnect();
      view.containerEl.removeEventListener('click', entry.onClick, true);
    }
    this.observed.clear();
    this.restoreApplied();
    this.applied.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    this.scan();
    // Obsidian can populate Properties after the file-open event. Stop retrying
    // promptly; the view observer handles later mode changes and replacements.
    for (const delay of [40, 120, 300, 700]) {
      if (this.timers.has(delay)) continue;
      const timer = window.setTimeout(() => {
        this.timers.delete(delay);
        if (!this.disposed) this.scan();
      }, delay);
      this.timers.set(delay, timer);
    }
  }

  private scan(): void {
    const relevant = new Set<MarkdownView>();
    const preference = this.preference();
    if (preference !== 'obsidian') {
      this.app.workspace.iterateAllLeaves(leaf => {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || !view.file || !this.isEventNote(view.file)) return;
        relevant.add(view);
        if (!this.observed.has(view)) {
          const observer = new MutationObserver(() => {
            if (this.disposed) return;
            const opening = this.opening.get(view);
            if (opening && opening.path === view.file?.path) opening.settleUntil = Date.now() + 35;
            this.refresh();
          });
          const onClick = (event: MouseEvent) => {
            if (this.nativeClickInProgress) return;
            const target = event.target as Element | null;
            if (target?.closest?.('.metadata-properties-heading')) {
              this.manualToggle.set(view, `${view.file?.path}\0${view.getMode()}`);
            }
          };
          observer.observe(view.containerEl, { childList: true, subtree: true });
          view.containerEl.addEventListener('click', onClick, true);
          this.observed.set(view, { observer, onClick });
        }
        this.apply(view, preference);
      });
    }
    for (const [view, entry] of this.observed) {
      if (relevant.has(view)) continue;
      entry.observer.disconnect();
      view.containerEl.removeEventListener('click', entry.onClick, true);
      this.observed.delete(view);
      this.applied.drop(view);
    }
  }

  private apply(view: MarkdownView, preference: EventPropertiesDefault): void {
    if (preference === 'obsidian' || !view.file || !this.isEventNote(view.file)) return;
    const opening = this.opening.get(view);
    if (opening && opening.path !== view.file.path) {
      if (Date.now() < opening.retryUntil) return;
      this.opening.delete(view);
    }
    const currentOpening = this.opening.get(view);
    if (Date.now() < (currentOpening?.settleUntil ?? 0)) return;
    const panel = this.visiblePanel(view);
    if (!panel) return; // Properties may be hidden globally or not rendered yet.
    const mode = view.getMode();
    const manuallyToggled = this.manualToggle.get(view) === `${view.file.path}\0${mode}`;
    if (manuallyToggled) return;
    const identity: unknown = this.app.metadataCache.getFileCache(view.file)?.frontmatter?.event_id;
    const value = panel.querySelector<HTMLElement>('[data-property-key="event_id"] .metadata-property-value');
    const renderedIdentity = value?.textContent?.trim() || value?.querySelector<HTMLInputElement>('input')?.value?.trim();
    if (renderedIdentity !== identity) return;
    const heading = panel.querySelector<HTMLElement>('.metadata-properties-heading');
    if (!heading) return;
    const originalCollapsed = panel.classList.contains('is-collapsed');
    const targetCollapsed = preference === 'collapsed';
    // A same-mode redraw must not undo a manual Properties toggle.
    const retryNewPanel = currentOpening?.path === view.file.path && Date.now() < currentOpening.retryUntil;
    if (this.applied.shouldToggle(view, view.file.path, mode, panel, originalCollapsed, targetCollapsed,
      retryNewPanel, manuallyToggled)) this.clickHeading(heading);
  }

  private visiblePanel(view: MarkdownView): HTMLElement | undefined {
    const source = view.getMode() === 'source';
    return Array.from(view.containerEl.querySelectorAll<HTMLElement>('.metadata-container'))
      .find(element => element.offsetParent !== null && Boolean(element.closest(source ? '.markdown-source-view' : '.markdown-preview-view')));
  }

  private restoreApplied(): void {
    for (const [view] of this.applied.entries()) this.restoreView(view);
  }

  private restoreView(view: MarkdownView): void {
    const applied = this.applied.get(view);
    if (!applied || view.file?.path !== applied.path || !applied.element.isConnected) return;
    const manuallyToggled = this.manualToggle.get(view) === `${applied.path}\0${applied.mode}`;
    if (!shouldRestoreProperties(applied, applied.element.classList.contains('is-collapsed'), manuallyToggled)) return;
    const heading = applied.element.querySelector<HTMLElement>('.metadata-properties-heading');
    if (heading) this.clickHeading(heading);
  }

  private clickHeading(heading: HTMLElement): void {
    this.nativeClickInProgress = true;
    try { heading.click(); }
    finally { this.nativeClickInProgress = false; }
  }
}
