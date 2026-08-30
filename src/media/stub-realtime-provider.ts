import { RealtimeVoiceProvider } from "./realtime-provider.js";

/**
 * StubRealtimeVoiceProvider — no external API calls at all. Echoes whatever
 * audio it receives back out a short delay later. Exists purely to prove the
 * Media Engine's RTP <-> provider bridging works (packetization, pacing,
 * session lifecycle) before wiring up a real model and burning API credits.
 */
export class StubRealtimeVoiceProvider implements RealtimeVoiceProvider {
  private deltaHandler: ((base64Ulaw: string) => void) | null = null;

  async connect(): Promise<void> {
    // nothing to connect to
  }

  sendAudioChunk(base64Ulaw: string): void {
    setTimeout(() => this.deltaHandler?.(base64Ulaw), 150);
  }

  onAudioDelta(cb: (base64Ulaw: string) => void): void {
    this.deltaHandler = cb;
  }

  async close(): Promise<void> {
    this.deltaHandler = null;
  }
}
