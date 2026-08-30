import dgram, { Socket } from "dgram";
import {
  buildRtpPacket,
  chunkIntoFrames,
  parseRtpPacket,
  PCMU_PAYLOAD_TYPE,
  SAMPLES_PER_20MS,
} from "./rtp-codec.js";
import { RealtimeVoiceProvider } from "./realtime-provider.js";

const FRAME_INTERVAL_MS = 20;
const MAX_OUTBOUND_FRAMES = 500; // 10 seconds at 20ms/frame

interface MediaSession {
  callId: string;
  socket: Socket;
  localPort: number;
  provider: RealtimeVoiceProvider;
  remoteAddr: string | null;
  remotePort: number | null;
  ssrc: number;
  seq: number;
  timestamp: number;
  outboundQueue: Buffer[]; // 160-byte u-law frames waiting to be sent, paced at 20ms
  paceTimer: NodeJS.Timeout;
}

export interface MediaEngineOptions {
  /** Host the Media Engine listens on / advertises to Asterisk for RTP. */
  localHost?: string;
  portRangeStart?: number;
  portRangeEnd?: number;
}

/**
 * The Media Engine is the missing link between "the call connects" and
 * "you can actually talk through it": it terminates the RTP stream Asterisk
 * sends via ARI's externalMedia channel, feeds the caller's audio into a
 * RealtimeVoiceProvider, and paces the model's audio replies back out onto
 * the same RTP stream at real-time (20ms/frame) speed so playback doesn't
 * sound choppy or rushed.
 *
 * One MediaEngine instance manages many concurrent call sessions, each with
 * its own UDP socket, provider connection, and outbound pacing timer.
 */
export class MediaEngine {
  private sessions = new Map<string, MediaSession>();
  private localHost: string;
  private portRangeStart: number;
  private portRangeEnd: number;
  private nextPort: number;

  constructor(opts: MediaEngineOptions = {}) {
    this.localHost = opts.localHost ?? "127.0.0.1";
    this.portRangeStart = opts.portRangeStart ?? 40000;
    this.portRangeEnd = opts.portRangeEnd ?? 40200;
    this.nextPort = this.portRangeStart;
  }

  /**
   * Starts a session for a call: binds a local UDP port, connects the
   * realtime voice provider, and starts pacing audio out. Returns the
   * `host:port` to hand to Asterisk's `externalMedia` channel as
   * `external_host` — Asterisk will send RTP there and (with symmetric RTP)
   * accept RTP sent back from the same socket.
   */
  async startSession(
    callId: string,
    provider: RealtimeVoiceProvider,
    opts?: { instructions?: string }
  ): Promise<{ host: string; port: number }> {
    if (this.sessions.has(callId)) {
      throw new Error(`Media session already active for call ${callId}`);
    }

    const { socket, port: localPort } = await this.bindAvailablePort();
    try { await provider.connect({ instructions: opts?.instructions }); }
    catch (error) { socket.close(); await provider.close().catch(() => {}); throw error; }

    const session: MediaSession = {
      callId,
      socket,
      localPort,
      provider,
      remoteAddr: null,
      remotePort: null,
      ssrc: Math.floor(Math.random() * 0xffffffff),
      seq: Math.floor(Math.random() * 0xffff),
      timestamp: Math.floor(Math.random() * 0xffffffff),
      outboundQueue: [],
      paceTimer: setInterval(() => this.flushOneFrame(callId), FRAME_INTERVAL_MS),
    };
    this.sessions.set(callId, session);

    socket.on("message", (msg, rinfo) => {
      // Learn Asterisk's actual source address/port on first packet
      // (symmetric RTP) so we know where to send audio back to.
      session.remoteAddr = rinfo.address;
      session.remotePort = rinfo.port;

      const packet = parseRtpPacket(msg);
      if (!packet || packet.payload.length === 0) return;
      provider.sendAudioChunk(packet.payload.toString("base64"));
    });

    provider.onAudioDelta((base64Ulaw) => {
      const buf = Buffer.from(base64Ulaw, "base64");
      const frames = chunkIntoFrames(buf, SAMPLES_PER_20MS);
      session.outboundQueue.push(...frames);
      if (session.outboundQueue.length > MAX_OUTBOUND_FRAMES) {
        session.outboundQueue.splice(0, session.outboundQueue.length - MAX_OUTBOUND_FRAMES);
      }
    });

    return { host: this.localHost, port: localPort };
  }

  async stopSession(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;
    this.sessions.delete(callId);
    clearInterval(session.paceTimer);
    session.socket.close();
    await session.provider.close().catch(() => {});
  }

  isActive(callId: string): boolean {
    return this.sessions.has(callId);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((callId) => this.stopSession(callId)));
  }

  private async bindAvailablePort(): Promise<{ socket: Socket; port: number }> {
    const attempts = Math.floor((this.portRangeEnd - this.portRangeStart) / 2) + 1;
    for (let i = 0; i < attempts; i++) {
      const port = this.nextPort;
      this.nextPort = port + 2 > this.portRangeEnd ? this.portRangeStart : port + 2;
      const socket = dgram.createSocket("udp4");
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(port, () => resolve());
        });
        return { socket, port };
      } catch { socket.close(); }
    }
    throw new Error(`No available RTP port in range ${this.portRangeStart}-${this.portRangeEnd}`);
  }

  private flushOneFrame(callId: string) {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (!session.remoteAddr || !session.remotePort) return; // haven't heard from Asterisk yet
    const frame = session.outboundQueue.shift();
    if (!frame || frame.length === 0) return; // nothing queued this tick — just stay silent

    const packet = buildRtpPacket({
      sequenceNumber: session.seq++,
      timestamp: session.timestamp,
      ssrc: session.ssrc,
      payload: frame,
      payloadType: PCMU_PAYLOAD_TYPE,
    });
    session.timestamp = (session.timestamp + SAMPLES_PER_20MS) >>> 0;

    session.socket.send(packet, session.remotePort, session.remoteAddr);
  }
}
