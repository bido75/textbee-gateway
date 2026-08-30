#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config/load-config.js";
import { createAdapter } from "../adapters/registry.js";
import { SessionManager } from "../core/session-manager.js";
import { AdapterEvent, Endpoint, ProviderId } from "../core/types.js";
import { startTextBeeWebhookServer } from "../gateways/textbee-webhook-server.js";
import { MediaEngine } from "../media/media-engine.js";
import { createRealtimeVoiceProvider } from "../media/realtime-registry.js";
import { createPersistenceStore } from "../persistence/registry.js";
import { LiveKitAdapter } from "../adapters/livekit-adapter.js";
import { startLiveKitWebhookServer } from "../gateways/livekit-webhook-server.js";
import { CellularEndpointRegistry } from "../cellular/endpoint-registry.js";
import { createCellularVoiceProvider } from "../cellular/registry.js";
import { ConversationService } from "../core/conversation-service.js";
import { supportsVoiceMedia } from "../media/voice-media-provider.js";
import { supportsHold, supportsMute, supportsTransfer, supportsDtmf } from "../media/call-control-capabilities.js";

const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH ?? "./src/config/config.example.yaml";
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 8787);
const MEDIA_ENGINE_HOST = process.env.MEDIA_ENGINE_HOST ?? "127.0.0.1";
const DEFAULT_VOICE_PROVIDER = process.env.DEFAULT_VOICE_PROVIDER ?? "stub";

// Ring buffer of recent inbound events (incoming calls, incoming SMS, DTMF,
// hangups...) so the AI agent can poll for them via the `get_events` tool.
// This works regardless of whether the MCP host supports server->client
// notifications.
const EVENT_BUFFER_SIZE = 200;
const eventLog: Array<AdapterEvent & { provider: ProviderId; receivedAt: string }> = [];

function pushEvent(e: AdapterEvent & { provider: ProviderId }) {
  eventLog.push({ ...e, receivedAt: new Date().toISOString() });
  if (eventLog.length > EVENT_BUFFER_SIZE) eventLog.shift();
}

function endpointOf(address: string, label?: string): Endpoint {
  return label ? { address, label } : { address };
}

