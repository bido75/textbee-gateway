import { newId } from "../core/session-manager.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  CallSession,
  ChannelKind,
  CommunicationAdapter,
  DialOptions,
  Endpoint,
  MessageRecord,
  SendMessageOptions,
} from "../core/types.js";

/**
 * StubAdapter — a fully in-memory, fake provider.
 *
 * Purpose: prove out the MCP tool contract end-to-end (dial/answer/hangup/
 * send_message/etc.) before wiring up anything real. It "answers" its own
 * outbound calls after a short delay and echoes back any SMS it "sends" as
 * an inbound reply, so you can exercise the whole flow with zero external
 * dependencies.
 */
export class StubAdapter implements CommunicationAdapter {
  readonly id: string;
  readonly capabilities: ChannelKind[] = ["voice", "sms", "mms"];

  private handler: AdapterEventHandler | null = null;
  private calls = new Map<string, CallSession>();

  constructor(id = "stub") {
    this.id = id;
  }

  async init(_config: Record<string, unknown>): Promise<void> {
    // nothing to configure
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  private emit(event: AdapterEvent) {
    this.handler?.(event);
  }

  async dial(to: Endpoint, opts?: DialOptions): Promise<CallSession> {
    const session: CallSession = {
      id: newId("call"),
      provider: this.id,
      direction: "outbound",
      from: opts?.from ?? { address: "stub:local" },
      to,
      state: "dialing",
      startedAt: new Date().toISOString(),
      mediaStreamUrl: opts?.attachMediaStreamUrl,
    };
    this.calls.set(session.id, session);

    // Simulate ringing -> in-progress so the AI agent sees realistic state transitions.
    setTimeout(() => {
      const c = this.calls.get(session.id);
      if (!c) return;
      c.state = "ringing";
      this.emit({ type: "call.state_changed", callId: c.id, state: "ringing" });
    }, 300);

    setTimeout(() => {
      const c = this.calls.get(session.id);
      if (!c) return;
      c.state = "in-progress";
      this.emit({ type: "call.state_changed", callId: c.id, state: "in-progress" });
    }, 900);

    return session;
  }

  async answer(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.state = "in-progress";
    this.emit({ type: "call.state_changed", callId, state: "in-progress" });
  }

  async hangup(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.state = "ended";
    c.endedAt = new Date().toISOString();
    this.emit({ type: "call.ended", callId, reason: "local_hangup" });
  }

  async hold(callId: string, on: boolean): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.state = on ? "on-hold" : "in-progress";
    this.emit({ type: "call.state_changed", callId, state: c.state });
  }

  async mute(_callId: string, _on: boolean): Promise<void> {
    // no-op for the stub
  }

  async transfer(callId: string, to: Endpoint): Promise<void> {
    const c = this.calls.get(callId);
    if (!c) throw new Error(`Unknown call ${callId}`);
    c.to = to;
  }

  async sendDtmf(_callId: string, _digits: string): Promise<void> {
    // no-op for the stub
  }

  async record(_callId: string, _on: boolean): Promise<void> {
    // no-op for the stub
  }

  async sendMessage(
    to: Endpoint,
    body: string,
    opts?: SendMessageOptions
  ): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: newId("msg"),
      provider: this.id,
      kind: opts?.mediaUrls?.length ? "mms" : "sms",
      direction: "outbound",
      from: opts?.from ?? { address: "stub:local" },
      to,
      body,
      mediaUrls: opts?.mediaUrls,
      sentAt: new Date().toISOString(),
      status: "sent",
    };

    // Simulate an automatic inbound reply so send/receive flow can be tested.
    setTimeout(() => {
      this.emit({
        type: "message.incoming",
        message: {
          id: newId("msg"),
          provider: this.id,
          kind: record.kind,
          direction: "inbound",
          from: to,
          to: record.from,
          body: `[stub echo] received: ${body}`,
          sentAt: new Date().toISOString(),
          status: "received",
        },
      });
    }, 500);

    return record;
  }

  async shutdown(): Promise<void> {
    this.calls.clear();
  }
}
