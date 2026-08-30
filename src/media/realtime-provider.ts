/**
 * A RealtimeVoiceProvider is whatever's on the "AI brain" side of the audio
 * bridge: something that accepts a stream of raw audio in and emits a stream
 * of raw audio out, doing STT -> reasoning -> TTS internally (ideally with
 * a single low-latency realtime model rather than a chained pipeline).
 *
 * Audio in/out is always base64-encoded G.711 u-law, 8kHz, mono — matching
 * what the Media Engine pulls off/pushes onto the RTP socket. This keeps the
 * provider interface, like the telephony adapter interface, swappable:
 * OpenAI Realtime today, a local Whisper+Ollama+TTS pipeline or Gemini Live
 * tomorrow, with no changes to the Media Engine or MCP layer.
 */
export interface RealtimeVoiceProvider {
  /** Establish the connection to the underlying voice model. */
  connect(opts?: { instructions?: string }): Promise<void>;

  /** Push a chunk of inbound (caller's) audio into the model. */
  sendAudioChunk(base64Ulaw: string): void;

  /** Register a callback invoked whenever the model produces audio to play back. */
  onAudioDelta(cb: (base64Ulaw: string) => void): void;

  /** Optional: surface transcripts for logging/observability. */
  onTranscript?(cb: (text: string, role: "user" | "assistant") => void): void;

  /** Tear down the connection. */
  close(): Promise<void>;
}
