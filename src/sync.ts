import type { CalendarEvent, CalendarSource } from "./types";
import { intersectsRange, type CalendarRange } from "./ical";
import type { CalendarStore } from "./store";
import type { EventNoteService } from "./events";
import type { StoredState } from "./state";
import {
  emptySourceCache, markReviewed, safeSourceError,
  type AcceptedEvent, type ChangeHistoryEntry, type Interval, type SourceCache,
} from "./history";

const span = (event: CalendarEvent): Interval => ({ start: event.start, end: event.end, allDay: event.allDay });
const overrideSpan = (override: { start: string; end: string; allDay?: boolean } | undefined, event: CalendarEvent): Interval =>
  override ? { start: override.start, end: override.end, allDay: override.allDay ?? event.allDay } : span(event);
const sameSpan = (a: CalendarEvent, b: CalendarEvent): boolean => {
  if (a.allDay !== b.allDay) return false;
  return a.allDay
    ? a.start.slice(0, 10) === b.start.slice(0, 10) && a.end.slice(0, 10) === b.end.slice(0, 10)
    : Date.parse(a.start) === Date.parse(b.start) && Date.parse(a.end) === Date.parse(b.end);
};
const nextId = (): string => crypto.randomUUID();

class StaleSourcePlan extends Error {}
export type SourceCurrent = (state: StoredState) => boolean;

function assertAcceptedRevision(state: StoredState, sourceId: string, eventId: string, revision: number): void {
  if (state.sourceCaches[sourceId]?.accepted[eventId]?.revision !== revision) throw new StaleSourcePlan();
}

function assertSourceCurrent(state: StoredState, current?: SourceCurrent): void {
  if (current && !current(state)) throw new StaleSourcePlan();
}

function supersede(history: ChangeHistoryEntry[], cache: SourceCache, eventId: string): void {
  const pending = cache.pendingIncoming[eventId];
  if (!pending) return;
  const entry = history.find(row => row.id === pending.historyId);
  if (entry) entry.status = "superseded";
  delete cache.pendingIncoming[eventId];
}

export class SourceSyncService {
  constructor(public readonly store: CalendarStore, private readonly notes: EventNoteService) {}

  private sourceName(sourceId: string): string {
    return this.store.state.settings.sources.find(source => source.id === sourceId)?.name ?? sourceId;
  }

  private row(
    source: CalendarSource, previous: AcceptedEvent, incoming: CalendarEvent,
    status: ChangeHistoryEntry["status"], effective: Interval, error?: string,
  ): ChangeHistoryEntry {
    const link = this.store.state.noteLinks[incoming.id];
    const override = this.store.state.overrides[incoming.id];
    return {
      id: nextId(), eventId: incoming.id, sourceId: source.id, sourceName: source.name,
      title: incoming.title, detectedAt: new Date().toISOString(), status,
      beforeSource: span(previous.event), afterSource: span(incoming),
      beforeEffective: overrideSpan(override, previous.event), afterEffective: effective,
      notePath: link?.eventPath, beforeDailyPath: link?.dailyPath,
      afterDailyPath: link?.dailyPath, acceptedRevision: previous.revision,
      ...(error ? { error } : {}),
    };
  }

  /** Reconcile only a successfully parsed source; other sources are independent. */
  async accept(source: CalendarSource, events: CalendarEvent[], range: CalendarRange, current?: SourceCurrent): Promise<void> {
    if (current && !current(this.store.state)) return;
    const incoming = new Map(events.map(event => [event.id, event]));
    const old = this.store.state.sourceCaches[source.id] ?? emptySourceCache();
    // A missing tracked event inside this range needs review. An event merely
    // outside the range retains its accepted baseline.
    for (const [id, accepted] of Object.entries(old.accepted)) {
      if (!incoming.has(id) && intersectsRange(accepted.event, range)) {
        incoming.set(id, { ...accepted.event, status: "removed" });
      }
    }
    const baselines = [...incoming.values()].filter(event => !old.accepted[event.id]);
    if (baselines.length) {
      try {
        await this.store.commit([], state => {
          assertSourceCurrent(state, current);
          const cache = state.sourceCaches[source.id] ??= emptySourceCache();
          for (const event of baselines) {
            if (!cache.accepted[event.id]) cache.accepted[event.id] = { event, revision: 0 };
          }
        });
      } catch (error) {
        if (error instanceof StaleSourcePlan) return;
        throw error;
      }
    }
    for (const event of incoming.values()) {
      if (current && !current(this.store.state)) return;
      if (old.accepted[event.id]) await this.acceptOne(source, event, current);
    }
  }

