import WebSocket from "ws";
import { RealtimeVoiceProvider } from "./realtime-provider.js";

export interface OpenAIRealtimeConfig {
  apiKey: string;
  model?: string; // defaults to a realtime-capable model
  voice?: string; // e.g. "alloy", "verse"
}

/**
 * OpenAIRealtimeVoiceProvider
 *
 * Connects to OpenAI's Realtime API over WebSocket and configures the
 * session to speak/listen in g711_ulaw — the exact format the Media Engine
 * is already moving to/from the RTP socket, so audio passes through
 * unmodified in both directions (no resampling, no codec conversion).
 */
export class OpenAIRealtimeVoiceProvider implements RealtimeVoiceProvider {
  private ws: WebSocket | null = null;
  private deltaHandler: ((base64Ulaw: string) => void) | null = null;
  private transcriptHandler: ((text: string, role: "user" | "assistant") => void) | null = null;
  private ready: Promise<void>;
  private resolveReady!: () => void;

  constructor(private config: OpenAIRealtimeConfig) {
    this.ready = new Promise((resolve) => (this.resolveReady = resolve));
  }

  async connect(opts?: { instructions?: string }): Promise<void> {
    const model = this.config.model ?? "gpt-4o-realtime-preview-2024-10-01";
    this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    this.ws.on("open", () => {
      this.send({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions:
            opts?.instructions ??
            "You are a helpful voice assistant speaking with someone on a phone call.",
          voice: this.config.voice ?? "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
        },
      });
      this.resolveReady();
    });

    this.ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === "response.audio.delta" && msg.delta) {
        this.deltaHandler?.(msg.delta);
      } else if (msg.type === "response.audio_transcript.delta" && msg.delta) {
        this.transcriptHandler?.(msg.delta, "assistant");
      } else if (
        msg.type === "conversation.item.input_audio_transcription.completed" &&
        msg.transcript
      ) {
        this.transcriptHandler?.(msg.transcript, "user");
      }
    });

    await this.ready;
  }

  private send(payload: unknown) {
    this.ws?.send(JSON.stringify(payload));
  }

  sendAudioChunk(base64Ulaw: string): void {
    this.send({ type: "input_audio_buffer.append", audio: base64Ulaw });
  }

  onAudioDelta(cb: (base64Ulaw: string) => void): void {
    this.deltaHandler = cb;
  }

  onTranscript(cb: (text: string, role: "user" | "assistant") => void): void {
    this.transcriptHandler = cb;
  }

  async close(): Promise<void> {
    this.ws?.close();
    this.ws = null;
  }
}
