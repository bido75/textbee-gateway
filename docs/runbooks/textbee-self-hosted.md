# Self-hosted TextBee

The real backend is separate from the deterministic `mock-textbee` development service. A healthy backend proves MongoDB, Redis, the API, web UI, and Firebase Admin initialization; it does **not** prove an Android heartbeat or carrier SMS.

## Start the backend

Set `TEXTBEE_FIREBASE_ADMIN_JSON` to the absolute path of a Firebase service-account JSON, then run:

```powershell
docker compose -f docker-compose.textbee.yml up -d --build
```

Open the TextBee UI at `http://127.0.0.1:3010` and API documentation at `http://127.0.0.1:3011`.

## Android development build

The development flavor is registered as `com.vandjwebdesign.TextBee`. Put the matching, ignored `google-services.json` at `integrations/textbee/android/app/src/dev/google-services.json`. Set `TEXTBEE_ANDROID_API_BASE_URL` to an HTTPS/LAN URL the physical phone can reach; `localhost` and Docker service names will not work from Android. Then run `gradlew.bat assembleDevDebug` from `integrations/textbee/android`.

Install the APK, grant SMS permissions, disable battery optimization, create an account/API key in the self-hosted UI, and pair the phone. Record the resulting device id as `TEXTBEE_DEVICE_ID`.

## Bind the gateway

For a Docker/hosted SMS gateway, use `docker-compose.gateway-live.yml`. Set a
gateway operator `API_KEY` that is distinct from the TextBee `txb_` provider
key, plus `TEXTBEE_API_KEY`, `TEXTBEE_DEVICE_ID`, `TEXTBEE_BASE_URL`,
`TEXTBEE_WEBHOOK_SIGNING_SECRET`, and `CELLULAR_LINE_NUMBER`. The public
TextBee API URL is the default; this avoids relying on DNS between two
independent Compose project networks.

Create a TextBee webhook subscription with this delivery URL:

`https://hooks-comms.giscop.com/webhooks/textbee/textbee-self-hosted`

Subscribe to `MESSAGE_RECEIVED`, `MESSAGE_SENT`, `MESSAGE_DELIVERED`, and
`MESSAGE_FAILED`, and use the exact same signing secret configured in the
gateway. Incoming messages enter the shared conversation timeline; outbound
status events correlate through TextBee's `smsBatchId`.

The self-hosted API and Android payload currently implement SMS only. Do not
advertise or route MMS until both planes carry attachment metadata and binary
media. For physical cellular voice, deploy `src/config/config.edge.yaml` on a
Linux edge node after completing `docs/runbooks/bluetooth-edge.md`; the HTTP
tunnel does not carry Bluetooth HFP or SIP/RTP.

Truthful validation states are: backend online; device registered; device heartbeat online; then carrier SMS verified. Do not mark the latter states from container health alone.
