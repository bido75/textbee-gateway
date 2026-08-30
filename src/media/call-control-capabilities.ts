import { Endpoint } from "../core/types.js";

/**
 * Same pattern as VoiceMediaProvider: a capability, not a provider type.
 * `CellularVoiceProvider` intentionally only requires dial/answer/hangup/
 * getStatus (see cellular/types.ts) — not every voice backend can hold,
 * mute, transfer, or send DTMF (a hardware GSM gateway, for instance, might
 * not support all of these). Rather than stuff optional methods into
 * `CellularVoiceProvider` itself (which would make every implementer
 * pretend to support things it doesn't), each capability is its own
 * interface with its own type guard. The MCP layer asks "can this call's
 * provider do X?" rather than assuming yes.
 */

export interface HoldCapability {
  setHold(callId: string, on: boolean): Promise<void>;
}

export interface MuteCapability {
  setMute(callId: string, on: boolean): Promise<void>;
}

export interface TransferCapability {
  transferCall(callId: string, to: Endpoint): Promise<void>;
}

export interface DtmfCapability {
  sendDtmfDigits(callId: string, digits: string): Promise<void>;
}

export function supportsHold(x: unknown): x is HoldCapability {
  return !!x && typeof (x as any).setHold === "function";
}

export function supportsMute(x: unknown): x is MuteCapability {
  return !!x && typeof (x as any).setMute === "function";
}

export function supportsTransfer(x: unknown): x is TransferCapability {
  return !!x && typeof (x as any).transferCall === "function";
}

export function supportsDtmf(x: unknown): x is DtmfCapability {
  return !!x && typeof (x as any).sendDtmfDigits === "function";
}