async function main() {
  const config = loadConfig(CONFIG_PATH);
  const store = createPersistenceStore(config.persistence);
  const manager = await SessionManager.fromConfig(config, createAdapter, store);
  manager.onEvent(pushEvent);

  // Inbound SMS/MMS webhook (TextBee Android app -> here) shares this same
  // manager/adapter instances, so a text that arrives shows up immediately
  // via the get_events tool.
  if (config.providers.some((p) => p.type === "textbee")) {
    startTextBeeWebhookServer(manager, WEBHOOK_PORT);
  }
  if (config.providers.some((p) => p.type === "livekit")) {
    startLiveKitWebhookServer(manager, Number(process.env.LIVEKIT_WEBHOOK_PORT ?? 8789));
  }

  // Media Engine: bridges live call audio (RTP, via Asterisk ARI
  // externalMedia) to a realtime voice model. One instance serves every
  // concurrent call; sessions are tracked by call_id below.
  const mediaEngine = new MediaEngine({ localHost: MEDIA_ENGINE_HOST });
  const activeBridges = new Map<string, { bridgeId: string; externalChannelId: string }>();

  // Cellular endpoints: binds each physical SIM (messaging provider + voice
  // provider) under one logical identity, and lets an AI agent see SMS +
  // voice history for the same phone number as a single conversation.
  const cellularRegistry = await CellularEndpointRegistry.fromConfig(
    config.cellularEndpoints ?? [],
    config.cellularVoiceProviders ?? [],
    createCellularVoiceProvider,
    manager,
    store
  );
  const conversationService = new ConversationService(store, cellularRegistry);
  conversationService.attachAutoRecording(manager);

  /**
   * ContextBuilder step: before a realtime voice session starts, look up
   * whether this call belongs to a CellularEndpoint, and if so, pull that
   * endpoint's prior conversation with this call's counterpart (SMS +
   * earlier call transcripts) and prepend it to the realtime model's
   * instructions. This is what makes "the AI already knows about the text
   * you sent five minutes ago" actually happen, instead of every channel
   * starting with a blank slate.
   */
  async function buildContextInstructions(call: { provider: string; from: Endpoint; to: Endpoint; direction: string }, explicitInstructions?: string): Promise<string> {
    const baseInstructions =
      explicitInstructions ?? "You are a helpful voice assistant speaking with someone on a phone call.";

    const endpoint = cellularRegistry.findEndpointByProvider(call.provider);
    if (!endpoint) return baseInstructions;

    const counterpart = call.direction === "outbound" ? call.to.address : call.from.address;
    const conversation = await conversationService.getConversation(endpoint.id, counterpart, 20);
    const contextBlock = conversationService.formatConversationAsContext(conversation);

    return contextBlock ? `${contextBlock}\n\n${baseInstructions}` : baseInstructions;
  }

  const server = new Server(
    { name: "ai-comms-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "make_call",
        description:
          "Place an outbound call. Either give 'from' (a cellular endpoint id, e.g. a phone's " +
          "logical identity bound to a voice provider) to call through that specific SIM/line, " +
          "or omit it to route through the default voice provider for the destination.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Destination phone number (E.164) or SIP URI" },
            from: { type: "string", description: "Optional: a cellular endpoint id (see list_endpoints) to call through that specific line" },
            provider_id: { type: "string", description: "Optional: force a specific low-level provider id (advanced/legacy — prefer 'from')" },
          },
          required: ["to"],
        },
      },
      {
        name: "dial",
        description: "Deprecated alias for make_call — kept for backward compatibility. Prefer make_call.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Destination phone number (E.164) or SIP URI" },
            from: { type: "string", description: "Optional: a cellular endpoint id" },
            provider_id: { type: "string", description: "Optional: force a specific provider id" },
          },
          required: ["to"],
        },
      },
      {
        name: "answer_call",
        description: "Answer a ringing inbound call.",
        inputSchema: {
          type: "object",
          properties: { call_id: { type: "string" } },
          required: ["call_id"],
        },
      },
      {
        name: "hangup_call",
        description: "End an active call.",
        inputSchema: {
          type: "object",
          properties: { call_id: { type: "string" } },
          required: ["call_id"],
        },
      },
      {
        name: "hold_call",
        description: "Put a call on hold, or take it off hold.",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            on: { type: "boolean", description: "true to hold, false to resume" },
          },
          required: ["call_id", "on"],
        },
      },
      {
        name: "mute_call",
        description: "Mute or unmute a call.",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            on: { type: "boolean" },
          },
          required: ["call_id", "on"],
        },
      },
      {
        name: "transfer_call",
        description: "Transfer an active call to another number/SIP address.",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            to: { type: "string" },
          },
          required: ["call_id", "to"],
        },
      },
      {
        name: "send_dtmf",
        description: "Send DTMF tones on an active call (e.g. to navigate an IVR menu).",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            digits: { type: "string", description: "e.g. \"1234#\"" },
          },
          required: ["call_id", "digits"],
        },
      },
      {
        name: "list_calls",
        description: "List all known calls (active and recently ended) and their state.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "start_voice_session",
        description:
          "Bridge a live call's audio to a realtime voice model, so the AI agent can actually " +
          "converse through the call (not just control it). Only works for calls on a voice " +
          "provider that supports media bridging (the self-hosted Asterisk PBX adapter).",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            voice_provider: {
              type: "string",
              description: 'Which realtime voice model to use, e.g. "openai" or "stub". Defaults to the configured default.',
            },
            instructions: {
              type: "string",
              description: "System instructions for how the AI should behave/speak on this call.",
            },
          },
          required: ["call_id"],
        },
      },
      {
        name: "stop_voice_session",
        description: "Detach the realtime voice model from a call, ending the audio bridge (the call itself keeps running unless you also hang it up).",
        inputSchema: {
          type: "object",
          properties: { call_id: { type: "string" } },
          required: ["call_id"],
        },
      },
      {
        name: "get_livekit_join_token",
        description:
          "For calls placed on a LiveKit provider: mints a short-lived access token a WebRTC " +
          "client can use to join the call's room. LiveKit calls have no server-side 'answer' " +
          "action — the callee's app/browser joins using this token.",
        inputSchema: {
          type: "object",
          properties: {
            call_id: { type: "string" },
            identity: { type: "string", description: "Unique participant identity for the joining client" },
            name: { type: "string", description: "Optional display name" },
          },
          required: ["call_id", "identity"],
        },
      },
      {
        name: "send_message",
        description:
          "Send an SMS (or MMS, if media_urls is provided) to a phone number. Either give 'from' " +
          "(a cellular endpoint id, e.g. a phone's logical identity) to send through that specific " +
          "SIM's messaging provider, or omit it to route through the default provider for the destination.",
        inputSchema: {
          type: "object",
          properties: {
            to: { type: "string", description: "Destination phone number (E.164)" },
            body: { type: "string" },
            from: { type: "string", description: "Optional: a cellular endpoint id (see list_endpoints) to send through that specific line" },
            media_urls: {
              type: "array",
              items: { type: "string" },
              description: "Optional media URLs to send as MMS",
            },
            provider_id: { type: "string", description: "Optional: force a specific low-level provider id (advanced/legacy — prefer 'from')" },
          },
          required: ["to", "body"],
        },
      },
      {
        name: "list_messages",
        description: "List all known SMS/MMS messages sent or received so far.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "list_endpoints",
        description:
          "List configured cellular endpoints — logical phone lines/SIMs, each with its own " +
          "phone number and SMS/MMS + voice capabilities, regardless of which provider backs them.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_endpoint_status",
        description: "Get online/health status for a cellular endpoint's messaging and voice channels.",
        inputSchema: {
          type: "object",
          properties: { endpoint_id: { type: "string" } },
          required: ["endpoint_id"],
        },
      },
      {
        name: "get_conversation",
        description:
          "Get the merged SMS/MMS + voice call history between a cellular endpoint and one " +
          "counterpart phone number, sorted by time — so an agent can know about an earlier " +
          "text when a call comes in from the same person, and vice versa.",
        inputSchema: {
          type: "object",
          properties: {
            endpoint_id: { type: "string" },
            counterpart: { type: "string", description: "The other party's phone number (E.164)" },
            limit: { type: "number", description: "Max events to return (default 50)" },
          },
          required: ["endpoint_id", "counterpart"],
        },
      },
      {
        name: "get_events",
        description:
          "Poll for recent inbound events: incoming calls, incoming SMS/MMS, DTMF presses, " +
          "call state changes, and hangups. Call this periodically to notice new activity.",
        inputSchema: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description: "ISO timestamp; only return events received after this time",
            },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params as { name: string; arguments: any };

    try {
      switch (name) {
        case "make_call":
        case "dial": {
          let session;
          if (args.from) {
            // Route through a specific cellular endpoint's voice provider
            // (e.g. the Asterisk chan_mobile line for that SIM), tracked in
            // the shared SessionManager the same way manager.dial() does.
            session = await cellularRegistry.makeCall(args.from, args.to);
            await manager.trackExternalCall(session);
          } else {
            session = await manager.dial(endpointOf(args.to), { providerId: args.provider_id });
          }
          // Record the outbound call as a conversation turn (no-ops if this
          // provider isn't tied to any CellularEndpoint). Inbound calls are
          // recorded automatically via ConversationService.attachAutoRecording.
          await conversationService.recordCallTurn(session.provider, session, "outbound");
          return textResult(
            `Dialing ${args.to} via ${session.provider}. call_id=${session.id}, state=${session.state}`
          );
        }

        case "answer_call": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            await cellularVoiceProvider.answer(args.call_id);
          } else {
            await manager.answer(args.call_id);
          }
          return textResult(`Answered call ${args.call_id}.`);
        }

        case "hangup_call": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            await cellularVoiceProvider.hangup(args.call_id);
          } else {
            await manager.hangup(args.call_id);
          }
          return textResult(`Hung up call ${args.call_id}.`);
        }

        case "hold_call": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            if (!supportsHold(cellularVoiceProvider)) {
              throw new Error(`Cellular voice provider "${call?.provider}" does not support hold()`);
            }
            await cellularVoiceProvider.setHold(args.call_id, args.on);
          } else {
            await manager.hold(args.call_id, args.on);
          }
          return textResult(`Call ${args.call_id} ${args.on ? "placed on hold" : "resumed"}.`);
        }

        case "mute_call": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            if (!supportsMute(cellularVoiceProvider)) {
              throw new Error(`Cellular voice provider "${call?.provider}" does not support mute()`);
            }
            await cellularVoiceProvider.setMute(args.call_id, args.on);
          } else {
            await manager.mute(args.call_id, args.on);
          }
          return textResult(`Call ${args.call_id} ${args.on ? "muted" : "unmuted"}.`);
        }

        case "transfer_call": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            if (!supportsTransfer(cellularVoiceProvider)) {
              throw new Error(`Cellular voice provider "${call?.provider}" does not support transfer()`);
            }
            await cellularVoiceProvider.transferCall(args.call_id, endpointOf(args.to));
          } else {
            await manager.transfer(args.call_id, endpointOf(args.to));
          }
          return textResult(`Call ${args.call_id} transferred to ${args.to}.`);
        }

        case "send_dtmf": {
          const call = manager.getCall(args.call_id);
          const cellularVoiceProvider = call ? cellularRegistry.getVoiceProviderById(call.provider) : undefined;
          if (cellularVoiceProvider) {
            if (!supportsDtmf(cellularVoiceProvider)) {
              throw new Error(`Cellular voice provider "${call?.provider}" does not support send_dtmf()`);
            }
            await cellularVoiceProvider.sendDtmfDigits(args.call_id, args.digits);
          } else {
            await manager.sendDtmf(args.call_id, args.digits);
          }
          return textResult(`Sent DTMF "${args.digits}" on call ${args.call_id}.`);
        }

        case "list_calls": {
          const calls = manager.listCalls();
          return textResult(JSON.stringify(calls, null, 2));
        }

        case "start_voice_session": {
          const call = manager.getCall(args.call_id);
          if (!call) throw new Error(`Unknown call ${args.call_id}`);

          // Resolve whatever actually produced this call — a regular
          // CommunicationAdapter (e.g. AsteriskAriAdapter) or a
          // CellularVoiceProvider (e.g. AsteriskChanMobileProvider) — and
          // check the CAPABILITY (VoiceMediaProvider), not the concrete
          // class. A cellular call and a SIP-trunk call are equally
          // capable of carrying live AI audio; the AI agent never sees
          // which one it's talking through, and this check shouldn't
          // either.
          const provider = manager.getAdapter(call.provider) ?? cellularRegistry.getVoiceProviderById(call.provider);
          if (!supportsVoiceMedia(provider)) {
            throw new Error(
              `Voice sessions require a provider that supports media bridging (call is on "${call.provider}", which doesn't)`
            );
          }
          if (mediaEngine.isActive(args.call_id)) {
            throw new Error(`Voice session already active for call ${args.call_id}`);
          }

          // Pull prior context for this call's counterpart before the
          // realtime session starts, so an earlier SMS thread (or an
          // earlier call's transcript) informs the AI from the first turn
          // — this is what makes "the AI already knows about the text you
          // sent five minutes ago" actually happen, rather than each
          // channel starting with a blank slate.
          const contextInstructions = await buildContextInstructions(call, args.instructions);

          const realtimeProvider = createRealtimeVoiceProvider(args.voice_provider ?? DEFAULT_VOICE_PROVIDER);
          realtimeProvider.onTranscript?.((text, role) => {
            conversationService.recordTranscriptTurn(args.call_id, role, text);
          });

          const { host, port } = await mediaEngine.startSession(args.call_id, realtimeProvider, {
            instructions: contextInstructions,
          });

          const bridge = await provider.startMediaBridge(args.call_id, `${host}:${port}`);
          activeBridges.set(args.call_id, bridge);

          return textResult(
            `Voice session started on call ${args.call_id} using "${args.voice_provider ?? DEFAULT_VOICE_PROVIDER}". ` +
              `You can now speak/listen through the call.`
          );
        }

        case "stop_voice_session": {
          const call = manager.getCall(args.call_id);
          const bridge = activeBridges.get(args.call_id);
          await mediaEngine.stopSession(args.call_id);
          if (bridge && call) {
            const provider = manager.getAdapter(call.provider) ?? cellularRegistry.getVoiceProviderById(call.provider);
            if (supportsVoiceMedia(provider)) {
              await provider.stopMediaBridge(bridge);
            }
          }
          activeBridges.delete(args.call_id);
          return textResult(`Voice session stopped for call ${args.call_id}.`);
        }

        case "get_livekit_join_token": {
          const call = manager.getCall(args.call_id);
          if (!call) throw new Error(`Unknown call ${args.call_id}`);
          const adapter = manager.getAdapter(call.provider);
          if (!(adapter instanceof LiveKitAdapter)) {
            throw new Error(`Call ${args.call_id} is not on a LiveKit provider`);
          }
          const token = await adapter.getJoinToken(args.call_id, args.identity, args.name);
          return textResult(token);
        }

        case "send_message": {
          let record;
          if (args.from) {
            record = await cellularRegistry.sendMessage(args.from, endpointOf(args.to), args.body, {
              mediaUrls: args.media_urls,
            });
          } else {
            record = await manager.sendMessage(endpointOf(args.to), args.body, {
              providerId: args.provider_id,
              mediaUrls: args.media_urls,
            });
          }
          // Record the outbound message as a conversation turn (no-ops if
          // this provider isn't tied to any CellularEndpoint). Inbound
          // messages are recorded automatically via attachAutoRecording.
          await conversationService.recordMessageTurn(record.provider, record);
          return textResult(
            `${record.kind.toUpperCase()} sent to ${args.to} via ${record.provider}. message_id=${record.id}, status=${record.status}`
          );
        }

        case "list_messages": {
          const messages = manager.listMessages();
          return textResult(JSON.stringify(messages, null, 2));
        }

        case "list_endpoints": {
          return textResult(JSON.stringify(cellularRegistry.list(), null, 2));
        }

        case "get_endpoint_status": {
          const status = await cellularRegistry.getStatus(args.endpoint_id);
          return textResult(JSON.stringify(status, null, 2));
        }

        case "get_conversation": {
          const conversation = await conversationService.getConversation(
            args.endpoint_id,
            args.counterpart,
            args.limit ?? 50
          );
          return textResult(JSON.stringify(conversation, null, 2));
        }

        case "get_events": {
          const since = args?.since ? new Date(args.since).getTime() : 0;
          const events = eventLog.filter((e) => new Date(e.receivedAt).getTime() > since);
          return textResult(JSON.stringify(events, null, 2));
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error?.message ?? String(error)}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[ai-comms-gateway] MCP server started. Providers: ${config.providers
      .map((p) => `${p.id}(${p.type})`)
      .join(", ")}\n`
  );
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

main().catch((err) => {
  process.stderr.write(`[ai-comms-gateway] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
