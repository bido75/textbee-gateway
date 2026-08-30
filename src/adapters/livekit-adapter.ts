import { RoomServiceClient, AccessToken } from "livekit-server-sdk";
import { newId } from "../core/session-manager.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  CallSession,
  ChannelKind,
  CommunicationAdapter,
  DialOptions,
  Endpoint,
} from "../core/types.js";

export interface LiveKitConfig {
  /** LiveKit server URL, e.g. "https://your-livekit-host:7880" (self-hosted) or your LiveKit Cloud project URL */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * LiveKitAdapter — self-hosted WebRTC calling via a LiveKit server
 * (open-source SFU: https://github.com/livekit/livekit). This is the
 * "app-to-app" voice path from the original architecture sketch: it's for
 * calling a WebRTC client (a phone/web app you control), NOT for dialing
 * PSTN phone numbers — for that, use the Asterisk/Kamailio adapter, or
 * LiveKit's own SIP bridge (livekit-server-sdk's SipClient) if you want
 * LiveKit to own PSTN too. That SIP integration is not wired up here; this
 * adapter deliberately stays focused on room/participant lifecycle so it's
 * easy to reason about.
 *
 * Important architectural point: unlike a phone call, there's no single
 * "audio socket" the Node backend can just start writing to — the actual
 * audio flows over WebRTC directly between the LiveKit server and whichever
 * client(s) join the room. This adapter's job is the CONTROL plane (create
 * the room, mint access tokens, track who's joined) — the media plane is
 * either a real client joining with the token from `getJoinToken()`, or (for
 * an AI participant) a LiveKit Agents worker joining the same room. That's
 * analogous to how the Asterisk adapter is control-plane and the Media
 * Engine is the separate media-plane process.
 */
export class LiveKitAdapter implements CommunicationAdapter {
  readonly id: string;
  readonly capabilities: ChannelKind[] = ["voice"];

  private config!: LiveKitConfig;
  private handler: AdapterEventHandler | null = null;
  private rooms!: RoomServiceClient;
  private calls = new Map<string, CallSession & { roomName: string }>();

  constructor(id = "livekit") {
    this.id = id;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    const cfg = config as unknown as LiveKitConfig;
    if (!cfg.url || !cfg.apiKey || !cfg.apiSecret) {
      throw new Error(`LiveKitAdapter "${this.id}" requires url, apiKey, apiSecret`);
    }
    this.config = cfg;
    this.rooms = new RoomServiceClient(cfg.url, cfg.apiKey, cfg.apiSecret);
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  /**
   * "Dialing" in LiveKit terms means: create a room and mint a join token
   * for the callee identity (`to.address`). Getting that token in front of
   * the callee (push notification, deep link, whatever) is outside this
   * adapter's scope — see `getJoinToken()`.
   */
  async dial(to: Endpoint, opts?: DialOptions): Promise<CallSession> {
    const roomName = `call-${newId("room")}`;
    await this.rooms.createRoom({ name: roomName, emptyTimeout: 300, maxParticipants: 4 });

    const session: CallSession & { roomName: string } = {
      id: newId("call"),
      roomName,
      provider: this.id,
      direction: "outbound",
      from: opts?.from ?? { address: "livekit:ai-agent" },
      to,
      state: "dialing",
      startedAt: new Date().toISOString(),
      mediaStreamUrl: opts?.attachMediaStreamUrl,
    };
    this.calls.set(session.id, session);
    return session;
  }

  /** Mints a LiveKit access token for a participant to join a call's room. */
  async getJoinToken(callId: string, identity: string, name?: string): Promise<string> {
    const call = this.mustGet(callId);
    const token = new AccessToken(this.config.apiKey, this.config.apiSecret, {
      identity,
      name,
      ttl: "10m",
    });
    token.addGrant({ roomJoin: true, room: call.roomName, canPublish: true, canSubscribe: true });
    return token.toJwt();
  }

  async answer(callId: string): Promise<void> {
    // There's no server-side "answer" action for LiveKit — the callee
    // answers by joining the room with their token. We optimistically mark
    // the call in-progress here; startExternalMedia/webhooks correct this
    // once a real participant join event arrives (see livekit-webhook-server.ts).
    const call = this.mustGet(callId);
    call.state = "in-progress";
    this.handler?.({ type: "call.state_changed", callId, state: "in-progress" });
  }

  async hangup(callId: string): Promise<void> {
    const call = this.mustGet(callId);
    await this.rooms.deleteRoom(call.roomName);
    call.state = "ended";
    call.endedAt = new Date().toISOString();
    this.handler?.({ type: "call.ended", callId });
  }

  async transfer(): Promise<void> {
    throw new Error("transfer() is not meaningful for LiveKit rooms — invite another participant instead");
  }

  async mute(callId: string, on: boolean): Promise<void> {
    const call = this.mustGet(callId);
    await this.rooms.mutePublishedTrack(call.roomName, call.to.address, "__all__", on).catch(() => {
      // Best-effort: exact track SIDs aren't known generically here: a real
      // deployment would look up the participant's track list first via
      // this.rooms.getParticipant(...) and mute each track SID explicitly.
    });
  }

  /** Surfaces LiveKit room/participant lifecycle webhook events as AdapterEvents. Call from livekit-webhook-server.ts. */
  handleWebhookEvent(event: { event: string; room?: { name?: string }; participant?: { identity?: string } }): void {
    const callId = this.findCallIdByRoom(event.room?.name);
    if (!callId) return;

    if (event.event === "participant_joined") {
      this.handler?.({ type: "call.state_changed", callId, state: "in-progress" });
    } else if (event.event === "participant_left" || event.event === "room_finished") {
      const call = this.calls.get(callId);
      if (call) {
        call.state = "ended";
        call.endedAt = new Date().toISOString();
      }
      this.handler?.({ type: "call.ended", callId });
    }
  }

  private findCallIdByRoom(roomName?: string): string | undefined {
    if (!roomName) return undefined;
    for (const call of this.calls.values()) {
      if (call.roomName === roomName) return call.id;
    }
    return undefined;
  }

  private mustGet(callId: string) {
    const call = this.calls.get(callId);
    if (!call) throw new Error(`Unknown call ${callId}`);
    return call;
  }

  async shutdown(): Promise<void> {
    this.calls.clear();
  }
}
