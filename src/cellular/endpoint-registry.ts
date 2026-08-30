import { SessionManager } from "../core/session-manager.js";
import { CallSession, Endpoint, MessageRecord } from "../core/types.js";
import { CellularEndpointConfig, CellularVoiceProvider } from "./types.js";

export interface EndpointStatus {
  endpointId: string;
  phoneNumber?: string;
  lineNumberStatus: "demo" | "configured" | "verified" | "unverified";
  overall: "online" | "degraded" | "offline";
  messaging: { available: boolean; provider?: string; detail: string };
  voice: { available: boolean; provider?: string; detail: string };
}
import { PersistenceStore } from "../persistence/types.js";
import { normalizePhoneNumber } from "../core/phone-normalization.js";

export interface ResolvedCellularEndpoint {
  config: CellularEndpointConfig;
  voiceProvider?: CellularVoiceProvider;
}

export interface CellularVoiceProviderConfig {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

/**
 * CellularEndpointRegistry is where "one Android + one SIM = one logical
 * communication identity" actually gets assembled: it resolves each
 * CellularEndpoint's `messaging.provider` / `voice.provider` references
 * against the real provider instances, and forwards voice-provider events
 * into the same SessionManager that TextBee/Asterisk-ARI/etc. already feed
 * — so a cellular call shows up in `list_calls`/`get_events` exactly like
 * any other call, and (critically) ConversationService can merge it with
 * SMS history from the same endpoint's messaging provider.
 *
 * Deliberately NOT a CommunicationAdapter itself — voice providers here are
 * CellularVoiceProvider instances, a narrower interface (see cellular/types.ts).
 */
export class CellularEndpointRegistry {
  private endpoints = new Map<string, ResolvedCellularEndpoint>();
  private voiceProviders = new Map<string, CellularVoiceProvider>();
  private manager!: SessionManager;

  static async fromConfig(
    endpointConfigs: CellularEndpointConfig[],
    voiceProviderConfigs: CellularVoiceProviderConfig[],
    voiceProviderFactory: (type: string, id: string) => CellularVoiceProvider,
    manager: SessionManager,
    store?: PersistenceStore
  ): Promise<CellularEndpointRegistry> {
    const registry = new CellularEndpointRegistry();
    registry.manager = manager;

    for (const vp of voiceProviderConfigs) {
      const provider = voiceProviderFactory(vp.type, vp.id);
      await provider.init(vp.config);
      // Forward this provider's events into the shared SessionManager,
      // tagged with the provider's own id — consistent with how every other
      // provider's events are tagged. ConversationService is what maps a
      // CellularEndpoint to "which provider ids count as its channels",
      // rather than inventing a synthetic identity here.
      provider.onEvent((event) => manager.ingestExternalEvent(provider.id, event));
      registry.voiceProviders.set(vp.id, provider);
    }

    for (const ep of endpointConfigs) {
      if (ep.phoneNumber) ep.phoneNumber = normalizePhoneNumber(ep.phoneNumber);
      const voiceProvider = ep.voice ? registry.voiceProviders.get(ep.voice.provider) : undefined;
      if (ep.voice && !voiceProvider) {
        throw new Error(
          `CellularEndpoint "${ep.id}" references voice provider "${ep.voice.provider}", which is not configured`
        );
      }
      registry.endpoints.set(ep.id, { config: ep, voiceProvider });

      // Persist the endpoint's declared config so it's durable/queryable
      // across restarts — a scoped-down first step toward the fuller
      // Agent/Contact/CommunicationIdentity schema, not that schema itself.
      // Best-effort: a persistence failure here shouldn't block startup.
      if (store) {
        await store.saveEndpointConfig(ep.id, ep as unknown as Record<string, unknown>).catch((err) => {
          process.stderr.write(`[cellular] failed to persist endpoint config "${ep.id}": ${err}\n`);
        });
      }
    }

    return registry;
  }

  get(endpointId: string): ResolvedCellularEndpoint | undefined {
    return this.endpoints.get(endpointId);
  }

  list(): CellularEndpointConfig[] {
    return [...this.endpoints.values()].map((e) => e.config);
  }

  /** Looks up a voice provider by its own id (not by endpoint) — used to dispatch answer/hangup for a call already in flight. */
  getVoiceProviderById(providerId: string): CellularVoiceProvider | undefined {
    return this.voiceProviders.get(providerId);
  }

  async makeCall(endpointId: string, destination: string): Promise<CallSession> {
    const resolved = this.mustGet(endpointId);
    if (!resolved.voiceProvider) {
      throw new Error(`CellularEndpoint "${endpointId}" has no voice provider configured`);
    }
    this.requireLineNumber(resolved.config);
    return resolved.voiceProvider.dial(resolved.config, normalizePhoneNumber(destination));
  }

