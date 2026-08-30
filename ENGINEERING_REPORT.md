# Engineering report — Docker development edge

## Delivered

- Transport-neutral `CommunicationApplicationService` used by the new provider-neutral REST surface.
- Authenticated REST calls/messages/endpoints/conversations/voice-session API, request IDs, structured errors, health/readiness, and OpenAPI discovery.
- Docker Desktop stack containing gateway, PostgreSQL, Redis, Asterisk, and mock TextBee with health-based startup ordering and private service ports.
- Simulated cellular voice through real Asterisk ARI Local channels; ExternalMedia bridge creation reaches the Node RTP media engine.
- E.164 normalization before endpoint calls/messages and conversation lookup.
- Durable canonical Postgres conversation turns for SMS, call lifecycle, and transcripts, plus versioned schema migration tracking.
- Durable webhook dedupe through Redis and cross-restart acceptance coverage.
- Explicit simulation labels and development-only simulation routes.
- Native Linux/BlueZ/`chan_mobile` edge deployment profile and hardware runbook.

## Reliability enhancement pass

- `/readyz` now probes the live persistence layer and reports endpoint component state instead of returning unconditional success.
- HTTP requests emit structured completion logs with request IDs, status, and latency.
- REST payloads and query parameters receive explicit validation with consistent `404`, `409`, and `422` errors.
- Voice-session startup is transactional: failed ARI bridge creation rolls back the RTP/media session.
- ARI bridge creation compensates for partial failures by deleting channels and bridges already created.
- RTP connection failures release their UDP sockets; port selection retries across the configured range; audio queues are bounded.
- Runtime shutdown drains active media bridges, awaits HTTP closure, and prevents intentional ARI WebSocket shutdown from scheduling reconnects.
- The dashboard prevents overlapping refreshes and only exposes simulation controls when simulation mode is active.

## Verification performed

```text
npm run build             PASS
npm run typecheck         PASS
npm run lint              PASS
npm test                  PASS (5/5)
docker compose ... up     PASS (5 healthy services)
npm run test:e2e:docker   PASS
```

The Docker acceptance test receives and replays a signed TextBee webhook, restarts the gateway, verifies one durable SMS event, creates a simulated inbound cellular call through Asterisk ARI, starts an ExternalMedia voice session with prior SMS context, persists transcripts, hangs up, restarts again, verifies the cross-channel timeline, and sends an outbound SMS/call through the logical endpoint.

## Mock validated

- TextBee request/webhook protocol, HMAC, dedupe, SMS/MMS persistence.
- Logical endpoint routing and REST authentication.
- Postgres/Redis persistence across container restarts.
- Asterisk ARI connection, call origination, Stasis events, bridge and ExternalMedia channel creation.
- RTP listener/session lifecycle and stub realtime provider control path.
- Cross-channel context and durable transcript timeline.

## Not hardware validated

- Android TextBee app/device heartbeat and real SMS/MMS carrier delivery.
- Bluetooth HFP, BlueZ reconnection, and `chan_mobile` module/device behavior.
- Real cellular inbound/outbound calls, DTMF, caller ID, busy/no-answer mapping.
- Physical two-way audio, jitter/packet loss, 30-minute calls, and soak testing.
- OpenAI Realtime behavior with a production API key.

## Run locally

```powershell
npm ci
npm run build
npm test
docker compose -f docker-compose.dev.yml up -d --build
npm run test:e2e:docker
```

For the first real Linux edge setup, install BlueZ and native Asterisk with `chan_mobile`, follow `docs/runbooks/bluetooth-edge.md`, copy `.env.example`, switch `cellularVoiceProviders` from simulated ARI to `asterisk-chan-mobile`, and keep ARI/Postgres/Redis private.
