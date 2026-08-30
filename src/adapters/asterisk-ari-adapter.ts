import WebSocket from "ws";
import { newId } from "../core/session-manager.js";
import { MediaBridgeHandle, VoiceMediaProvider } from "../media/voice-media-provider.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  CallSession,
  CallState,
  ChannelKind,
  CommunicationAdapter,
  DialOptions,
  Endpoint,
} from "../core/types.js";

export interface AsteriskAriConfig {
  /** e.g. "http://localhost:8088" */
  baseUrl: string;
  username: string;
  password: string;
  /** ARI Stasis app name this adapter registers as, e.g. "ai-gateway" */
  appName: string;
  /** Dialplan context to originate calls into, e.g. "from-ai-agent" */
  originateContext?: string;
  /** Which PJSIP endpoint/trunk to originate through, e.g. "sip-trunk-1" */
  trunkEndpoint?: string;
}

/**
 * AsteriskAriAdapter
 *
 * Talks to a self-hosted Asterisk instance (behind Kamailio/RTPengine, see
 * docker/docker-compose.yml) over the Asterisk REST Interface (ARI):
 *   - REST calls to originate/hangup/hold/mute/transfer/DTMF
 *   - A persistent WebSocket subscription for Stasis events (incoming calls,
 *     state changes, hangups, DTMF) which are translated into AdapterEvents.
 *
 * This is the "self-hosted PBX" side of the gateway: PSTN in/out flows
 * through whatever SIP trunk you've configured on the Asterisk box, so the
 * per-minute cost is whatever your wholesale carrier charges — Asterisk
 * itself, Kamailio, and RTPengine are all free/open-source.
 */
export class AsteriskAriAdapter implements CommunicationAdapter, VoiceMediaProvider {
  readonly id: string;
  readonly capabilities: ChannelKind[] = ["voice"];

  private config!: AsteriskAriConfig;
  private handler: AdapterEventHandler | null = null;
  private ws: WebSocket | null = null;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private calls = new Map<string, CallSession & { channelId: string }>();

  constructor(id = "asterisk") {
    this.id = id;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as AsteriskAriConfig;
    if (!cfg.baseUrl || !cfg.username || !cfg.password || !cfg.appName) {
      throw new Error(
        `AsteriskAriAdapter "${this.id}" requires baseUrl, username, password, appName`
      );
    }
    this.config = {
      originateContext: "from-ai-agent",
      ...cfg,
    };
    this.connectEvents();
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  private emit(event: AdapterEvent) {
    this.handler?.(event);
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

  /** Opens the ARI WebSocket and maps Stasis events onto AdapterEvents. Auto-reconnects. */
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

    ws.on("close", () => {
      if (!this.stopping) this.reconnectTimer = setTimeout(() => this.connectEvents(), 2000);
    });

    ws.on("error", () => {
      ws.close();
    });
  }

  private handleAriEvent(evt: any) {
    switch (evt.type) {
      case "StasisStart": {
        const channel = evt.channel;
        if (channel?.name?.startsWith("UnicastRTP/") || channel?.channelvars?.UNICASTRTP_LOCAL_ADDRESS) return;
        if (!channel?.caller?.number && !channel?.dialplan?.exten) return;
        // Only treat as a *new inbound* call if we don't already know about it
        // (outbound calls we originated also enter Stasis).
        if (!this.findByChannel(channel.id)) {
          const session: CallSession & { channelId: string } = {
            id: newId("call"),
            channelId: channel.id,
            provider: this.id,
            direction: "inbound",
            from: { address: channel.caller?.number ?? "unknown" },
            to: { address: channel.dialplan?.exten ?? "unknown" },
            state: "ringing",
            startedAt: new Date().toISOString(),
          };
          this.calls.set(session.id, session);
          this.emit({ type: "call.incoming", call: session });
        }
        break;
      }
      case "ChannelStateChange": {
        const call = this.findByChannel(evt.channel.id);
        if (!call) return;
        const state = this.mapAriState(evt.channel.state);
        call.state = state;
        this.emit({ type: "call.state_changed", callId: call.id, state });
        break;
      }
      case "ChannelDtmfReceived": {
        const call = this.findByChannel(evt.channel.id);
        if (!call) return;
        this.emit({ type: "call.dtmf", callId: call.id, digit: evt.digit });
        break;
      }
      case "StasisEnd": {
        const call = this.findByChannel(evt.channel.id);
        if (!call) return;
        call.state = "ended";
        call.endedAt = new Date().toISOString();
        this.emit({ type: "call.ended", callId: call.id });
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

  async dial(to: Endpoint, opts?: DialOptions): Promise<CallSession> {
    const endpoint = `PJSIP/${to.address}@${this.config.trunkEndpoint ?? "sip-trunk-1"}`;
    const result = await this.ariRequest("/channels", "POST", {
      endpoint,
      app: this.config.appName,
      context: this.config.originateContext,
      callerId: opts?.from?.address,
    });

    const session: CallSession & { channelId: string } = {
      id: newId("call"),
      channelId: result.id,
      provider: this.id,
      direction: "outbound",
      from: opts?.from ?? { address: "pbx:local" },
      to,
      state: "dialing",
      startedAt: new Date().toISOString(),
      mediaStreamUrl: opts?.attachMediaStreamUrl,
    };
    this.calls.set(session.id, session);
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

  async hold(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/hold`, on ? "POST" : "DELETE");
  }

  async mute(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/mute?direction=both`, on ? "POST" : "DELETE");
  }

  async transfer(callId: string, to: Endpoint): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/redirect?endpoint=PJSIP/${to.address}`, "POST");
  }

  async sendDtmf(callId: string, digits: string): Promise<void> {
    const call = this.mustGet(callId);
    await this.ariRequest(`/channels/${call.channelId}/dtmf?dtmf=${encodeURIComponent(digits)}`, "POST");
  }

  async record(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    if (on) {
      await this.ariRequest(`/channels/${call.channelId}/record`, "POST", {
        name: `${call.id}-${Date.now()}`,
        format: "wav",
      });
    }
    // Stopping a specific recording requires tracking its name; omitted for brevity.
  }

  private mustGet(callId: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown call ${callId}`);
    return call;
  }

  /** Exposes the underlying ARI channel id for a call, needed to bridge external media. */
  getChannelId(callId: string): string {
    return this.mustGet(callId).channelId;
  }

  /**
   * Bridges a call to an ARI `externalMedia` channel, which makes Asterisk
   * send/receive raw RTP (u-law by default) to/from `externalHost`
   * ("host:port" — typically the Media Engine's UDP listener). This is what
   * lets an external process (the Media Engine) hear and speak into a live
   * call without Asterisk itself needing to know anything about realtime
   * voice models. Implements the generic VoiceMediaProvider capability —
   * see src/media/voice-media-provider.ts.
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

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
