/**
 * VoiceMediaProvider is a capability, not a provider type: "this call's
 * underlying channel can be bridged to an external RTP endpoint." Both
 * AsteriskAriAdapter (SIP trunk voice) and AsteriskChanMobileProvider
 * (cellular voice via Bluetooth HFP) implement it, using the exact same ARI
 * bridge + externalMedia mechanism under the hood — because both are, in
 * the end, Asterisk channels.
 *
 * start_voice_session (mcp/server.ts) resolves this capability generically:
 * "does whatever produced this call implement VoiceMediaProvider?" rather
 * than asking "is this specifically an AsteriskAriAdapter?". That
 * distinction is the whole point — a cellular call and a SIP-trunk call
 * should be equally capable of carrying live AI audio, since the AI agent
 * never sees which one it's talking through.
 */
export interface VoiceMediaProvider {
  /**
   * Bridges callId's audio to an external RTP endpoint at `externalHost`
   * ("host:port" — typically the Media Engine's UDP listener). Returns
   * whatever handle is needed to tear the bridge down again.
   */
  startMediaBridge(callId: string, externalHost: string, format?: string): Promise<MediaBridgeHandle>;

  /** Tears down a bridge previously created by startMediaBridge(). */
  stopMediaBridge(handle: MediaBridgeHandle): Promise<void>;
}

export interface MediaBridgeHandle {
  bridgeId: string;
  externalChannelId: string;
}

/** Narrow runtime check — safe to call on any object, no import cycle risk. */
export function supportsVoiceMedia(x: unknown): x is VoiceMediaProvider {
  return (
    !!x &&
    typeof (x as any).startMediaBridge === "function" &&
    typeof (x as any).stopMediaBridge === "function"
  );
}
