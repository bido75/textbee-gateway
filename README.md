# AI Communications Gateway

## Self-hosted TextBee delivery pipeline

This fork publishes the gateway, TextBee API, dashboard, and a customized Android APK from GitHub Actions. The Android build is compiled against `https://textbee-api.giscop.com/api/v1/`; it must not be replaced with the upstream APK, which targets TextBee's hosted API.

- Every pull request runs gateway, API, and dashboard validation.
- Changes on `main` publish container images under `ghcr.io/bido75/textbee-gateway`.
- Android changes build an installable artifact and update the `android-latest` prerelease. The self-hosted dashboard `/download` page reads releases from this repository.
- The repository secret `TEXTBEE_ANDROID_GOOGLE_SERVICES_B64` contains the base64-encoded Firebase Android `google-services.json`. Credentials and signing material are excluded by `.gitignore`.

Self-hosted deployments do not require paid subscriptions or Polar. `TEXTBEE_SELF_HOSTED=true` creates an idempotent unlimited `free` plan at API startup because TextBee's device and messaging limits still depend on a plan record.

## Docker Desktop development edge (mock validated)

The repository includes a complete local development topology for Windows Docker Desktop: gateway REST service, stdio MCP implementation, PostgreSQL, Redis, Asterisk 20/ARI, a mock TextBee service, simulated cellular calls through real Asterisk ARI Local channels, and ARI ExternalMedia/RTP media-engine bridging.

```powershell
npm ci
npm run build
npm test
docker compose -f docker-compose.dev.yml up -d --build
npm run test:e2e:docker
```

Only `127.0.0.1:8080` is published. Authenticate REST calls with `Authorization: Bearer dev-local-key`. See [`docs/DEVELOPMENT_STACK.md`](docs/DEVELOPMENT_STACK.md) for routes and operation.

**Validation boundary:** this profile validates the software architecture and Asterisk ARI/ExternalMedia control path. It does not validate real Bluetooth HFP, `chan_mobile`, Android, SIM/carrier behavior, or physical two-way cellular audio. Perform that gate on a native Linux host using [`docs/runbooks/bluetooth-edge.md`](docs/runbooks/bluetooth-edge.md).

A universal, provider-agnostic communications layer for AI agents. The AI never
talks to Twilio, TextBee, or Asterisk directly — it calls MCP tools like
`dial`, `send_message`, `answer_call`. A routing config decides which adapter
actually handles each request, so you can swap providers without touching any
AI-facing code — the same pattern as a database driver.

```
AI Agent
   │  MCP tools: dial / answer_call / hangup_call / send_message / ...
   ▼
Communication Core (SessionManager) ── routing.yaml decides provider per channel
   │
   ├── AsteriskAriAdapter ──▶ Kamailio ──▶ Asterisk ──▶ RTPengine ──▶ wholesale SIP trunk ──▶ PSTN
   ├── TextBeeAdapter ──▶ TextBee cloud API ──▶ your Android phone ──▶ carrier SMS/MMS
   └── StubAdapter (in-memory, for development/testing — no external deps)
```

**Building a new provider integration?** See **[`PROVIDER_SDK.md`](./PROVIDER_SDK.md)**
for the plugin interface contract, lifecycle, a copy-paste template
(`src/adapters/_template-adapter.ts`), and two real adapters proven
end-to-end against protocol-accurate mocks in `examples/`.

## What's implemented here (working code, not just design)

1. **`src/core/types.ts`** — the `CommunicationAdapter` interface every
   provider implements: `dial`, `answer`, `hangup`, `hold`, `mute`,
   `transfer`, `sendDtmf`, `record`, `sendMessage`. This is the contract that
   makes providers swappable.
2. **`src/core/session-manager.ts`** — the Communication Core: holds all
   configured adapters, applies routing rules, tracks live call/message
   state, fans out inbound events.
