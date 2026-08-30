import WebSocket from "ws";
import { newId } from "../core/session-manager.js";
import { CallSession, CallState } from "../core/types.js";
import { AdapterEventHandler } from "../core/types.js";
import { MediaBridgeHandle, VoiceMediaProvider } from "../media/voice-media-provider.js";
import {
  DtmfCapability,
  HoldCapability,
  MuteCapability,
  TransferCapability,
} from "../media/call-control-capabilities.js";
import { Endpoint } from "../core/types.js";
import {
  CellularEndpointConfig,
  VoiceProviderStatus,
  CellularVoiceProvider,
} from "./types.js";

export interface AsteriskChanMobileConfig {
  /** e.g. "http://localhost:8088" — same Asterisk box, can be the same server as the SIP-trunk ARI adapter. */
  baseUrl: string;
  username: string;
  password: string;
  /**
   * This provider's own ARI Stasis app name. Give it a name distinct from
   * the SIP-trunk AsteriskAriAdapter's app (e.g. "ai-gateway-mobile" vs
   * "ai-gateway") so Asterisk can route trunk calls and mobile calls into
   * different application instances even though both live on one Asterisk box.
   */
  appName: string;
  /**
   * The chan_mobile device name configured in Asterisk's mobile.conf for
   * this specific paired phone, e.g. "mobile0". One device = one physical
   * Bluetooth-paired Android phone = (in this architecture) one CellularEndpoint.
   */
  chanMobileDevice: string;
  /** Development only: override Mobile/device/number with a Local channel template. */
  channelTemplate?: string;
  /** Marks this provider as Docker/mock validated, never real cellular hardware. */
  simulated?: boolean;
}

/**
 * AsteriskChanMobileProvider — reference/prototype CellularVoiceProvider
 * backend. Bridges Asterisk's `chan_mobile` channel driver, which pairs to
 * an Android phone over Bluetooth Hands-Free Profile (the same profile a
 * car stereo uses) and lets Asterisk treat that phone as a dialable/
 * answerable device — no APK, no root, no custom Android code at all.
 *
 * IMPORTANT — honest limitations, deliberately NOT leaked into the generic
 * CellularVoiceProvider interface above this class:
 *   - Requires a working Bluetooth/BlueZ setup on the Asterisk host and the
 *     phone to be paired and within Bluetooth range continuously.
 *   - Audio is narrowband (phone-call quality), not HD.
 *   - Each simultaneously-connected phone generally needs its own Bluetooth
 *     adapter on the server — this does not scale to many lines on one box.
 *   - `chan_mobile` is community-maintained in Asterisk, not part of the
 *     actively-maintained core channel drivers.
 *   - This implementation follows Asterisk's documented ARI/chan_mobile
 *     mechanics but has NOT been exercised against real Bluetooth hardware
 *     or a live paired phone in this development environment. Treat it as
 *     a correct-per-the-docs starting point, not a verified integration —
 *     validate against real hardware before depending on it. This now also
 *     covers startMediaBridge()/stopMediaBridge(): the ARI bridge +
 *     externalMedia calls are identical to AsteriskAriAdapter's (proven
 *     against a mock ARI server — see examples/), but a chan_mobile
 *     channel's actual audio behavior under that bridge is exactly the
 *     untested part.
 *
 * SMS is deliberately NOT implemented here even though chan_mobile exposes
 * some SMS capability on certain devices — see the project README: TextBee
 * remains the single messaging path so there is exactly one place that owns
 * inbound events, delivery status, retries, and message history for a
 * CellularEndpoint's SMS/MMS.
 */
