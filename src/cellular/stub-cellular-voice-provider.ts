import { newId } from "../core/session-manager.js";
import { CallSession } from "../core/types.js";
import {
  CellularEndpointConfig,
  VoiceProviderStatus,
  CellularVoiceProvider,
} from "./types.js";
import { AdapterEventHandler } from "../core/types.js";
import { MediaBridgeHandle, VoiceMediaProvider } from "../media/voice-media-provider.js";

/**
 * StubCellularVoiceProvider — same role as adapters/stub-adapter.ts, but for
 * the CellularVoiceProvider interface: proves the CellularEndpointRegistry,
 * event ingestion into SessionManager, and cross-channel ConversationService
 * all work correctly before any real Bluetooth/chan_mobile hardware is
 * involved. Also just a legitimately useful thing to develop against.
 *
 * Implements VoiceMediaProvider trivially (no real RTP flows) so the full
 * start_voice_session control flow — resolving a cellular call to a
 * media-capable provider, building context, wiring transcripts — can be
 * exercised end-to-end without needing a real AsteriskChanMobileProvider.
 */
export class StubCellularVoiceProvider implements CellularVoiceProvider, VoiceMediaProvider {
  readonly id: string;
  private handler: AdapterEventHandler | null = null;
  private calls = new Map<string, CallSession>();

  constructor(id = "stub-cellular-voice") {
    this.id = id;
  }

  async init(): Promise<void> {}

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  async dial(endpoint: CellularEndpointConfig, destination: string): Promise<CallSession> {
    const session: CallSession = {
      id: newId("call"),
      provider: this.id,
      direction: "outbound",
      from: { address: endpoint.phoneNumber! },
      to: { address: destination },
      state: "dialing",
      startedAt: new Date().toISOString(),
    };
    this.calls.set(session.id, session);

    setTimeout(() => {
      const c = this.calls.get(session.id);
      if (!c) return;
      c.state = "in-progress";
      this.handler?.({ type: "call.state_changed", callId: c.id, state: "in-progress" });
    }, 500);

    return session;
  }

  simulateIncomingCall(endpoint: CellularEndpointConfig, from: string): CallSession {
    const session: CallSession = {
      id: newId("call"), provider: this.id, direction: "inbound",
      from: { address: from }, to: { address: endpoint.phoneNumber! },
      state: "ringing", startedAt: new Date().toISOString(),
    };
    this.calls.set(session.id, session);
    this.handler?.({ type: "call.incoming", call: session });
    return session;
  }

  async answer(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.state = "in-progress";
    this.handler?.({ type: "call.state_changed", callId, state: "in-progress" });
  }

  async hangup(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.state = "ended";
    c.endedAt = new Date().toISOString();
    this.handler?.({ type: "call.ended", callId });
  }

  async getStatus(_endpoint: CellularEndpointConfig): Promise<VoiceProviderStatus> {
    return { available: true, detail: "SIMULATED — no Bluetooth, Android, carrier, or real audio hardware is connected" };
  }

  /**
   * Trivial stub: records that a "bridge" exists without any real RTP flow
   * (there's no real Asterisk/Bluetooth phone behind this provider). This
   * is enough to exercise start_voice_session's control flow — resolving a
   * cellular call to a media-capable provider, building context, wiring
   * transcript callbacks — without needing real hardware. No audio
   * actually flows; use AsteriskChanMobileProvider for that.
   */
  async startMediaBridge(_callId: string, _externalHost: string): Promise<MediaBridgeHandle> {
    return { bridgeId: newId("bridge"), externalChannelId: newId("extchan") };
  }

  async stopMediaBridge(_handle: MediaBridgeHandle): Promise<void> {
    // nothing to tear down
  }

  async shutdown(): Promise<void> {
    this.calls.clear();
  }
}