  private async acceptOne(source: CalendarSource, incoming: CalendarEvent, current?: SourceCurrent): Promise<void> {
    if (current && !current(this.store.state)) return;
    const currentCache = this.store.state.sourceCaches[source.id] ?? emptySourceCache();
    const previous = currentCache.accepted[incoming.id];
    if (!previous) {
      try {
        await this.store.commit([], state => {
          assertSourceCurrent(state, current);
          const cache = state.sourceCaches[source.id] ??= emptySourceCache();
          if (!cache.accepted[incoming.id]) cache.accepted[incoming.id] = { event: incoming, revision: 0 };
        });
      } catch (error) {
        if (!(error instanceof StaleSourcePlan)) throw error;
      }
      return;
    }
    if (incoming.sequence !== undefined && previous.event.sequence !== undefined
      && incoming.sequence < previous.event.sequence) return;

    const pending = currentCache.pendingIncoming[incoming.id];
    const change = !sameSpan(previous.event, incoming) || previous.event.status !== incoming.status;
    if (!change) {
      if (JSON.stringify(previous.event) === JSON.stringify(incoming) && !pending) return;
      try {
        await this.store.commit([], state => {
          assertSourceCurrent(state, current);
          assertAcceptedRevision(state, source.id, incoming.id, previous.revision);
          const cache = state.sourceCaches[source.id];
          supersede(state.history, cache, incoming.id);
          cache.accepted[incoming.id] = { event: incoming, revision: previous.revision + 1 };
        });
      } catch (error) {
        if (!(error instanceof StaleSourcePlan)) throw error;
      }
      return;
    }
    const samePending = pending?.baselineRevision === previous.revision
      && JSON.stringify(pending.event) === JSON.stringify(incoming);
    if (pending && !samePending) {
      try {
        await this.store.commit([], state => {
          assertSourceCurrent(state, current);
          assertAcceptedRevision(state, source.id, incoming.id, previous.revision);
          supersede(state.history, state.sourceCaches[source.id], incoming.id);
        });
      } catch (error) {
        if (error instanceof StaleSourcePlan) return;
        throw error;
      }
    }

    const link = this.store.state.noteLinks[incoming.id];
    const override = this.store.state.overrides[incoming.id];
    const cancelled = incoming.status === "cancelled";
    const removed = incoming.status === "removed";
    let plan: Awaited<ReturnType<EventNoteService["updateLinkedInterval"]>> | undefined;
    const effective = overrideSpan(override, cancelled || removed ? previous.event : incoming);
    const status: ChangeHistoryEntry["status"] =
      removed ? "removal_attention" : cancelled ? "cancelled" : override ? "local_override" : "applied";
    try {
      if (link && !removed && !cancelled && !override) {
        plan = await this.notes.updateLinkedInterval(incoming, span(incoming));
      }
      const row = samePending
        ? structuredClone(this.store.state.history.find(entry => entry.id === pending.historyId))
          ?? this.row(source, previous, incoming, status, effective)
        : this.row(source, previous, incoming, status, effective);
      if (plan?.link) row.afterDailyPath = plan.link.dailyPath;
      await this.store.commit(plan?.writes ?? [], state => {
        assertSourceCurrent(state, current);
        assertAcceptedRevision(state, source.id, incoming.id, previous.revision);
        if (JSON.stringify(state.overrides[incoming.id]) !== JSON.stringify(override)
          || JSON.stringify(state.noteLinks[incoming.id]) !== JSON.stringify(link)) throw new StaleSourcePlan();
        const cache = state.sourceCaches[source.id];
        if (samePending && cache.pendingIncoming[incoming.id]?.historyId !== pending?.historyId) throw new StaleSourcePlan();
        if (samePending) delete cache.pendingIncoming[incoming.id];
        else supersede(state.history, cache, incoming.id);
        cache.accepted[incoming.id] = { event: incoming, revision: previous.revision + 1 };
        if (plan?.link) state.noteLinks[incoming.id] = plan.link;
        const existingRow = state.history.find(entry => entry.id === row.id);
        if (existingRow) {
          existingRow.status = status;
          existingRow.error = undefined;
          existingRow.afterDailyPath = row.afterDailyPath;
          existingRow.afterEffective = effective;
        } else state.history.push(row);
      });
    } catch (error) {
      if (error instanceof StaleSourcePlan || (current && !current(this.store.state))) return;
      if (this.store.state.sourceCaches[source.id]?.accepted[incoming.id]?.revision !== previous.revision) return;
      if (JSON.stringify(this.store.state.overrides[incoming.id]) !== JSON.stringify(override)
        || JSON.stringify(this.store.state.noteLinks[incoming.id]) !== JSON.stringify(link)) return;
      // The accepted source and linked artifacts remain at the old revision.
      // Retain one retryable row for this exact incoming revision.
      const existing = this.store.state.sourceCaches[source.id]?.pendingIncoming[incoming.id];
      const samePending = existing?.baselineRevision === previous.revision
        && JSON.stringify(existing.event) === JSON.stringify(incoming);
      const row = samePending
        ? this.store.state.history.find(entry => entry.id === existing.historyId)
        : this.row(source, previous, incoming, "needs_attention", span(previous.event), safeSourceError("write"));
      if (!row) return;
      try {
        await this.store.commit([], state => {
          assertSourceCurrent(state, current);
          assertAcceptedRevision(state, source.id, incoming.id, previous.revision);
          const cache = state.sourceCaches[source.id] ??= emptySourceCache();
          if (!samePending) supersede(state.history, cache, incoming.id);
          cache.pendingIncoming[incoming.id] = { event: incoming, baselineRevision: previous.revision, historyId: row.id };
          if (!samePending) state.history.push(row);
        });
      } catch { /* A recovery journal blocks metadata commits until recover(). */ }
    }
  }

