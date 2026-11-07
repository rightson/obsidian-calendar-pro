import { safeStoredSourceError, type SourceCache } from './history';
import type { CalendarKind, CalendarSource, PluginSettings } from './types';

/** Queue complete settings saves, then resolve each edit against the latest state. */
export class SettingsUpdateQueue {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly current: () => PluginSettings,
    private readonly persist: (settings: PluginSettings) => Promise<void>,
  ) {}

  update(change: (settings: PluginSettings) => void, validate?: (settings: PluginSettings) => void): Promise<void> {
    const run = this.pending.then(async () => {
      const next = structuredClone(this.current());
      change(next);
      validate?.(next);
      await this.persist(next);
    });
    this.pending = run.then(() => undefined, () => undefined);
    return run;
  }
}

export function patchSubscription(settings: PluginSettings, id: string, patch: Partial<CalendarSource>): void {
  const source = settings.sources.find(item => item.id === id);
  if (!source) return;
  Object.assign(source, patch);
  if (!source.url.trim()) source.enabled = false;
}

/** Colors offered to new subscriptions, in order; the first one no calendar uses yet is picked. */
export const SUBSCRIPTION_COLORS = ['#5885d8', '#d8584f', '#3fa36b', '#d89a2b', '#8a63d2', '#2a9db0', '#c4569a'] as const;

export function nextSubscriptionColor(sources: readonly CalendarSource[]): string {
  const used = new Set(sources.map(source => source.color.toLowerCase()));
  return SUBSCRIPTION_COLORS.find(color => !used.has(color)) ?? SUBSCRIPTION_COLORS[sources.length % SUBSCRIPTION_COLORS.length];
}

/** Why `url` cannot be added as a new subscription, or undefined when it can. */
export function newSubscriptionUrlError(url: string, sources: readonly CalendarSource[]): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return 'Enter the calendar\'s subscription URL.';
  let parsed: URL;
  try { parsed = new URL(trimmed); } catch { return 'Enter a valid HTTPS or webcal subscription URL.'; }
  if (!['https:', 'webcal:'].includes(parsed.protocol)) return 'Use an HTTPS or webcal subscription URL.';
  const existing = sources.find(source => source.url.trim() === trimmed);
  if (existing) return `This calendar is already subscribed as “${existing.name}”.`;
  return undefined;
}

export interface NewSubscriptionInput {
  name: string;
  url: string;
  color: string;
  kind: CalendarKind;
}

/** An enabled subscription; a blank name falls back to the feed's host name. */
export function newSubscription(id: string, input: NewSubscriptionInput): CalendarSource {
  const url = input.url.trim();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* the URL is validated before saving */ }
  const name = input.name.trim() || host || 'New calendar';
  return { id, name, url, color: input.color, enabled: true, ...input.kind === 'holidays' ? { kind: input.kind } : {} };
}

export function safeSubscriptionError(error: string | undefined): string | undefined {
  return safeStoredSourceError(error);
}

export function subscriptionStatus(source: CalendarSource, cache: SourceCache | undefined, visibleCount?: number): string {
  if (!source.url.trim()) return 'Inactive: add a subscription URL.';
  if (!source.enabled) return 'Disabled. Enable this subscription to refresh it.';
  const countText = visibleCount === undefined ? '' : ` ${visibleCount} ${visibleCount === 1 ? 'event' : 'events'} in the current view.`;
  const error = safeSubscriptionError(cache?.error);
  if (error) return `Last refresh failed: ${error}${countText}`;
  if (cache?.lastSuccess) return `Last refreshed: ${cache.lastSuccess}.${countText}`;
  return `Not refreshed yet.${countText}`;
}

export function subscriptionFailureMessage(settings: PluginSettings, caches: Record<string, SourceCache>): string | undefined {
  const failed = settings.sources.filter(source => source.enabled && !!source.url.trim() && !!caches[source.id]?.error);
  if (!failed.length) return undefined;
  const reasons = [...new Set(failed.map(source => safeSubscriptionError(caches[source.id].error)))].filter(Boolean);
  return `${failed.length} ${failed.length === 1 ? 'subscription' : 'subscriptions'} failed to refresh: ${reasons.join(' ')} Open subscription settings for details.`;
}
