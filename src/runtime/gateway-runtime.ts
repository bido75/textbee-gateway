import { loadConfig } from "../config/load-config.js";
import { createAdapter } from "../adapters/registry.js";
import { SessionManager } from "../core/session-manager.js";
import { createPersistenceStore } from "../persistence/registry.js";
import { CellularEndpointRegistry } from "../cellular/endpoint-registry.js";
import { createCellularVoiceProvider } from "../cellular/registry.js";
import { ConversationService } from "../core/conversation-service.js";
import { MediaEngine } from "../media/media-engine.js";
import { CommunicationApplicationService } from "../application/communication-application-service.js";

export async function createGatewayRuntime(configPath = process.env.GATEWAY_CONFIG_PATH ?? "./src/config/config.dev.yaml") {
  const config = loadConfig(configPath);
  const store = createPersistenceStore(config.persistence);
  const manager = await SessionManager.fromConfig(config, createAdapter, store);
  const endpoints = await CellularEndpointRegistry.fromConfig(
    config.cellularEndpoints ?? [], config.cellularVoiceProviders ?? [],
    createCellularVoiceProvider, manager, store,
  );
  const conversations = new ConversationService(store, endpoints);
  conversations.attachAutoRecording(manager);
  const media = new MediaEngine({ localHost: process.env.MEDIA_ENGINE_HOST ?? "127.0.0.1" });
  const application = new CommunicationApplicationService(
    manager, endpoints, conversations, media, process.env.DEFAULT_VOICE_PROVIDER ?? "stub",
  );
  return {
    config, mode: config.runtimeMode, store, manager, endpoints, conversations, media, application,
    async readiness() {
      const persistence = await store.healthCheck();
      const endpointStates = await Promise.all(endpoints.list().map((endpoint) => endpoints.getStatus(endpoint.id)));
      const offline = endpointStates.filter((state) => state.overall === "offline");
      return {
        ready: persistence.ok && offline.length === 0,
        degraded: endpointStates.some((state) => state.overall === "degraded"),
        persistence,
        endpoints: endpointStates,
      };
    },
    async shutdown() { await application.shutdown(); await endpoints.shutdown(); await manager.shutdown(); },
  };
}
