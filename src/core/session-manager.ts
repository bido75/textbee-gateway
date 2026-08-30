import { randomUUID } from "crypto";
import {
  AdapterEvent,
  CallSession,
  ChannelKind,
  CommunicationAdapter,
  Endpoint,
  GatewayConfig,
  MessageRecord,
  ProviderId,
  RoutingRule,
} from "./types.js";
import { PersistenceStore } from "../persistence/types.js";
import { MemoryStore } from "../persistence/memory-store.js";

const EVENTS_CHANNEL = "events";

/**
 * The Communication Core.
 *
 * - Holds every configured adapter (keyed by provider id).
 * - Applies routing rules to pick a provider for a given channel + destination.
 * - Write-through persists call/message state to a PersistenceStore (default:
 *   in-memory, swap in Postgres/Redis for durability + multi-process sharing).
 * - Fans out adapter events to any listener (MCP server, logging, transcripts, etc.)
 *   AND publishes them on the store's event bus so other processes see them too.
 */
export class SessionManager {
  private adapters = new Map<ProviderId, CommunicationAdapter>();
  private routing: RoutingRule[] = [];
  private calls = new Map<string, CallSession>();
  private messages = new Map<string, MessageRecord>();
  private listeners: Array<(e: AdapterEvent & { provider: ProviderId }) => void> = [];
  private store: PersistenceStore;

  constructor(store: PersistenceStore = new MemoryStore()) {
    this.store = store;
  }

  registerAdapter(adapter: CommunicationAdapter) {
    this.adapters.set(adapter.id, adapter);
    adapter.onEvent((event) => this.handleAdapterEvent(adapter.id, event));
    adapter.attachIdempotencyCheck?.((key) => this.store.checkAndMarkSeen("webhook", key));
  }

  /**
   * Lets something other than a registered CommunicationAdapter (e.g. a
   * CellularVoiceProvider behind CellularEndpointRegistry) feed events
   * through the exact same pipeline — local state, persistence, and the
   * cross-process event bus all work identically either way.
   */
  ingestExternalEvent(providerId: ProviderId, event: AdapterEvent) {
    this.handleAdapterEvent(providerId, event);
  }

  /**
   * Lets an external caller (e.g. CellularEndpointRegistry.makeCall, which
   * dials through a CellularVoiceProvider rather than a CommunicationAdapter)
   * register a freshly-created call the same way manager.dial() does —
   * tracked locally and persisted immediately, before any event arrives.
   */
  async trackExternalCall(call: CallSession): Promise<void> {
    this.calls.set(call.id, call);
    await this.store.saveCall(call);
  }

  setRouting(routing: RoutingRule[]) {
    this.routing = routing;
  }

  static async fromConfig(
    config: GatewayConfig,
    adapterFactory: (type: string, id: ProviderId) => CommunicationAdapter,
    store?: PersistenceStore
  ): Promise<SessionManager> {
    const manager = new SessionManager(store);
    await manager.store.init();

    // Cross-process: any event another process publishes on the shared
    // store's event bus also flows through this manager's local listeners
    // and cache, so e.g. an MCP server process sees an inbound call that a
    // separate webhook process learned about first.
    await manager.store.subscribeEvents(EVENTS_CHANNEL, (payload) => {
      const evt = payload as AdapterEvent & { provider: ProviderId };
      manager.applyEventToLocalState(evt);
      for (const listener of manager.listeners) listener(evt);
    });

    for (const p of config.providers) {
      const adapter = adapterFactory(p.type, p.id);
      await adapter.init(p.config);
      manager.registerAdapter(adapter);
    }
    manager.setRouting(config.routing);
    return manager;
  }

  /** Pick the best adapter for a channel + destination, based on routing rules. */
  resolveProvider(channel: ChannelKind, to: Endpoint): CommunicationAdapter {
    const candidates = this.routing.filter((r) => r.channel === channel);
    // Prefer the most specific prefix match; fall back to "*" / first rule.
    const matched =
      candidates.find((r) => r.match && r.match !== "*" && to.address.startsWith(r.match)) ??
      candidates.find((r) => r.match === "*") ??
      candidates[0];

    if (!matched) {
      throw new Error(`No routing rule configured for channel "${channel}"`);
    }
    const adapter = this.adapters.get(matched.provider);
    if (!adapter) {
      throw new Error(`Routing points to unknown provider "${matched.provider}"`);
    }
    return adapter;
  }

  getAdapter(id: ProviderId): CommunicationAdapter | undefined {
    return this.adapters.get(id);
  }

  // ---- Voice -------------------------------------------------------------

  async dial(to: Endpoint, opts?: { providerId?: ProviderId; from?: Endpoint; attachMediaStreamUrl?: string }) {
    const adapter = opts?.providerId
      ? this.mustGet(opts.providerId)
      : this.resolveProvider("voice", to);
    if (!adapter.dial) throw new Error(`Provider "${adapter.id}" does not support dial()`);
    const session = await adapter.dial(to, {
      from: opts?.from,
      attachMediaStreamUrl: opts?.attachMediaStreamUrl,
    });
    this.calls.set(session.id, session);
    await this.store.saveCall(session);
    return session;
  }