  /**
   * Endpoint-aware messaging — the counterpart to makeCall(). Resolves
   * `endpointId` to its configured `messaging.provider` and sends through
   * the normal SessionManager path (so persistence/events work exactly the
   * same as any other message), rather than requiring the caller to know
   * which underlying provider (e.g. "textbee-home-phone") backs this SIM.
   */
  async sendMessage(
    endpointId: string,
    to: Endpoint,
    body: string,
    opts?: { mediaUrls?: string[] }
  ): Promise<MessageRecord> {
    const resolved = this.mustGet(endpointId);
    if (!resolved.config.messaging) {
      throw new Error(`CellularEndpoint "${endpointId}" has no messaging provider configured`);
    }
    this.requireLineNumber(resolved.config);
    return this.manager.sendMessage({ ...to, address: normalizePhoneNumber(to.address) }, body, {
      providerId: resolved.config.messaging.provider,
      from: { address: resolved.config.phoneNumber },
      mediaUrls: opts?.mediaUrls,
    });
  }

  /** Development-only simulated inbound call. Real providers intentionally do not implement this. */
  async simulateIncomingCall(endpointId: string, from: string): Promise<CallSession> {
    const resolved = this.mustGet(endpointId);
    this.requireLineNumber(resolved.config);
    const provider = resolved.voiceProvider as CellularVoiceProvider & {
      simulateIncomingCall?: (endpoint: CellularEndpointConfig, from: string) => CallSession | Promise<CallSession>;
    };
    if (!provider?.simulateIncomingCall) throw new Error(`Endpoint "${endpointId}" is not backed by a simulated voice provider`);
    return provider.simulateIncomingCall(resolved.config, normalizePhoneNumber(from));
  }

  /** Reverse lookup: given a provider id (messaging OR voice), find the endpoint it belongs to, if any. */
  findEndpointByProvider(providerId: string): CellularEndpointConfig | undefined {
    for (const resolved of this.endpoints.values()) {
      if (resolved.config.messaging?.provider === providerId || resolved.config.voice?.provider === providerId) {
        return resolved.config;
      }
    }
    return undefined;
  }

  /**
   * Combines the voice provider's own status with an honest (not just
   * "is it configured?") check of the messaging side — is the messaging
   * provider actually instantiated and registered, not merely declared in
   * YAML — into one overall picture: "SMS works, voice doesn't" is a real,
   * distinct state from "the whole line is offline," and callers (an AI
   * agent or an admin dashboard) should be able to tell the difference.
   *
   * Still honestly partial: neither side is a live device heartbeat check
   * (no TextBee "is the phone's app actually running right now" query, no
   * chan_mobile Bluetooth-connection check beyond ARI's best-effort
   * /endpoints listing) — see each provider's own status method for its
   * specific caveats.
   */
  async getStatus(endpointId: string): Promise<EndpointStatus> {
    const resolved = this.mustGet(endpointId);

    const voice = resolved.voiceProvider
      ? await resolved.voiceProvider.getStatus(resolved.config)
      : { available: false, detail: "no voice provider configured for this endpoint" };

    let messaging: { available: boolean; detail: string };
    if (!resolved.config.messaging) {
      messaging = { available: false, detail: "no messaging provider configured for this endpoint" };
    } else {
      const adapter = this.manager.getAdapter(resolved.config.messaging.provider);
      messaging = adapter
        ? {
            available: true,
            detail:
              `messaging provider "${resolved.config.messaging.provider}" is instantiated ` +
              `(this confirms the provider is running, not a live device/heartbeat check)`,
          }
        : {
            available: false,
            detail: `messaging provider "${resolved.config.messaging.provider}" is configured but not found in the registry`,
          };
    }

    const overall: EndpointStatus["overall"] =
      voice.available && messaging.available ? "online" : voice.available || messaging.available ? "degraded" : "offline";

    return {
      endpointId,
      phoneNumber: resolved.config.phoneNumber,
      lineNumberStatus: resolved.config.lineNumberStatus ?? "unverified",
      overall,
      voice: { available: voice.available, detail: voice.detail ?? "", provider: resolved.config.voice?.provider },
      messaging: { ...messaging, provider: resolved.config.messaging?.provider },
    };
  }

  private mustGet(endpointId: string): ResolvedCellularEndpoint {
    const resolved = this.endpoints.get(endpointId);
    if (!resolved) throw new Error(`Unknown cellular endpoint "${endpointId}"`);
    return resolved;
  }

  private requireLineNumber(endpoint: CellularEndpointConfig): asserts endpoint is CellularEndpointConfig & { phoneNumber: string } {
    if (!endpoint.phoneNumber || endpoint.lineNumberStatus === "unverified") {
      throw new Error(`LINE NUMBER NOT VERIFIED for CellularEndpoint "${endpoint.id}"`);
    }
  }

  async shutdown(): Promise<void> {
    for (const provider of this.voiceProviders.values()) {
      await provider.shutdown();
    }
  }
}
