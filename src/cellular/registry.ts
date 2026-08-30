import { CellularVoiceProvider } from "./types.js";
import { StubCellularVoiceProvider } from "./stub-cellular-voice-provider.js";
import { AsteriskChanMobileProvider } from "./asterisk-chan-mobile-provider.js";

/**
 * Registry for CellularVoiceProvider backends. Placeholders for future
 * backends are listed here (not implemented) so the registry shape doesn't
 * need to change when they're added:
 *
 *   - "android-sip"   — rooted Android + PJSIP, direct SIP/RTP, no Bluetooth
 *                        range/device-count limits. Research spike, not yet built.
 *   - "hardware-gateway" — GoIP/Yeastar-style LTE↔SIP appliances for production
 *                        multi-line deployments. Not yet built.
 *   - "sip-carrier"   — a plain wholesale SIP trunk (already covered by the
 *                        existing AsteriskAriAdapter for non-cellular voice).
 */
export function createCellularVoiceProvider(type: string, id: string): CellularVoiceProvider {
  switch (type) {
    case "stub":
      return new StubCellularVoiceProvider(id);
    case "asterisk-chan-mobile":
      return new AsteriskChanMobileProvider(id);
    default:
      throw new Error(
        `Unknown cellular voice provider type "${type}". Add a case in cellular/registry.ts.`
      );
  }
}
