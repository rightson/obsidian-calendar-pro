import { Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import type CalendarNotePlugin from './main';
import type { CalendarEvent, Interval } from './types';
import { EventModal, LinkNoteModal, NoteChoiceModal } from './modals';
import { noteSplitLeaf, oppositeTabLeaf, sideTabLeaf } from './calendar-open';

/**
 * What a calendar surface (the main calendar or the events sidebar) does with
 * an event: show and edit its details, open its Event Note, or bind it to
 * another note. Notes open relative to the leaf the surface lives in.
 */
export class EventActions {
  private noteLeaf?: WorkspaceLeaf;

  constructor(private readonly plugin: CalendarNotePlugin, private readonly leaf: () => WorkspaceLeaf) {}

  private get app() { return this.plugin.app; }
  private get settings() { return this.plugin.store.state.settings; }

  /** New tabs go on the far side of the calendar when a pane is there, so the calendar stays in view. */
  readonly tabTarget = (): WorkspaceLeaf => oppositeTabLeaf(this.app.workspace, this.leaf()) ?? this.app.workspace.getLeaf('tab');
  /** One leaf beside the calendar, reused while it stays open. */
  readonly besideTarget = (): WorkspaceLeaf => (this.noteLeaf = noteSplitLeaf(this.app.workspace, this.leaf(), this.noteLeaf));

  /** The path of the event's Event Note, when it has one. */
  notePath(event: CalendarEvent): string | undefined {
    return this.plugin.store.state.noteLinks[event.id]?.eventPath;
  }

  calendarName(event: CalendarEvent): string {
    return this.settings.sources.find(source => source.id === event.sourceId)?.name ?? 'Local';
  }

  /** Follow the Clicking an event setting. */
  click(event: CalendarEvent): void {
    switch (this.settings.eventClickAction) {
      case 'split': this.openEventNote(event, this.besideTarget); break;
      case 'tab': this.openEventNote(event, this.tabTarget); break;
      default: this.showDetails(event);
    }
  }

  openEventNote(event: CalendarEvent, target: () => WorkspaceLeaf): void {
    void this.plugin.runAction(() => this.plugin.notes.openEvent(event, paths => new NoteChoiceModal(this.app, paths).choose(), target));
  }

  showDetails(event: CalendarEvent): void {
    new EventModal(this.app, this.settings, async value => {
      if (value.title !== event.title) { new Notice('Edit the Event Note title in Obsidian.'); return; }
      await this.plugin.reschedule(event, value.interval);
    }, event, undefined, {
      path: this.notePath(event),
      change: () => void this.changeEventNote(event),
      calendar: this.settings.sources.find(source => source.id === event.sourceId)?.name,
      candidates: () => this.plugin.notes.noteCandidates(event),
      bind: path => this.plugin.linkEventNote(event, path, paths => new NoteChoiceModal(this.app, paths).choose(), false),
      open: place => this.openEventNote(event, place === 'tab' ? this.tabTarget : () => sideTabLeaf(this.app.workspace, this.leaf(), place)),
    }).open();
  }

  async changeEventNote(event: CalendarEvent): Promise<void> {
    const current = this.notePath(event);
    const path = await new LinkNoteModal(this.app, current).choose();
    if (path) await this.plugin.linkEventNote(event, path, paths => new NoteChoiceModal(this.app, paths).choose());
  }

  newEvent(interval: Interval): void {
    new EventModal(this.app, this.settings, async value => { await this.plugin.createLocal(value.title, value.interval); }, undefined, interval).open();
  }

  /** Menu entries for one event: details, and the places its Event Note can open. */
  addEventItems(menu: Menu, event: CalendarEvent): void {
    menu.addItem(item => item.setTitle('Details and edit…').setIcon('pencil').onClick(() => this.showDetails(event)));
    menu.addItem(item => item.setTitle('Open Event Note in new tab').setIcon('file-text').onClick(() => this.openEventNote(event, this.tabTarget)));
    menu.addItem(item => item.setTitle('Open Event Note beside the calendar').setIcon('panel-right-open').onClick(() => this.openEventNote(event, this.besideTarget)));
    menu.addItem(item => item.setTitle('Change Event Note…').setIcon('link').onClick(() => void this.changeEventNote(event)));
  }
}