  async retry(historyId: string): Promise<boolean> {
    const row = this.store.state.history.find(entry => entry.id === historyId);
    if (!row || row.status !== "needs_attention") return false;
    const cache = this.store.state.sourceCaches[row.sourceId];
    const pending = cache?.pendingIncoming[row.eventId];
    const previous = cache?.accepted[row.eventId];
    if (!pending || !previous || pending.historyId !== historyId || pending.baselineRevision !== previous.revision) return false;
    if (this.store.state.overrides[row.eventId]) return false;
    const source = this.store.state.settings.sources.find(item => item.id === row.sourceId);
    if (!source) return false;
    const incoming = pending.event;
    try {
      const plan = await this.notes.updateLinkedInterval(incoming, span(incoming));
      await this.store.commit(plan.writes, state => {
        const next = state.sourceCaches[source.id];
        assertAcceptedRevision(state, source.id, incoming.id, pending.baselineRevision);
        if (state.overrides[row.eventId] || next.pendingIncoming[row.eventId]?.historyId !== historyId) throw new StaleSourcePlan();
        next.accepted[incoming.id] = { event: incoming, revision: previous.revision + 1 };
        delete next.pendingIncoming[incoming.id];
        if (plan.link) state.noteLinks[incoming.id] = plan.link;
        const target = state.history.find(item => item.id === historyId)!;
        target.status = "applied";
        target.error = undefined;
        target.afterEffective = span(incoming);
        target.afterDailyPath = plan.link?.dailyPath ?? target.afterDailyPath;
      });
      return true;
    } catch { return false; }
  }

  async useLatestSourceTimes(eventId: string): Promise<boolean> {
    const sourceCache = Object.values(this.store.state.sourceCaches).find(cache => cache.accepted[eventId]);
    const accepted = sourceCache?.accepted[eventId];
    const override = this.store.state.overrides[eventId];
    if (!accepted || !override || accepted.event.status === "cancelled" || accepted.event.status === "removed") return false;
    const incoming = accepted.event;
    const plan = await this.notes.updateLinkedInterval(incoming, span(incoming));
    const link = this.store.state.noteLinks[eventId];
    const row: ChangeHistoryEntry = {
      id: nextId(), eventId, sourceId: incoming.sourceId, sourceName: this.sourceName(incoming.sourceId),
      title: incoming.title, detectedAt: new Date().toISOString(), resolutionAt: new Date().toISOString(),
      resolution: "source_times", status: "resolved", acceptedRevision: accepted.revision,
      beforeSource: span(incoming), afterSource: span(incoming), beforeEffective: overrideSpan(override, incoming),
      afterEffective: span(incoming), notePath: link?.eventPath,
      beforeDailyPath: link?.dailyPath, afterDailyPath: plan.link?.dailyPath ?? link?.dailyPath,
    };
    try {
      await this.store.commit(plan.writes, state => {
        assertAcceptedRevision(state, incoming.sourceId, eventId, accepted.revision);
        if (JSON.stringify(state.overrides[eventId]) !== JSON.stringify(override)
          || JSON.stringify(state.noteLinks[eventId]) !== JSON.stringify(link)) throw new StaleSourcePlan();
        delete state.overrides[eventId];
        if (plan.link) state.noteLinks[eventId] = plan.link;
        state.history.push(row);
      });
    } catch (error) {
      if (error instanceof StaleSourcePlan) return false;
      throw error;
    }
    return true;
  }

  async markReviewed(historyId: string): Promise<boolean> {
    if (!this.store.state.history.some(row => row.id === historyId)) return false;
    await this.store.commit([], state => { markReviewed(state.history, historyId); });
    return true;
  }

  effectiveEvent(event: CalendarEvent): CalendarEvent {
    const override = this.store.state.overrides[event.id];
    return override ? { ...event, ...override, allDay: override.allDay ?? event.allDay } : event;
  }
}
