import { RealtimeVoiceProvider } from "./realtime-provider.js";
import { StubRealtimeVoiceProvider } from "./stub-realtime-provider.js";
import { OpenAIRealtimeVoiceProvider } from "./openai-realtime-provider.js";

export function createRealtimeVoiceProvider(type: string): RealtimeVoiceProvider {
  switch (type) {
    case "stub":
      return new StubRealtimeVoiceProvider();
    case "openai":
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('createRealtimeVoiceProvider("openai") requires OPENAI_API_KEY to be set');
      }
      return new OpenAIRealtimeVoiceProvider({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_REALTIME_MODEL,
        voice: process.env.OPENAI_REALTIME_VOICE,
      });
    default:
      throw new Error(`Unknown realtime voice provider type "${type}"`);
  }
}
