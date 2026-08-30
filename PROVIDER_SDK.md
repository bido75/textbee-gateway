# Provider Adapter SDK

This is the plugin interface for the AI Communications Gateway: the one
contract every messaging/voice provider implements so that the MCP layer,
routing, persistence, and every existing adapter never need to know or care
which specific provider is underneath. Same idea as a database driver —
`send_message()` and `dial()` are the ORM; TextBee, Asterisk, WhatsApp,
LiveKit are the drivers.

If you're building a new integration (a new SMS gateway, a new VoIP
provider, a new chat platform), this document plus
`src/adapters/_template-adapter.ts` is everything you need.

## The interface

```ts
interface CommunicationAdapter {
  readonly id: ProviderId;              // this configured instance's id, e.g. "textbee-home-phone"
  readonly capabilities: ChannelKind[];  // which of voice/sms/mms/chat this instance actually handles

  init(config: Record<string, unknown>): Promise<void>;
  onEvent(handler: AdapterEventHandler): void;

  // Voice — implement only what your provider supports
  dial?(to: Endpoint, opts?: DialOptions): Promise<CallSession>;
  answer?(callId: string): Promise<void>;
  hangup?(callId: string): Promise<void>;
  hold?(callId: string, on: boolean): Promise<void>;
  mute?(callId: string, on: boolean): Promise<void>;
  transfer?(callId: string, to: Endpoint): Promise<void>;
  sendDtmf?(callId: string, digits: string): Promise<void>;
  record?(callId: string, on: boolean): Promise<void>;

  // Messaging
  sendMessage?(to: Endpoint, body: string, opts?: SendMessageOptions): Promise<MessageRecord>;

  shutdown(): Promise<void>;
}
```

Full type definitions: `src/core/types.ts`.