  async answer(callId: string) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.answer) throw new Error(`Provider does not support answer()`);
    await adapter.answer(callId);
  }

  async hangup(callId: string) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.hangup) throw new Error(`Provider does not support hangup()`);
    await adapter.hangup(callId);
  }

  async hold(callId: string, on: boolean) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.hold) throw new Error(`Provider does not support hold()`);
    await adapter.hold(callId, on);
  }

  async mute(callId: string, on: boolean) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.mute) throw new Error(`Provider does not support mute()`);
    await adapter.mute(callId, on);
  }

  async transfer(callId: string, to: Endpoint) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.transfer) throw new Error(`Provider does not support transfer()`);
    await adapter.transfer(callId, to);
  }

  async sendDtmf(callId: string, digits: string) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.sendDtmf) throw new Error(`Provider does not support sendDtmf()`);
    await adapter.sendDtmf(callId, digits);
  }

  async record(callId: string, on: boolean) {
    const { adapter } = this.mustGetCall(callId);
    if (!adapter.record) throw new Error(`Provider does not support record()`);
    await adapter.record(callId, on);
  }

  getCall(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  /** Like getCall, but also checks the durable store (useful across process restarts / multi-process). */
  async getCallDurable(callId: string): Promise<CallSession | null> {
    return this.calls.get(callId) ?? (await this.store.getCall(callId));
  }

  listCalls(): CallSession[] {
    return [...this.calls.values()];
  }

  /** Like listCalls, but reads the durable store — includes calls from before this process started. */
  async listCallsDurable(limit?: number): Promise<CallSession[]> {
    return this.store.listCalls({ limit });
  }

  // ---- Messaging -----------------------------------------------------------

  async sendMessage(
    to: Endpoint,
    body: string,
    opts?: { providerId?: ProviderId; from?: Endpoint; mediaUrls?: string[] }
  ) {
    const kind: ChannelKind = opts?.mediaUrls?.length ? "mms" : "sms";
    const adapter = opts?.providerId ? this.mustGet(opts.providerId) : this.resolveProvider(kind, to);
    if (!adapter.sendMessage) throw new Error(`Provider "${adapter.id}" does not support sendMessage()`);
    const record = await adapter.sendMessage(to, body, {
      from: opts?.from,
      mediaUrls: opts?.mediaUrls,
    });
    this.messages.set(record.id, record);
    await this.store.saveMessage(record);
    return record;
  }

  listMessages(): MessageRecord[] {
    return [...this.messages.values()];
  }

  /** Like listMessages, but reads the durable store. */
  async listMessagesDurable(limit?: number): Promise<MessageRecord[]> {
    return this.store.listMessages({ limit });
  }

  async shutdown(): Promise<void> {
    for (const adapter of this.adapters.values()) await adapter.shutdown();
    await this.store.shutdown();
  }

  // ---- Events ----------------------------------------------------------

  onEvent(listener: (e: AdapterEvent & { provider: ProviderId }) => void) {
    this.listeners.push(listener);
  }

  private handleAdapterEvent(provider: ProviderId, event: AdapterEvent) {
    const enriched = { ...event, provider };

    // Apply to local state + persist immediately so synchronous callers
    // (e.g. code that dials and then immediately reads call state) see it
    // right away, without waiting on a pub/sub round-trip.
    this.applyEventToLocalState(event);
    void this.persistEvent(event);

    // Notify listeners exactly once, via the store's event bus — this is
    // also what a second, separate process sharing the same store would
    // receive. Using the bus for local delivery too (rather than calling
    // listeners directly here as well) avoids double-firing.
    void this.store.publishEvent(EVENTS_CHANNEL, enriched);
  }

  private applyEventToLocalState(event: AdapterEvent) {
    if (event.type === "call.incoming") {
      this.calls.set(event.call.id, event.call);
    } else if (event.type === "call.state_changed") {
      const call = this.calls.get(event.callId);
      if (call) call.state = event.state;
    } else if (event.type === "call.ended") {
      const call = this.calls.get(event.callId);
      if (call) {
        call.state = "ended";
        call.endedAt = new Date().toISOString();
      }
    } else if (event.type === "message.incoming") {
      this.messages.set(event.message.id, event.message);
    } else if (event.type === "message.status") {
      const msg = this.messages.get(event.messageId);
      if (msg) msg.status = event.status;
    }
  }

  private async persistEvent(event: AdapterEvent) {
    if (event.type === "call.incoming") {
      await this.store.saveCall(event.call);
    } else if (event.type === "call.state_changed" || event.type === "call.ended") {
      const call = this.calls.get(event.callId);
      if (call) await this.store.saveCall(call);
    } else if (event.type === "message.incoming") {
      await this.store.saveMessage(event.message);
    } else if (event.type === "message.status") {
      const msg = this.messages.get(event.messageId);
      if (msg) await this.store.saveMessage(msg);
    }
  }

  private mustGet(id: ProviderId): CommunicationAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown provider "${id}"`);
    return adapter;
  }

  private mustGetCall(callId: string): { call: CallSession; adapter: CommunicationAdapter } {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown call id "${callId}"`);
    const adapter = this.mustGet(call.provider);
    return { call, adapter };
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
