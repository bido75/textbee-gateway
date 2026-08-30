import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const credentialPath = process.env.FIREBASE_ADMIN_JSON ?? "/run/secrets/firebase-admin.json";
const credential = JSON.parse(readFileSync(credentialPath, "utf8"));
if (credential.type !== "service_account" || !credential.private_key || !credential.client_email) {
  throw new Error("FIREBASE_ADMIN_JSON must contain a Firebase service-account credential");
}

process.env.FIREBASE_PROJECT_ID = credential.project_id;
process.env.FIREBASE_PRIVATE_KEY_ID = credential.private_key_id;
process.env.FIREBASE_PRIVATE_KEY = credential.private_key.replace(/\n/g, "\\n");
process.env.FIREBASE_CLIENT_EMAIL = credential.client_email;
process.env.FIREBASE_CLIENT_ID = credential.client_id;
process.env.FIREBASE_CLIENT_C509_CERT_URL = credential.client_x509_cert_url;
// A stable local-only JWT secret derived in memory avoids storing another secret in source.
process.env.JWT_SECRET ||= createHash("sha256").update(credential.private_key).digest("hex");

await import("/app/dist/main.js");
