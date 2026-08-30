import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";

// Mimics just enough of Asterisk's ARI (REST + WebSocket events) to exercise
// the REAL AsteriskAriAdapter class end-to-end: channel origination,
// answer, hangup, and an inbound StasisStart/StasisEnd event pair.

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ari/events" });

const channels = new Map();
let wsClient = null;

function checkAuth(req, res) {
  const auth = req.header("authorization") || "";
  if (auth !== "Basic " + Buffer.from("ai-gateway:test-ari-password").toString("base64")) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function sendEvent(evt) {
  if (wsClient) wsClient.send(JSON.stringify(evt));
}

// Originate a channel (outbound call)
app.post("/ari/channels", (req, res) => {
  if (!checkAuth(req, res)) return;
  const id = crypto.randomUUID();
  const { endpoint, app: appName } = req.body;
  channels.set(id, { id, endpoint, state: "Down" });
  console.log(`[mock-asterisk] originated channel ${id} -> ${endpoint} (app=${appName})`);
  res.json({ id, name: endpoint, state: "Down" });

  // Simulate StasisStart shortly after origination (call enters our app),
  // then Ringing -> Up state transitions, mirroring real ARI event flow.
  setTimeout(() => {
    sendEvent({ type: "StasisStart", channel: { id, caller: { number: "+15550000000" }, dialplan: {} } });
  }, 150);
  setTimeout(() => {
    channels.get(id).state = "Ring";
    sendEvent({ type: "ChannelStateChange", channel: { id, state: "Ring" } });
  }, 300);
  setTimeout(() => {
    channels.get(id).state = "Up";
    sendEvent({ type: "ChannelStateChange", channel: { id, state: "Up" } });
  }, 600);
});

app.post("/ari/channels/:id/answer", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] answer channel ${req.params.id}`);
  res.status(204).send();
});

app.post("/ari/channels/:id/hold", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] hold channel ${req.params.id}`);
  res.status(204).send();
});

app.delete("/ari/channels/:id/hold", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] unhold channel ${req.params.id}`);
  res.status(204).send();
});

app.post("/ari/channels/:id/mute", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] mute channel ${req.params.id} (direction=${req.query.direction})`);
  res.status(204).send();
});

app.delete("/ari/channels/:id/mute", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] unmute channel ${req.params.id}`);
  res.status(204).send();
});

app.post("/ari/channels/:id/dtmf", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] send DTMF "${req.query.dtmf}" on channel ${req.params.id}`);
  res.status(204).send();
});

app.post("/ari/channels/:id/redirect", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] redirect channel ${req.params.id} -> ${req.query.endpoint}`);
  res.status(204).send();
});

app.delete("/ari/channels/:id", (req, res) => {
  if (!checkAuth(req, res)) return;
  console.log(`[mock-asterisk] hangup channel ${req.params.id}`);
  sendEvent({ type: "StasisEnd", channel: { id: req.params.id } });
  channels.delete(req.params.id);
  res.status(204).send();
});

app.get("/ari/endpoints", (req, res) => {
  if (!checkAuth(req, res)) return;
  res.json([]);
});

// --- Media bridging (VoiceMediaProvider) ---
// Real Asterisk semantics: POST /bridges creates a mixing bridge, POST
// /channels/externalMedia creates a channel that sends/receives RTP to an
// external host, and both get added to the bridge. Same endpoints, same
// request shape, whether the call being bridged came from a SIP trunk
// (AsteriskAriAdapter) or a chan_mobile Bluetooth phone
// (AsteriskChanMobileProvider) — this mock doesn't need to know or care
// which; that's the whole point of the VoiceMediaProvider abstraction.
const bridges = new Map();

app.post("/ari/bridges", (req, res) => {
  if (!checkAuth(req, res)) return;
  const id = crypto.randomUUID();
  bridges.set(id, { id, channels: [] });
  console.log(`[mock-asterisk] created bridge ${id}`);
  res.json({ id, technology: "simple_bridge", bridge_type: req.body?.type ?? "mixing", channels: [] });
});

app.post("/ari/channels/externalMedia", (req, res) => {
  if (!checkAuth(req, res)) return;
  const id = crypto.randomUUID();
  const { external_host, format, app: appName } = req.query;
  channels.set(id, { id, endpoint: `externalMedia/${external_host}`, state: "Up" });
  console.log(`[mock-asterisk] created externalMedia channel ${id} -> ${external_host} (format=${format}, app=${appName})`);
  res.json({ id, name: `UnicastRTP/${external_host}`, state: "Up" });
});

app.post("/ari/bridges/:id/addChannel", (req, res) => {
  if (!checkAuth(req, res)) return;
  const bridge = bridges.get(req.params.id);
  if (!bridge) return res.status(404).json({ error: "bridge not found" });
  bridge.channels.push(req.query.channel);
  console.log(`[mock-asterisk] added channel ${req.query.channel} to bridge ${req.params.id}`);
  res.status(204).send();
});

app.delete("/ari/bridges/:id", (req, res) => {
  if (!checkAuth(req, res)) return;
  bridges.delete(req.params.id);
  console.log(`[mock-asterisk] destroyed bridge ${req.params.id}`);
  res.status(204).send();
});

wss.on("connection", (ws) => {
  console.log("[mock-asterisk] ARI WebSocket client connected");
  wsClient = ws;
});

const PORT = 4002;
server.listen(PORT, () => console.log(`[mock-asterisk] ARI mock listening on :${PORT}`));