export class AsteriskChanMobileProvider
  implements CellularVoiceProvider, VoiceMediaProvider, HoldCapability, MuteCapability, TransferCapability, DtmfCapability
{
  readonly id: string;

  private config!: AsteriskChanMobileConfig;
  private handler: AdapterEventHandler | null = null;
  private ws: WebSocket | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private calls = new Map<string, CallSession & { channelId: string }>();

  constructor(id = "asterisk-chan-mobile") {
    this.id = id;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as AsteriskChanMobileConfig;
    if (!cfg.baseUrl || !cfg.username || !cfg.password || !cfg.appName || (!cfg.chanMobileDevice && !cfg.channelTemplate)) {
      throw new Error(
        `AsteriskChanMobileProvider "${this.id}" requires baseUrl, username, password, appName, chanMobileDevice`
      );
    }
    this.config = cfg;
    this.connectEvents();
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
  }

  private wsUrl(): string {
    const httpUrl = new URL(this.config.baseUrl);
    const proto = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${httpUrl.host}/ari/events?app=${encodeURIComponent(
      this.config.appName
    )}&api_key=${encodeURIComponent(this.config.username + ":" + this.config.password)}`;
  }

  private connectEvents() {
    if (this.stopping) return;
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.on("message", (raw) => {
      let evt: any;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleAriEvent(evt);
    });

    ws.on("close", () => { if (!this.stopping) this.reconnectTimer = setTimeout(() => this.connectEvents(), 2000); });
    ws.on("error", () => ws.close());
  }

  private handleAriEvent(evt: any) {
    switch (evt.type) {
      case "StasisStart": {
        const channel = evt.channel;
        // ARI ExternalMedia channels enter the same Stasis application. They
        // are bridge plumbing, not new phone calls, and must never become a
        // second conversation/call record.
        if (channel?.name?.startsWith("UnicastRTP/") || channel?.channelvars?.UNICASTRTP_LOCAL_ADDRESS) return;
        if (!channel?.caller?.number && !channel?.dialplan?.exten) return;
        if (!this.findByChannel(channel.id)) {
          // Inbound cellular call: someone dialed this phone's real number,
          // the phone rang, and chan_mobile answered the Bluetooth side,
          // handing the call into our Stasis app.
          const session: CallSession & { channelId: string } = {
            id: newId("call"),
            channelId: channel.id,
            provider: this.id,
            direction: "inbound",
            from: { address: channel.caller?.number ?? "unknown" },
            to: { address: this.config.chanMobileDevice },
            state: "ringing",
            startedAt: new Date().toISOString(),
          };
          this.calls.set(session.id, session);
          this.handler?.({ type: "call.incoming", call: session });
        }
        break;
      }
      case "ChannelStateChange": {
        const call = this.findByChannel(evt.channel.id);
        if (!call) return;
        const state = this.mapAriState(evt.channel.state);
        call.state = state;
        this.handler?.({ type: "call.state_changed", callId: call.id, state });
        break;
      }
      case "StasisEnd": {
        const call = this.findByChannel(evt.channel.id);
        if (!call) return;
        call.state = "ended";
        call.endedAt = new Date().toISOString();
        this.handler?.({ type: "call.ended", callId: call.id });
        this.calls.delete(call.id);
        break;
      }
      default:
        break;
    }
  }

  private mapAriState(ariState: string): CallState {
    switch (ariState) {
      case "Ring":
      case "Ringing":
        return "ringing";
      case "Up":
        return "in-progress";
      default:
        return "dialing";
    }
  }

  private findByChannel(channelId: string) {
    for (const call of this.calls.values()) {
      if (call.channelId === channelId) return call;
    }
    return undefined;
  }

  private async ariRequest(path: string, method: string, body?: unknown) {
    const res = await fetch(`${this.config.baseUrl}/ari${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ARI ${method} ${path} failed (${res.status}): ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }

  /**
   * Places an outbound cellular call by originating a channel on the
   * `Mobile` tech directly into this device, per Asterisk's documented
   * `Dial(Mobile/<device>/<number>)` syntax (chan_mobile embeds the
   * destination in the channel string itself, unlike PJSIP where the
   * resource is a static configured endpoint name).
   */
  async dial(endpoint: CellularEndpointConfig, destination: string): Promise<CallSession> {
    const channel = this.config.channelTemplate?.replace("{number}", destination) ?? `Mobile/${this.config.chanMobileDevice}/${destination}`;
    const result = await this.ariRequest("/channels", "POST", {
      endpoint: channel,
      app: this.config.appName,
    });

    const session: CallSession & { channelId: string } = {
      id: newId("call"),
      channelId: result.id,
      provider: this.id,
      direction: "outbound",
      from: { address: endpoint.phoneNumber! },
      to: { address: destination },
      state: "dialing",
      startedAt: new Date().toISOString(),
    };
    this.calls.set(session.id, session);
    return session;
  }

  async simulateIncomingCall(endpoint: CellularEndpointConfig, from: string): Promise<CallSession> {
    if (!this.config.simulated) throw new Error("Inbound simulation is disabled for this real chan_mobile provider");
    const result = await this.ariRequest("/channels", "POST", {
      endpoint: "Local/inbound@sim-cellular",
      app: this.config.appName,
      callerId: from,
    });
    const session: CallSession & { channelId: string } = {
      id: newId("call"), channelId: result.id, provider: this.id, direction: "inbound",
      from: { address: from }, to: { address: endpoint.phoneNumber! }, state: "ringing", startedAt: new Date().toISOString(),
    };
    this.calls.set(session.id, session);
    this.handler?.({ type: "call.incoming", call: session });
    return session;
  }

  async answer(callId: string): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/answer`, "POST");
  }

  async hangup(callId: string): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}`, "DELETE");
  }

  /**
   * Best-effort status only. ARI's /endpoints listing is well-defined for
   * technologies like PJSIP; chan_mobile's representation there is not
   * something this implementation has been able to verify against real
   * hardware, so failures here are swallowed and reported as "unknown"
   * rather than thrown — a status check should never itself crash the
   * gateway. Treat this as informational, not authoritative. Reports only
   * on the voice side — messaging status is a separate concern, combined
   * in by CellularEndpointRegistry.getStatus() (see cellular/endpoint-registry.ts).
   */
  async getStatus(_endpoint: CellularEndpointConfig): Promise<VoiceProviderStatus> {
    if (this.config.simulated) {
      return { available: this.ws?.readyState === WebSocket.OPEN, detail: "SIMULATED Asterisk ARI/Local channel — Bluetooth HFP and cellular carrier are not validated" };
    }
    try {
      const endpoints: any[] = await this.ariRequest("/endpoints", "GET");
      const mine = endpoints?.find(
        (e) => e.technology === "Mobile" && e.resource === this.config.chanMobileDevice
      );
      return {
        available: !!mine,
        detail: mine
          ? `chan_mobile device "${this.config.chanMobileDevice}" reported by ARI`
          : `chan_mobile device "${this.config.chanMobileDevice}" not found in ARI /endpoints — status reporting for this tech is best-effort and unverified`,
      };
    } catch (err: any) {
      return {
        available: false,
        detail: `status check failed: ${err?.message ?? err}`,
      };
    }
  }

  private mustGet(callId: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown call ${callId}`);
    return call;
  }

  /**
   * Bridges this cellular call's audio to an external RTP endpoint, exactly
   * the same ARI mechanism AsteriskAriAdapter uses for SIP-trunk calls
   * (bridge + externalMedia channel) — because underneath, a chan_mobile
   * call is still an Asterisk channel like any other. This is what makes
   * "AI can actually speak/listen through a cellular call" possible without
   * inventing a second audio transport: Asterisk's ExternalMedia mechanism
   * doesn't care whether the other leg is a SIP trunk or a Bluetooth phone.
   */
  async startMediaBridge(
    callId: string,
    externalHost: string,
    format = "ulaw"
  ): Promise<MediaBridgeHandle> {
    const call = this.mustGet(callId);

    const bridge = await this.ariRequest("/bridges", "POST", { type: "mixing" });
    let externalChannel: any;
    try {
      externalChannel = await this.ariRequest(
        `/channels/externalMedia?app=${encodeURIComponent(this.config.appName)}` +
          `&external_host=${encodeURIComponent(externalHost)}&format=${encodeURIComponent(format)}`, "POST"
      );
      await this.ariRequest(`/bridges/${bridge.id}/addChannel?channel=${call.channelId}`, "POST");
      await this.ariRequest(`/bridges/${bridge.id}/addChannel?channel=${externalChannel.id}`, "POST");
      return { bridgeId: bridge.id, externalChannelId: externalChannel.id };
    } catch (error) {
      if (externalChannel?.id) await this.ariRequest(`/channels/${externalChannel.id}`, "DELETE").catch(() => {});
      await this.ariRequest(`/bridges/${bridge.id}`, "DELETE").catch(() => {});
      throw error;
    }
  }

  /** Tears down a bridge started with startMediaBridge(). */
  async stopMediaBridge(handle: MediaBridgeHandle): Promise<void> {
    await this.ariRequest(`/channels/${handle.externalChannelId}`, "DELETE").catch(() => {});
    await this.ariRequest(`/bridges/${handle.bridgeId}`, "DELETE").catch(() => {});
  }

  // --- Call-control capabilities (HoldCapability, MuteCapability,
  // TransferCapability, DtmfCapability) — same underlying ARI channel
  // endpoints AsteriskAriAdapter uses, since a chan_mobile call is still
  // an ordinary Asterisk channel underneath. ---

  async setHold(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/hold`, on ? "POST" : "DELETE");
  }

  async setMute(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/mute?direction=both`, on ? "POST" : "DELETE");
  }

  async transferCall(callId: string, to: Endpoint): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/redirect?endpoint=Mobile/${to.address}`, "POST");
  }

  async sendDtmfDigits(callId: string, digits: string): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/dtmf?dtmf=${encodeURIComponent(digits)}`, "POST");
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
