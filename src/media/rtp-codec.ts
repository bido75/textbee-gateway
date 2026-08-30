/**
 * Minimal RTP (RFC 3550) packetizer/depacketizer, scoped to exactly what the
 * Media Engine needs: G.711 u-law (PCMU, payload type 0) mono 8kHz audio.
 *
 * Why u-law specifically: Asterisk's `pjsip.conf` in this repo allows ulaw,
 * and OpenAI's Realtime API accepts/emits `g711_ulaw` directly. That means
 * the Media Engine never has to transcode audio — it only has to move raw
 * u-law bytes between an RTP socket (Asterisk) and a WebSocket (the realtime
 * voice model), which keeps latency and complexity down.
 */

const RTP_HEADER_LEN = 12;
export const PCMU_PAYLOAD_TYPE = 0;
/** 8kHz, 20ms frames -> 160 samples -> 160 bytes for 8-bit u-law */
export const SAMPLES_PER_20MS = 160;

export interface RtpPacket {
  version: number;
  padding: boolean;
  extension: boolean;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

export function parseRtpPacket(buf: Buffer): RtpPacket | null {
  if (buf.length < RTP_HEADER_LEN) return null;

  const b0 = buf.readUInt8(0);
  const b1 = buf.readUInt8(1);
  const version = b0 >> 6;
  const padding = ((b0 >> 5) & 0x1) === 1;
  const extension = ((b0 >> 4) & 0x1) === 1;
  const csrcCount = b0 & 0x0f;
  const marker = (b1 >> 7) === 1;
  const payloadType = b1 & 0x7f;
  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  let offset = RTP_HEADER_LEN + csrcCount * 4;
  if (extension) {
    if (buf.length < offset + 4) return null;
    const extLenWords = buf.readUInt16BE(offset + 2);
    offset += 4 + extLenWords * 4;
  }
  if (offset > buf.length) return null;

  let payload = buf.subarray(offset);
  if (padding && payload.length > 0) {
    const padLen = payload.readUInt8(payload.length - 1);
    payload = payload.subarray(0, Math.max(0, payload.length - padLen));
  }

  return {
    version,
    padding,
    extension,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload: Buffer.from(payload),
  };
}

export function buildRtpPacket(fields: {
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
  marker?: boolean;
  payloadType?: number;
}): Buffer {
  const header = Buffer.alloc(RTP_HEADER_LEN);
  header.writeUInt8(0x80, 0); // version=2, no padding/extension/csrc
  header.writeUInt8(
    ((fields.marker ? 1 : 0) << 7) | (fields.payloadType ?? PCMU_PAYLOAD_TYPE),
    1
  );
  header.writeUInt16BE(fields.sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(fields.timestamp >>> 0, 4);
  header.writeUInt32BE(fields.ssrc >>> 0, 8);
  return Buffer.concat([header, fields.payload]);
}

/** Splits an arbitrary-length u-law byte buffer into fixed 20ms (160-byte) frames. */
export function chunkIntoFrames(buf: Buffer, frameSize = SAMPLES_PER_20MS): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < buf.length; i += frameSize) {
    frames.push(buf.subarray(i, Math.min(i + frameSize, buf.length)));
  }
  return frames;
}
