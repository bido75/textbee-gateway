import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import { newId } from "../core/session-manager.js";
import {
  AdapterEvent,
  AdapterEventHandler,
  ChannelKind,
  CommunicationAdapter,
  Endpoint,
  MessageRecord,
  SendMessageOptions,
} from "../core/types.js";

export interface WhatsAppConfig {
  /** Directory to persist the multi-device auth session (avoids re-scanning the QR code every restart). */
  authDir?: string;
  /** Print the QR code to stderr on first login. */
  printQrOnConnect?: boolean;
}

/**
 * WhatsAppAdapter — free, self-hosted WhatsApp messaging via Baileys
 * (an open-source implementation of the WhatsApp Web multi-device
 * protocol; no Meta Business API account or per-message fee involved).
 *
 * IMPORTANT — capabilities are messaging (`chat`) only, not voice:
 * Baileys can technically observe/reject incoming WhatsApp *call* signaling
 * events, but it does not expose a way to send/receive the actual voice
 * media for a WhatsApp call — that would require reverse-engineering
 * WhatsApp's proprietary call/media protocol, which is a materially
 * different (and far less stable) undertaking than message sending. This
 * adapter deliberately does NOT claim `voice` in its capabilities so the
 * routing config can't accidentally send a `dial()` here and get silent
 * failures. For actual calling, route `voice` to the Asterisk/Kamailio PBX
 * adapter instead — WhatsApp here covers free chat-style messaging only.
 *
 * First run requires scanning a QR code (printed to stderr) with the phone
 * that owns the WhatsApp account; after that, the session in `authDir`
 * persists across restarts.
 */
export class WhatsAppAdapter implements CommunicationAdapter {
  readonly id: string;
  readonly capabilities: ChannelKind[] = ["chat"];

  private config!: WhatsAppConfig;
  private handler: AdapterEventHandler | null = null;
  private sock: WASocket | null = null;

  constructor(id = "whatsapp") {
    this.id = id;
  }

  async init(config: Record<string, unknown>): Promise<void> {
    this.config = {
      authDir: "./.whatsapp-session",
      printQrOnConnect: true,
      ...(config as WhatsAppConfig),
    };
    await this.connect();
  }

  onEvent(handler: AdapterEventHandler): void {
    this.handler = handler;
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir!);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // we handle QR display ourselves below for clearer logging
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && this.config.printQrOnConnect) {
        process.stderr.write(
          `[whatsapp:${this.id}] Scan this QR code with WhatsApp (Linked Devices) to log in:\n${qr}\n`
        );
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        process.stderr.write(
          `[whatsapp:${this.id}] connection closed (code=${statusCode}). Reconnecting: ${shouldReconnect}\n`
        );
        if (shouldReconnect) {
          this.connect().catch((err) =>
            process.stderr.write(`[whatsapp:${this.id}] reconnect failed: ${err}\n`)
          );
        }
      } else if (connection === "open") {
        process.stderr.write(`[whatsapp:${this.id}] connected.\n`);
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue; // don't echo our own sent messages back as inbound
        const text =
          msg.message?.conversation ??
          msg.message?.extendedTextMessage?.text ??
          msg.message?.imageMessage?.caption ??
          "";
        const senderJid = msg.key.remoteJid ?? "unknown";

        const event: AdapterEvent = {
          type: "message.incoming",
          message: {
            id: newId("msg"),
            provider: this.id,
            kind: "chat",
            direction: "inbound",
            from: { address: jidToAddress(senderJid) },
            to: { address: "whatsapp:self" },
            body: text,
            sentAt: new Date().toISOString(),
            status: "received",
          },
        };
        this.handler?.(event);
      }
    });
  }

  async sendMessage(
    to: Endpoint,
    body: string,
    opts?: SendMessageOptions
  ): Promise<MessageRecord> {
    if (!this.sock) throw new Error(`WhatsApp adapter "${this.id}" is not connected`);

    const jid = addressToJid(to.address);

    if (opts?.mediaUrls?.length) {
      // Send the first media URL as an image with the body as caption; a
      // real deployment might branch on content-type/extension to pick
      // image/video/document, omitted here for brevity.
      await this.sock.sendMessage(jid, {
        image: { url: opts.mediaUrls[0] },
        caption: body,
      });
    } else {
      await this.sock.sendMessage(jid, { text: body });
    }

    return {
      id: newId("msg"),
      provider: this.id,
      kind: opts?.mediaUrls?.length ? "mms" : "chat",
      direction: "outbound",
      from: opts?.from ?? { address: "whatsapp:self" },
      to,
      body,
      mediaUrls: opts?.mediaUrls,
      sentAt: new Date().toISOString(),
      status: "sent",
    };
  }

  async shutdown(): Promise<void> {
    this.sock?.end(undefined);
    this.sock = null;
  }
}

/** "+15551234567" -> "15551234567@s.whatsapp.net" */
function addressToJid(address: string): string {
  const digits = address.replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

/** "15551234567@s.whatsapp.net" -> "+15551234567" */
function jidToAddress(jid: string): string {
  const digits = jid.split("@")[0];
  return `+${digits}`;
}
