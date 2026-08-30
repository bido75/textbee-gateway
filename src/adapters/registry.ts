import { CommunicationAdapter, ProviderId } from "../core/types.js";
import { StubAdapter } from "./stub-adapter.js";
import { TextBeeAdapter } from "./textbee-adapter.js";
import { AsteriskAriAdapter } from "./asterisk-ari-adapter.js";
import { WhatsAppAdapter } from "./whatsapp-adapter.js";
import { LiveKitAdapter } from "./livekit-adapter.js";

/**
 * Central place new adapters get plugged into the system. Adding a new
 * provider (Twilio, WhatsApp, LiveKit, Matrix, ...) means writing one class
 * that implements CommunicationAdapter and registering its "type" string
 * here — nothing else in the codebase (MCP tools, session manager, routing)
 * needs to change.
 */
export function createAdapter(type: string, id: ProviderId): CommunicationAdapter {
  switch (type) {
    case "stub":
      return new StubAdapter(id);
    case "textbee":
      return new TextBeeAdapter(id);
    case "asterisk-ari":
      return new AsteriskAriAdapter(id);
    case "whatsapp":
      return new WhatsAppAdapter(id);
    case "livekit":
      return new LiveKitAdapter(id);
    default:
      throw new Error(`Unknown adapter type "${type}". Add a case in adapters/registry.ts.`);
  }
}
