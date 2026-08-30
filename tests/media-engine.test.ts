import test from "node:test";
import assert from "node:assert/strict";
import { MediaEngine } from "../src/media/media-engine.js";
import type { RealtimeVoiceProvider } from "../src/media/realtime-provider.js";
import dgram from "node:dgram";

function provider(connect: () => Promise<void>): RealtimeVoiceProvider {
  return { connect, sendAudioChunk() {}, onAudioDelta() {}, async close() {} };
}

test("MediaEngine releases its UDP port when realtime connection fails", async () => {
  const probe = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => probe.bind(0, "127.0.0.1", () => resolve()));
  const address = probe.address();
  const port = typeof address === "string" ? 0 : address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const engine = new MediaEngine({ portRangeStart: port, portRangeEnd: port });
  await assert.rejects(() => engine.startSession("failed", provider(async () => { throw new Error("connect failed"); })), /connect failed/);
  const sessionAddress = await engine.startSession("working", provider(async () => {}));
  assert.equal(sessionAddress.port, port);
  await engine.shutdown();
  assert.equal(engine.isActive("working"), false);
});