3. **`src/mcp/server.ts`** — the MCP server. Exposes `dial`, `answer_call`,
   `hangup_call`, `hold_call`, `mute_call`, `transfer_call`, `send_dtmf`,
   `list_calls`, `send_message`, `list_messages`, `get_events`,
   `start_voice_session`, and `stop_voice_session` (a polling tool so
   inbound calls/texts are visible even on MCP hosts that don't support
   server→client notifications).
4. **Adapters:**
   - `stub-adapter.ts` — fully in-memory fake provider, used to validate the
     contract with zero external dependencies (see "Try it" below).
   - `textbee-adapter.ts` — real SMS/MMS via [TextBee](https://textbee.dev)
     (an Android phone + your existing carrier plan as the SMS gateway).
     Uses TextBee's current `POST /gateway/send-sms` endpoint (the older
     path-based endpoint was deprecated upstream), verifies inbound webhook
     deliveries via HMAC-SHA256 (`X-Signature`), and de-duplicates retried
     webhook deliveries by `smsId`. Proven end-to-end against a
     protocol-accurate mock — see `PROVIDER_SDK.md`.
   - `asterisk-ari-adapter.ts` — real call control against a self-hosted
     Asterisk PBX over the Asterisk REST Interface (ARI), for voice. Also
     bridges calls to the Media Engine via ARI's `externalMedia` channels.
     Proven end-to-end against a mock ARI server — see `PROVIDER_SDK.md`.
5. **`src/media/`** — the Media Engine: the bidirectional audio bridge that
   turns "the call connects" into "you can actually talk through it".
   - `rtp-codec.ts` — minimal RTP packetizer/depacketizer for G.711 u-law
     (unit-tested: header round-trip, sequence-number wraparound, 20ms frame
     chunking).
   - `media-engine.ts` — binds a UDP socket per call, depacketizes inbound
     RTP into raw u-law and feeds it to a `RealtimeVoiceProvider`, then
     paces the provider's audio replies back out as correctly-timed RTP
     packets (20ms/160-byte frames) so playback doesn't sound rushed or
     choppy. Learns Asterisk's real source address via symmetric RTP on the
     first received packet.
   - `realtime-provider.ts` / `realtime-registry.ts` — the pluggable
     interface for the "AI brain" side of a call: `openai` (OpenAI Realtime
     API, using `g711_ulaw` directly so no transcoding is needed) or `stub`
     (echoes audio back, zero external calls — used to validate the RTP
     bridge itself; see "Try it" below).
6. **`src/gateways/textbee-webhook-server.ts`** — HTTP server (runs in the
   same process as the MCP server, sharing the same SessionManager) that
   receives TextBee's inbound-SMS webhook and turns it into a `message.incoming`
   event the AI can see via `get_events`.
7. **`docker/`** — a self-hosted PBX core: Kamailio (SIP edge/SBC/registrar),
   Asterisk (call logic + ARI), RTPengine (media relay). All free/open-source;
   the only recurring cost is a wholesale SIP trunk from a carrier of your
   choice (VoIP.ms, Telnyx, BulkVS, Flowroute, ...).
8. **`src/persistence/`** — durable storage + a cross-process event bus,
   same "swap the implementation" pattern as the adapters:
   - `memory-store.ts` — default, zero external dependencies, lost on restart.
   - `postgres-store.ts` — durable call/message history (real schema,
     upserts on state changes).
   - `redis-store.ts` — pub/sub event bus so more than one gateway process
     (e.g. the MCP server and a separately-scaled webhook handler) see the
     same inbound events the instant they happen.
   - `composite-store.ts` (`postgres+redis`) — the recommended production
     setup: Postgres for the system of record, Redis for live fan-out.