**Every method except `init`/`onEvent`/`shutdown` is optional.** Declare only
the `capabilities` your provider genuinely supports, and implement only the
matching methods. `SessionManager` checks this at call time — invoking a
method you didn't implement fails with a clear `Provider "x" does not
support dial()`-style error, rather than silently doing nothing. This is
deliberate: a half-implemented provider should fail loudly, not pretend to
work.

There's a second, narrower interface for cellular-specific voice backends
(`CellularVoiceProvider` in `src/cellular/types.ts`) used by the
`CellularEndpoint` architecture — see that file if you're building a
cellular voice gateway (Bluetooth HFP, a rooted-Android SIP bridge, a
hardware GSM gateway) rather than a general messaging/voice provider.

There's a third, orthogonal capability interface — `VoiceMediaProvider` in
`src/media/voice-media-provider.ts` — for "can this call's audio be bridged
to the Media Engine?" (`startMediaBridge`/`stopMediaBridge`). This is
deliberately separate from both `CommunicationAdapter` and
`CellularVoiceProvider` because it's about a capability a provider *might*
have, not what kind of provider it is: `AsteriskAriAdapter` (a
`CommunicationAdapter`) and `AsteriskChanMobileProvider` (a
`CellularVoiceProvider`) both implement it, using the identical ARI bridge +
`externalMedia` mechanism, because both ultimately produce an Asterisk
channel. If your voice provider can expose an RTP endpoint for its calls
(most SIP/Asterisk-based ones can), implement this too — `start_voice_session`
checks for the capability generically (`supportsVoiceMedia()`), not for a
specific class, so any provider implementing it gets live AI audio for free.

## Lifecycle

1. **Registry maps a config `type` string to a class.** `src/adapters/registry.ts`
   is the one place new adapter types get wired in:
   ```ts
   case "your-provider-type":
     return new YourAdapter(id);
   ```
2. **`init(config)`** runs once at startup with that instance's `config:`
   block from YAML (after `${ENV_VAR}` expansion — see
   `src/config/load-config.ts`). Validate required fields and throw
   immediately if something's missing; this fails at boot, not on the first
   real call three hours later.
3. **`onEvent(handler)`** hands you a single callback. Call it whenever
   something happens on the provider's side that the AI agent should know
   about: `call.incoming`, `call.state_changed`, `call.dtmf`, `call.ended`,
   `message.incoming`, `message.status`. See the full `AdapterEvent` union
   in `src/core/types.ts`. Where these events *come from* is entirely up to
   your adapter — a webhook HTTP handler (TextBee), a WebSocket event stream
   (Asterisk ARI, LiveKit), a library's own event emitter (WhatsApp via
   Baileys). `SessionManager.registerAdapter()` wires your handler into the
   shared event pipeline (local state, persistence, cross-process pub/sub)
   automatically — you never touch that plumbing directly.
4. **Method calls** (`dial`, `sendMessage`, etc.) happen whenever an MCP
   tool call resolves to your provider, via routing rules or an explicit
   `provider_id`. Each call should complete (or throw) — don't leave a
   `Promise` hanging on a background retry; if your provider is async by
   nature (queued SMS, a call that rings before connecting), return
   immediately with a `"queued"`/`"dialing"` status and emit a follow-up
   event later when it resolves.
5. **`shutdown()`** closes whatever persistent connection you opened in
   `init()` (a WebSocket, a paired device, a polling timer).

## Step-by-step: adding a new adapter

1. Copy `src/adapters/_template-adapter.ts` to `src/adapters/your-provider-adapter.ts`.
2. Rename the class and its config interface.
3. Delete whichever method groups don't apply (voice methods for a
   messaging-only provider, `sendMessage` for a voice-only provider).
4. Fill in `init()` with real config validation and any connection setup.
5. Fill in your capability methods with real API calls.
6. Fill in your inbound-event path — usually a webhook handler (copy
   `src/gateways/textbee-webhook-server.ts`'s pattern: verify any signature
   the provider offers, de-duplicate retried deliveries, then call your
   adapter's `handleInboundX()` method) or a persistent-connection event
   listener (copy `src/adapters/asterisk-ari-adapter.ts`'s WebSocket
   reconnect-on-close pattern).
7. Register the type string in `src/adapters/registry.ts`.
8. Add a `providers:` entry + `routing:` rule in your YAML config.
9. **Prove it end-to-end before trusting it.** You don't need a live
   account to do this — see the next section.

Nothing in `src/mcp/server.ts` or `src/core/session-manager.ts` changes for
any of this.

## Proving an adapter actually works: two worked examples

`examples/` contains two real adapters (not the built-in `StubAdapter`)
exercised end-to-end against small mock servers that speak each provider's
actual protocol shape:

- **`examples/demo-textbee-adapter.mjs`** + **`examples/mock-textbee-server.mjs`**
  — the real `TextBeeAdapter` against a mock implementing TextBee's current
  `POST /api/v1/gateway/send-sms` endpoint and its HMAC-SHA256-signed
  webhook delivery format. Proves: outbound send, inbound webhook
  ingestion, signature verification (including that a forged signature is
  rejected with 401), and de-duplication of a retried webhook delivery.
- **`examples/demo-asterisk-adapter.mjs`** + **`examples/mock-asterisk-ari-server.mjs`**
  — the real `AsteriskAriAdapter` (the "SIP trunk" example) against a mock
  implementing Asterisk's REST Interface: channel origination, answer,
  hangup, and a genuine WebSocket event stream. Proves: outbound
  origination via real HTTP, state transitions (`dialing` -> `ringing` ->
  `in-progress`) driven by real WebSocket events, and call teardown via a
  real `StasisEnd` event.

Run either with:
```bash
npm run build
node examples/demo-textbee-adapter.mjs
node examples/demo-asterisk-adapter.mjs
```

This pattern — a small local server that speaks just enough of the real
provider's protocol — is the recommended way to validate any new adapter you
build here: it's honest (you're testing your real adapter code, not a
stand-in), it's fast (no live account, no network dependency, no cost), and
it catches real integration bugs. It's exactly how a stale API endpoint in
the original `TextBeeAdapter` was caught and fixed while building this SDK
— see the adapter's doc comment for what changed and why.

## What "real adapter" does and doesn't mean here

Being exercised against a protocol-accurate mock is meaningfully more
validation than an adapter that's only been type-checked, but it is **not**
the same as having been run against the live TextBee/Asterisk/WhatsApp/
LiveKit services themselves — a mock can only be as correct as its author's
understanding of the real protocol. Where an adapter in this repo hasn't
been exercised against the real live service (WhatsApp, LiveKit, the
`chan_mobile` cellular voice provider), that's stated explicitly in the
adapter's own doc comment and in the main README's Roadmap section — look
there before depending on any of them in production.
