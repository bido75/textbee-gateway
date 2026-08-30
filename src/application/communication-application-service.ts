import { SessionManager } from "../core/session-manager.js";
import { CellularEndpointRegistry } from "../cellular/endpoint-registry.js";
import { ConversationService } from "../core/conversation-service.js";
import { MediaEngine } from "../media/media-engine.js";
import { createRealtimeVoiceProvider } from "../media/realtime-registry.js";
import { supportsVoiceMedia } from "../media/voice-media-provider.js";
import { supportsDtmf, supportsHold, supportsTransfer } from "../media/call-control-capabilities.js";
import { normalizePhoneNumber } from "../core/phone-normalization.js";

export class CommunicationApplicationService {
  private activeBridges = new Map<string, { bridgeId: string; externalChannelId: string }>();

  constructor(
    readonly manager: SessionManager,
    readonly endpoints: CellularEndpointRegistry,
    readonly conversations: ConversationService,
    readonly media: MediaEngine,
    private defaultVoiceProvider = "stub",
  ) {}

  listEndpoints() { return this.endpoints.list(); }
  getEndpoint(id: string) { return this.endpoints.get(id)?.config; }
  getEndpointStatus(id: string) { return this.endpoints.getStatus(id); }
  getConversation(endpointId: string, counterpart: string, limit = 50) {
    return this.conversations.getConversation(endpointId, counterpart, limit);
  }
  listCalls(limit = 100) { return this.manager.listCallsDurable(limit); }
  getCall(id: string) { return this.manager.getCallDurable(id); }

  async sendMessage(input: { from: string; to: string; body: string; mediaUrls?: string[] }) {
    const record = await this.endpoints.sendMessage(input.from, { address: input.to }, input.body, { mediaUrls: input.mediaUrls });
    await this.conversations.recordMessageTurn(record.provider, record);
    return record;
  }

  async makeCall(input: { from: string; to: string }) {
    const call = await this.endpoints.makeCall(input.from, input.to);
    await this.manager.trackExternalCall(call);
    await this.conversations.recordCallTurn(call.provider, call, "outbound");
    return call;
  }

  async answerCall(callId: string) {
    const { provider } = await this.callAndProvider(callId);
    if (!("answer" in provider) || typeof provider.answer !== "function") throw new Error("Voice provider does not support answer");
    await provider.answer(callId);
    return this.manager.getCallDurable(callId);
  }

  async hangupCall(callId: string) {
    await this.stopVoiceSession(callId);
    const { provider } = await this.callAndProvider(callId);
    if (!("hangup" in provider) || typeof provider.hangup !== "function") throw new Error("Voice provider does not support hangup");
    await provider.hangup(callId);
    return this.manager.getCallDurable(callId);
  }

  async holdCall(callId: string, hold: boolean) {
    const { provider } = await this.callAndProvider(callId);
    if (!supportsHold(provider)) throw new Error("Voice provider does not support hold");
    await provider.setHold(callId, hold);
  }

  async sendDtmf(callId: string, digits: string) {
    if (!/^[0-9A-D*#,]+$/i.test(digits)) throw new Error("Invalid DTMF digits");
    const { provider } = await this.callAndProvider(callId);
    if (!supportsDtmf(provider)) throw new Error("Voice provider does not support DTMF");
    await provider.sendDtmfDigits(callId, digits);
  }

  async transferCall(callId: string, destination: string) {
    const { provider } = await this.callAndProvider(callId);
    if (!supportsTransfer(provider)) throw new Error("Voice provider does not support transfer");
    await provider.transferCall(callId, { address: normalizePhoneNumber(destination) });
  }

  async startVoiceSession(callId: string, opts?: { provider?: string; instructions?: string }) {
    const { call, provider } = await this.callAndProvider(callId);
    if (!supportsVoiceMedia(provider)) throw new Error("Voice provider does not support media bridging");
    await this.conversations.recordCallTurn(call.provider, call, call.direction === "inbound" ? "incoming" : "outbound");
    const endpoint = this.endpoints.findEndpointByProvider(call.provider);
    const counterpart = call.direction === "outbound" ? call.to.address : call.from.address;
    const history = endpoint ? await this.conversations.getConversation(endpoint.id, counterpart, 30) : undefined;
    const context = history ? this.conversations.formatConversationAsContext(history) : "";
    const instructions = [context, opts?.instructions ?? "You are a helpful phone assistant."].filter(Boolean).join("\n\n");
    const realtime = createRealtimeVoiceProvider(opts?.provider ?? this.defaultVoiceProvider);
    realtime.onTranscript?.((text, role) => void this.conversations.recordTranscriptTurn(callId, role, text));
    const address = await this.media.startSession(callId, realtime, { instructions });
    let bridge;
    try { bridge = await provider.startMediaBridge(callId, `${address.host}:${address.port}`); }
    catch (error) { await this.media.stopSession(callId); throw error; }
    this.activeBridges.set(callId, bridge);
    return { callId, simulated: opts?.provider !== "openai", contextIncluded: Boolean(context), media: address };
  }

  async stopVoiceSession(callId: string) {
    const bridge = this.activeBridges.get(callId);
    if (bridge) {
      const call = await this.manager.getCallDurable(callId);
      const provider = call && (this.endpoints.getVoiceProviderById(call.provider) ?? this.manager.getAdapter(call.provider));
      this.activeBridges.delete(callId);
      try { if (supportsVoiceMedia(provider)) await provider.stopMediaBridge(bridge); }
      finally { await this.media.stopSession(callId); }
      return;
    }
    await this.media.stopSession(callId);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.activeBridges.keys()].map((callId) => this.stopVoiceSession(callId)));
    await this.media.shutdown();
  }

  async simulateIncomingCall(endpointId: string, from: string) {
    return this.endpoints.simulateIncomingCall(endpointId, from);
  }
  recordSimulatedTranscript(callId: string, role: "user" | "assistant", text: string) {
    return this.conversations.recordTranscriptTurn(callId, role, text);
  }

  private async callAndProvider(callId: string) {
    const call = await this.manager.getCallDurable(callId);
    if (!call) throw new Error(`Unknown call "${callId}"`);
    const provider = this.endpoints.getVoiceProviderById(call.provider) ?? this.manager.getAdapter(call.provider);
    if (!provider) throw new Error(`Call provider "${call.provider}" is not active in this process`);
    return { call, provider };
  }
}