9. **`whatsapp-adapter.ts`** — free, self-hosted WhatsApp messaging via
   [Baileys](https://github.com/WhiskeySockets/Baileys) (the WhatsApp Web
   multi-device protocol — no Meta Business API account or per-message fee).
   Capabilities are `chat` only: WhatsApp *voice calls* are not supported by
   this adapter (see the file's doc comment for why) — route `voice` to the
   Asterisk or LiveKit adapter instead.
10. **`livekit-adapter.ts`** — self-hosted WebRTC voice via
    [LiveKit](https://github.com/livekit/livekit). This is the "app-to-app"
    calling path (a WebRTC client you control), not PSTN dialing. Includes a
    webhook receiver (`livekit-webhook-server.ts`) for room/participant
    lifecycle events, and a `get_livekit_join_token` MCP tool since — unlike
    a phone call — there's no server-side "answer": the callee's WebRTC
    client joins the room using a minted access token.
11. **`src/cellular/`** — the `CellularEndpoint` architecture: "one Android +
    one SIM" as a single logical identity, rather than two unrelated
    provider integrations that happen to share a phone. See its own section
    below.

## Try it right now (no phone, no PBX, no external accounts)

```bash
npm install
npm run build
npm run test:stub
```

This starts the MCP server wired entirely to `StubAdapter` — every `dial` and
`send_message` call works, calls transition dialing → ringing → in-progress
on their own, and every outbound SMS gets an automatic "echo" reply — so you
can validate the full tool contract, and point any MCP client at it
(`GATEWAY_CONFIG_PATH=./src/config/config.stub.yaml node dist/mcp/server.js`),
before wiring up real providers.

## Wire up TextBee (real SMS/MMS)

1. Install the TextBee app on a spare Android phone with an active SIM.
2. Get your API key + device ID from the TextBee dashboard.
3. Put them in `.env` (copy `.env.example`) as `TEXTBEE_API_KEY` /
   `TEXTBEE_DEVICE_ID`.
4. In the TextBee app, set the inbound webhook URL to
   `http://<your-server>:8787/webhooks/textbee/textbee-home-phone`.
5. Use `src/config/config.example.yaml` (already routes `sms`/`mms` to
   `textbee-home-phone`) and run `npm start`.

## Talk through a call (the Media Engine)

Once a call is connected (via `dial` or an inbound call answered with
`answer_call`), the AI agent can actually converse through it:

```
start_voice_session(call_id, voice_provider="openai", instructions="...")
```

This bridges the call's audio to a realtime voice model over RTP, using
Asterisk's ARI `externalMedia` channel — no SIP/WebRTC client needed on the
Node side, just raw UDP. Set `OPENAI_API_KEY` in `.env` to use the real
`openai` provider, or use `voice_provider="stub"` (the default) to test the
audio path with zero external API calls — it just echoes the caller's audio
back, which is enough to confirm packets are flowing correctly end to end.

Call `stop_voice_session(call_id)` to detach the model (the call itself
keeps running — follow with `hangup_call` to end it too).

**Tested without a live PBX:** since spinning up real Asterisk isn't always
convenient, `media-engine.ts`'s RTP bridging was verified with a small script
that simulates Asterisk (a UDP peer sending real RTP packets) and confirms
audio round-trips through the engine with correct sequencing/timestamps —
see the "Media Engine" section of this README's development notes, or just
re-run the same pattern yourself against `MediaEngine.startSession()`.

## Wire up the self-hosted PBX (real PSTN voice)

1. Sign up for **one** wholesale SIP trunk (VoIP.ms, Telnyx, BulkVS, Flowroute
   — pick whichever has the best rate for your region). This is the only
   piece of the voice stack that costs money.
2. Fill in `docker/asterisk/pjsip.conf` (`sip-trunk-1*` sections) with your
   trunk's host/username/password, and set a real password in
   `docker/asterisk/ari.conf`.
3. `cd docker && docker compose up -d` — this brings up Kamailio, Asterisk,
   and RTPengine.
4. Set `ARI_PASSWORD` in `.env` to match `ari.conf`, and use the
   `asterisk-ari` provider block in `config.example.yaml`.
5. `npm start` — `dial()` now places real outbound PSTN calls, and inbound
   PSTN calls surface as `call.incoming` events via `get_events`.

## Wire up WhatsApp messaging (free, self-hosted)

1. `npm install` already pulled in `@whiskeysockets/baileys`.
2. Add the `whatsapp-main` provider block from `config.example.yaml` and run
   `npm start`.
3. On first run, a QR code prints to stderr — scan it from your phone's
   WhatsApp under **Linked Devices**. The session persists in `authDir`
   (default `./.whatsapp-session`), so you only do this once.
4. `send_message` now routes `chat` messages through WhatsApp; incoming
   WhatsApp messages surface via `get_events`.

**Not supported:** WhatsApp *voice calls*. Baileys doesn't expose WhatsApp's
call media protocol, so this adapter only claims `chat` capability — `dial()`
against a WhatsApp destination will simply fail rather than silently doing
nothing. Route `voice` to Asterisk or LiveKit instead.

## Wire up LiveKit (self-hosted WebRTC calling, app-to-app)

1. Run a LiveKit server (`docker run livekit/livekit-server`, or use LiveKit
   Cloud) and get its URL + API key/secret.
2. Add the `livekit-webrtc` provider block from `config.example.yaml`,
   fill in `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `.env`.
3. Configure your LiveKit project's webhook URL to
   `http://<your-server>:8789/webhooks/livekit/livekit-webrtc`.
4. `dial()` on this provider creates a room and returns a call; call
   `get_livekit_join_token(call_id, identity)` to mint a token for whichever
   WebRTC client (your own app) should join it — there's no phone number
   dialing here, and no server-side "answer": the callee's client joins the
   room directly using that token.

This is the "app-to-app" voice path from the original architecture sketch —
useful for calling a client you control (e.g. a companion mobile app), not
for reaching PSTN phone numbers (use the Asterisk adapter for that, or
LiveKit's own SIP bridge if you want LiveKit to own PSTN too — not wired up
here).

## Add durable storage (Postgres + Redis)

By default the gateway keeps call/message history in memory only — fine for
development, but state vanishes on restart and can't be shared across
multiple gateway processes. To fix both:

```bash
# apt install postgresql redis-server   (or use existing/managed instances)
createdb ai_comms_gateway
```

Add a `persistence:` block to your config (see `config.example.yaml`):

```yaml
persistence:
  type: postgres+redis
  config:
    postgresUrl: "${POSTGRES_URL}"
    redisUrl: "${REDIS_URL}"
```

Postgres holds the durable call/message log (schema auto-created on first
run); Redis carries the live event bus so, e.g., a webhook-handling process
and an MCP-serving process running separately both see an inbound SMS the
instant it arrives. `type: postgres` or `type: redis` alone are also valid
if you only need one half. Verified locally: killing the gateway process
mid-call and starting a fresh one recovers the call's last known state from
Postgres.

## The CellularEndpoint architecture (one SIM, one identity, SMS + voice)

The insight this section implements: a phone's SMS capability and its voice
capability are handled by two completely unrelated providers under the
hood (TextBee for messaging, an Asterisk `chan_mobile`-backed
`CellularVoiceProvider` for voice) — but from an AI agent's perspective,
they should be **one phone number, one identity**, with a shared
conversation history.

```
CellularEndpoint "android-home-01"
  phoneNumber: +13025550123
  messaging.provider -> textbee-home-phone   (TextBee, SMS/MMS)
  voice.provider     -> chan-mobile-android-home-01  (Asterisk chan_mobile, voice)
```

Nothing above this layer — MCP tools, conversation history — ever addresses
"TextBee" or "chan_mobile" directly. New pieces:

- **`cellular/types.ts`** — `CellularEndpointConfig` (the domain object) and
  `CellularVoiceProvider` (a interface deliberately narrower than
  `CommunicationAdapter`: voice only, no `sendMessage` — SMS/MMS always
  goes through TextBee, never through the voice provider, so there's
  exactly one place that owns inbound events, delivery status, and message
  history for an endpoint's texts).
- **`cellular/asterisk-chan-mobile-provider.ts`** — the reference/prototype
  `CellularVoiceProvider` backend, using Asterisk's `chan_mobile` channel
  driver (Bluetooth HFP pairing — no APK, no root, no custom Android code).
  **Honestly documented limitations** (see the file's doc comment): requires
  Bluetooth/BlueZ + the phone in range continuously, narrowband audio,
  generally one Bluetooth adapter per simultaneous phone, `chan_mobile` is
  community-maintained in Asterisk (not core), and — like the WhatsApp/
  LiveKit adapters — this has **not been exercised against real Bluetooth
  hardware** in this environment; it's correct against Asterisk's
  documented ARI/`chan_mobile` mechanics, not a verified integration.
- **`cellular/stub-cellular-voice-provider.ts`** — in-memory fake, same role
  as `stub-adapter.ts`. This is what let the entire architecture below be
  tested end-to-end without any Bluetooth hardware at all.
- **`cellular/endpoint-registry.ts`** (`CellularEndpointRegistry`) — resolves
  each endpoint's `messaging.provider`/`voice.provider` to real instances,
  and forwards voice-provider events into the same `SessionManager` every
  other provider uses (`SessionManager.ingestExternalEvent`), so a cellular
  call shows up in `list_calls`/`get_events` exactly like any other call.
- **`core/conversation-service.ts`** (`ConversationService`) — reads and
  writes the **canonical durable conversation timeline**: every SMS/MMS
  message and every voice transcript turn for an endpoint+counterpart pair
  lands in one ordered `conversation_turns` log (see `persistence/types.ts`
  — `getOrCreateConversation`/`appendConversationTurn`/`listConversationTurns`,
  implemented in Postgres with real tables, in Redis with hashes+lists, and
  in-memory as a fallback). This is what makes the following actually
  survive a restart, not just work within one running process:

  ```
  09:00 SMS   user:      "Check whether project Alpha builds."
  09:02 SMS   assistant: "I'm running it."
  09:10 call  (same number calls in)
  09:10 call  assistant: already knows about the 09:00 SMS
  ```

  A deliberately small first slice of the fuller
  `agents`/`contacts`/`conversations` schema described in the project's
  design notes — full `Contact`/`Agent`/`CommunicationIdentity` modeling is
  a larger lift than this slice, and isn't built here.

**Endpoint configs are persisted too.** `CellularEndpointRegistry` saves
each YAML-declared endpoint's config via `PersistenceStore.saveEndpointConfig()`
at startup — a scoped-down first step toward durable identity relationships
(not the full Agent/Contact schema, which remains future work).

**Call-control capabilities are now generic**, same pattern as
`VoiceMediaProvider`: `HoldCapability`/`MuteCapability`/`TransferCapability`/
`DtmfCapability` (`media/call-control-capabilities.ts`), each with its own
type guard. `hold_call`/`mute_call`/`transfer_call`/`send_dtmf` check
whether a cellular call's provider implements the relevant capability and
give a clear `"does not support X()"` error if not — rather than silently
falling through to the regular adapter path and producing a confusing
`"Unknown provider"` error, which is what an earlier version of this fix
actually did until a test caught it. `AsteriskChanMobileProvider` implements
all four, using the same ARI channel endpoints (`/hold`, `/mute`, `/dtmf`,
`/redirect`) `AsteriskAriAdapter` already used.

**Endpoint health now distinguishes messaging from voice.**
`get_endpoint_status` used to treat "TextBee is configured" as "messaging
available" without checking anything real. It now separately reports
`voice.available` (from the voice provider's own status check) and
`messaging.available` (whether the messaging provider is actually
instantiated and registered — still not a live device heartbeat, but a real
step up from "was it mentioned in YAML"), plus a computed `overall:
"online" | "degraded" | "offline"` — so "SMS works, voice doesn't" is a
distinguishable state instead of the whole line reading as one blob.

**New MCP tools:** `make_call` (the public name going forward; `dial` is
kept as a deprecated alias — both accept an optional `from: <endpoint_id>`
to route through a specific SIM's voice provider instead of the default
routing rule), `send_message` (also now accepts `from: <endpoint_id>` —
symmetric with `make_call`, so an agent addresses one identity for both
channels), `list_endpoints`, `get_endpoint_status`, `get_conversation`.

**Voice media bridging works for cellular calls too.** `start_voice_session`
originally checked `instanceof AsteriskAriAdapter`, which silently locked
cellular calls out of ever carrying live AI audio — a call could be dialed,
answered, and hung up, but never actually talked through. Fixed by
introducing a generic capability instead of a concrete-class check:

- **`media/voice-media-provider.ts`** — `VoiceMediaProvider`, a capability
  interface (`startMediaBridge`/`stopMediaBridge`) and a `supportsVoiceMedia()`
  type guard. `AsteriskAriAdapter` and `AsteriskChanMobileProvider` **both**
  implement it, using the identical ARI bridge + `externalMedia` mechanism —
  because underneath, a chan_mobile call is still an Asterisk channel like
  any other.
- `start_voice_session`/`stop_voice_session` now resolve *"does whatever
  produced this call support media bridging?"* rather than asking which
  concrete class it is. A cellular call and a SIP-trunk call are equally
  capable of carrying live AI audio, and the AI agent never sees which one
  it's talking through — this check shouldn't either.

**Context flows across channels into the voice session.** Before a realtime
voice session connects, `mcp/server.ts`'s `buildContextInstructions()` looks
up whether the call belongs to a `CellularEndpoint`, and if so, pulls that
endpoint's prior SMS + earlier call-transcript history via
`ConversationService` and prepends it to the model's instructions. This is
the actual mechanism behind "the AI already knows about the text you sent
five minutes ago."

- **`ConversationService.recordTranscriptTurn()`** — call this from a
  `RealtimeVoiceProvider`'s `onTranscript` callback (already wired in
  `start_voice_session`) to write each turn of a live call's transcript back
  into that call's conversation history, merged alongside SMS as a third
  event kind (`"transcript"`). Not yet durably persisted (lives in
  `ConversationService`'s memory for the process's lifetime) — see Roadmap.
- **`ConversationService.formatConversationAsContext()`** — renders a
  conversation as plain-text lines suitable for a realtime model's
  instructions.

**Webhook idempotency is now durable, not an in-memory `Set`.**
`PersistenceStore.checkAndMarkSeen(namespace, key)` — an atomic
`INSERT ... ON CONFLICT DO NOTHING` in Postgres, an atomic `SET NX EX` in
Redis, a `Set` fallback in `MemoryStore` — is exposed to any adapter via a
new optional `attachIdempotencyCheck()` hook that `SessionManager` wires up
automatically at registration time. `TextBeeAdapter` uses it instead of its
own `Set`, so a retried webhook delivery is correctly de-duplicated even
across a process restart or between two separate gateway processes sharing
one Postgres/Redis.

**Verified, this round:**
- `AsteriskChanMobileProvider.startMediaBridge()`/`stopMediaBridge()` proven
  directly against the mock ARI server (now extended with `/bridges` and
  `/channels/externalMedia`) — the exact same bridge+externalMedia call
  sequence as `AsteriskAriAdapter`, confirming a cellular call really can be
  wired into the Media Engine.
- The full phase-1 loop, through the actual MCP tool layer (stub messaging +
  stub cellular voice, standing in for TextBee + chan_mobile): SMS sent via
  `send_message(from: endpoint_id)` → cellular call placed via
  `make_call(from: endpoint_id)` → **`start_voice_session` now succeeds on
  that cellular call** (previously threw `"only supported on the Asterisk
  ARI adapter"`) → `get_conversation` returns the merged SMS + call timeline.
- Transcript recording, merge, and context formatting, at the unit level:
  recorded two transcript turns on a call, confirmed `get_conversation`
  includes them alongside the SMS/call history in correct time order, and
  confirmed `formatConversationAsContext()` renders all of it as the
  plain-text block a realtime model would receive as prior context.
- `checkAndMarkSeen()` against a real running Postgres: first call for a key
  returns `true`, every subsequent call with that key returns `false`, a
  different key returns `true` again.
- **Durable conversation timeline survives a full process kill**: built up
  an SMS + a cellular call + a `start_voice_session` in one process against
  real Postgres+Redis, killed that process entirely, then confirmed a
  brand-new process (empty in-memory cache) recovers the full merged
  timeline via `get_conversation` — this is the actual proof that
  cross-channel AI context is now durable, not just correct-within-a-process.
- **All four call-control capabilities** (`setHold`/`setMute`/`transferCall`/
  `sendDtmfDigits`) proven directly against the mock ARI server (now
  extended with `/hold`, `/mute`, `/dtmf`, `/redirect`), including the type
  guards correctly recognizing `AsteriskChanMobileProvider` as implementing
  all four.
- **Endpoint status honesty**: confirmed a fully-configured endpoint reports
  `overall: "online"` with per-provider detail, and confirmed a
  voice-only endpoint (no messaging provider configured) correctly reports
  `"degraded"` rather than blanket online/offline.
- **A capability-dispatch bug caught by the durable-conversation test
  itself**: calling `hold_call` on a cellular call whose provider doesn't
  support holding used to fall through to the regular adapter path and
  throw a confusing `"Unknown provider"` error. Fixed to throw a clear
  `"Cellular voice provider ... does not support hold()"` instead — this is
  exactly the kind of bug that only surfaces when you actually run the
  failure path, not just the happy path.
- Full regression sweep re-run clean after all of the above: the TextBee and
  Asterisk ARI real-adapter demos, the RTP codec round-trip, the full
  18-tool MCP list, and Postgres restart-survival.

### Wire up real chan_mobile voice (Bluetooth HFP)

1. Pair an Android phone to the Asterisk host over Bluetooth (Settings →
   Bluetooth), granting Hands-Free Profile permissions.
2. Fill in `docker/asterisk/mobile.conf` with the phone's Bluetooth MAC
   address and adapter.
3. Add the `cellularVoiceProviders` + `cellularEndpoints` blocks from
   `config.example.yaml`, using a distinct `appName` (e.g.
   `ai-gateway-mobile`) from the SIP-trunk `asterisk-pbx` provider's, so the
   two ARI Stasis apps don't collide on one Asterisk box.
4. `make_call({ from: "android-home-01", to: "+1..." })` now places a real
   cellular call through that SIM; an inbound call to the SIM's number
   surfaces as a normal `call.incoming` event.
5. `start_voice_session({ call_id })` now bridges that cellular call's audio
   to the Media Engine exactly the way it would for a SIP-trunk call — the
   ARI mechanics are proven against a mock; what's still unverified is a
   chan_mobile channel's actual audio behavior under that bridge on real
   Bluetooth hardware.

As noted above, this path is unverified against live hardware — validate it
with a real paired phone before depending on it.

## Adding a new provider (e.g. Twilio, Matrix, Discord)

1. Implement `CommunicationAdapter` in `src/adapters/your-adapter.ts`.
2. Register its `type` string in `src/adapters/registry.ts`.
3. Add a `providers:` entry + `routing:` rule in your YAML config.

Nothing in `mcp/server.ts` or `core/session-manager.ts` changes — that's the
whole point of the adapter interface.

## Roadmap / not yet built

- **Jitter buffer**: the Media Engine's inbound path (Asterisk → provider)
  processes RTP packets as they arrive rather than through a jitter buffer;
  fine on a LAN/loopback, worth adding for real-world network conditions.
  Outbound (provider → Asterisk) is already paced at 20ms/frame.
- **Barge-in handling**: relies on the realtime model's own server-side VAD
  (e.g. OpenAI's `server_vad`) to detect when the caller starts speaking;
  there's no explicit "stop playback immediately" cutover in the Media
  Engine itself yet.
- **LiveKit ↔ PSTN**: the LiveKit adapter is app-to-app WebRTC only; wiring
  up LiveKit's own SIP bridge (`SipClient` in `livekit-server-sdk`) would let
  LiveKit reach real phone numbers too, as an alternative to Asterisk.
  LiveKit also doesn't implement `VoiceMediaProvider` — it has its own
  join-token-based media path (see `get_livekit_join_token`) rather than the
  ARI bridge+externalMedia mechanism the other two voice providers share.
  It also doesn't implement any of the four call-control capabilities yet.
- **WhatsApp/LiveKit/chan_mobile are untested against live
  accounts/servers/hardware**: all three are built against their real SDKs'
  or documented mechanisms (verified against installed package type
  definitions / Asterisk's docs). `AsteriskChanMobileProvider`'s full ARI
  surface (dial/answer/hangup/startMediaBridge/stopMediaBridge/
  setHold/setMute/transferCall/sendDtmfDigits) is now proven against a mock
  ARI server that speaks Asterisk's real REST+WebSocket shape — but a
  chan_mobile channel's actual audio behavior on real Bluetooth hardware
  remains the one thing that can't be verified without a physical paired
  phone. **This is now genuinely the single largest remaining gap**: every
  other piece of the phase-1 architecture (identity, messaging, call
  control, media bridging, durable cross-channel context) has been proven
  against real protocol-accurate mocks or real running Postgres/Redis — only
  the physical hardware step remains, and it can't be done in this
  environment. The specific test that would close it: send an SMS to a real
  SIM, confirm the AI replies via TextBee; call that same SIM, confirm the
  AI answers via Asterisk and already knows about the SMS; speak during the
  call and confirm the transcript persists; text again afterward and
  confirm the AI knows what was said out loud.
- **Additional `CellularVoiceProvider` backends** (placeholders only, not
  built): `android-sip` (rooted Android + PJSIP, direct SIP/RTP, removes
  Bluetooth's range/device-count limits), `hardware-gateway`
  (GoIP/Yeastar-style LTE↔SIP appliances for production multi-line
  deployments).
- **Fuller identity schema**: endpoint configs are now persisted
  (`saveEndpointConfig`/`listEndpointConfigs`), and the conversation
  timeline is now canonical and durable — but there's still no
  `Contact`/`Agent`/`CommunicationIdentity` model tying multiple channels
  (a phone number, a WhatsApp identity, an email address) to one person, or
  multiple endpoints to one agent. `ConversationService` identifies a
  conversation as (endpoint, counterpart address), which is enough for one
  SIM talking to one contact, but doesn't yet generalize to "this person has
  three different ways to reach us."
- **Endpoint status is still not a live device heartbeat**: `messaging.available`
  now honestly checks "is the messaging provider actually instantiated and
  registered" rather than just "was it mentioned in YAML" — a real
  improvement — but it's still not "is the TextBee Android app actually
  running right now" (no such check is documented in TextBee's API as far
  as this project has verified). Similarly, `voice.available` for
  chan_mobile is still the best-effort ARI `/endpoints` check described in
  that provider's own doc comment, not a live Bluetooth-connection check.
- **Additional adapters**: Matrix, Twilio (as an optional managed fallback),
  Discord/Slack for chat channels.
- **Additional realtime voice providers**: Gemini Live, a local
  Whisper+Ollama+TTS pipeline — anything implementing `RealtimeVoiceProvider`.
