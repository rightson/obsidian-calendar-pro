import { Modal, Setting, type App } from 'obsidian';
import type { CalendarSource } from './types';
import { isCalendarKind } from './holidays';
import { newSubscriptionUrlError, nextSubscriptionColor, type NewSubscriptionInput } from './subscription-settings';

/** Add an iCal (HTTPS or webcal) subscription from the calendar, without opening plugin settings. */
export class AddSubscriptionModal extends Modal {
  private input: NewSubscriptionInput;
  private errorEl!: HTMLElement;
  private submitting = false;

  constructor(app: App, private readonly sources: () => readonly CalendarSource[],
    private readonly submit: (input: NewSubscriptionInput) => Promise<void>, private readonly openSettings: () => void) {
    super(app);
    this.input = { name: '', url: '', color: nextSubscriptionColor(sources()), kind: 'events' };
  }

  onOpen(): void {
    this.modalEl.addClass('cn-subscription-modal');
    this.setTitle('Add calendar subscription');
    const root = this.contentEl;
    root.empty();
    root.createEl('p', { cls: 'cn-muted', text: 'Paste the iCal address (.ics) of a calendar from Google Calendar, iCloud, Outlook, or any other app. Subscribed events are read-only and refresh automatically.' });
    new Setting(root).setName('Calendar URL').setDesc('HTTPS or webcal. Stored privately in plugin data.').addText(text => {
      text.setPlaceholder('https://example.com/calendar.ics').onChange(value => { this.input.url = value; this.showError(); });
      text.inputEl.addClass('cn-subscription-url');
      text.inputEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void this.save(); } });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(root).setName('Name').setDesc('Leave blank to use the calendar\'s host name.').addText(text => {
      text.setPlaceholder('Work calendar').onChange(value => { this.input.name = value; });
      text.inputEl.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void this.save(); } });
    });
    new Setting(root).setName('Color').addColorPicker(picker => picker.setValue(this.input.color).onChange(value => { this.input.color = value; }));
    new Setting(root).setName('Calendar type').setDesc('A holiday calendar also shades the days its events cover.').addDropdown(select => select
      .addOption('events', 'Events').addOption('holidays', 'Holidays').setValue(this.input.kind)
      .onChange(value => { if (isCalendarKind(value)) this.input.kind = value; }));
    this.errorEl = root.createDiv({ cls: 'cn-validation', attr: { role: 'alert' } });
    this.errorEl.hide();
    const actions = root.createDiv({ cls: 'cn-modal-actions cn-subscription-actions' });
    const more = actions.createEl('button', { cls: 'cn-link-button', text: 'More subscription settings…', attr: { type: 'button' } });
    more.addEventListener('click', () => { this.close(); this.openSettings(); });
    actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } }).addEventListener('click', () => this.close());
    const add = actions.createEl('button', { cls: 'mod-cta', text: 'Add calendar', attr: { type: 'button' } });
    add.addEventListener('click', () => void this.save());
  }

  onClose(): void { this.contentEl.empty(); }

  private showError(message?: string): void {
    if (!this.errorEl) return;
    this.errorEl.setText(message ?? '');
    this.errorEl.toggle(!!message);
  }

  private async save(): Promise<void> {
    if (this.submitting) return;
    const error = newSubscriptionUrlError(this.input.url, this.sources());
    if (error) { this.showError(error); return; }
    this.submitting = true;
    try {
      await this.submit({ ...this.input });
      this.close();
    } catch (failure) {
      this.showError(failure instanceof Error ? failure.message : 'Could not add the subscription.');
    } finally { this.submitting = false; }
  }
}
