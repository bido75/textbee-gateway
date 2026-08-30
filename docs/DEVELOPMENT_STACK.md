# Docker Desktop development edge

The development profile proves the Linux software path with real Postgres, Redis, Asterisk ARI, ARI ExternalMedia bridge creation, RTP media-engine allocation, REST, MCP code, and TextBee/cellular simulations. It does not prove Bluetooth HFP or real cellular audio.

```powershell
docker compose -f docker-compose.dev.yml up -d --build
npm run test:e2e:docker
docker compose -f docker-compose.dev.yml ps
```

REST listens only on `127.0.0.1:8080`; Postgres, Redis, Asterisk ARI/SIP, mock TextBee, and RTP are private to the Compose network. The development bearer token is `dev-local-key` and must never be reused outside local development.

Key routes:

- `GET /livez`, `GET /readyz`, `GET /openapi.json`
- `GET /v1/endpoints`
- `POST /v1/messages`
- `GET|POST /v1/calls`
- call action and voice-session routes under `/v1/calls/:id`
- `GET /v1/conversations?endpointId=...&counterpart=...`

The `DEV_SIMULATION=true` profile additionally exposes `/v1/dev/simulate/*`. These routes are absent when simulation is disabled.
