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

Use `src/config/config.textbee.yaml`, set `TEXTBEE_API_KEY`, `TEXTBEE_DEVICE_ID`, and `TEXTBEE_WEBHOOK_SIGNING_SECRET`, and configure TextBee to deliver inbound events to `/webhooks/textbee/textbee-self-hosted` on a gateway URL reachable from the TextBee API container.

Truthful validation states are: backend online; device registered; device heartbeat online; then carrier SMS verified. Do not mark the latter states from container health alone.
