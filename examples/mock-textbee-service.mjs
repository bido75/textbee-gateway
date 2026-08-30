import http from "node:http";
const port = Number(process.env.PORT ?? 8090);
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true,"simulated":true}'); }
  if (req.method === "POST" && req.url === "/api/v1/gateway/send-sms") {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      try { const parsed = JSON.parse(body); if (!parsed.deviceId || !parsed.recipients?.length) throw new Error("invalid payload");
        res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ id: `mock-${Date.now()}`, status: "accepted", simulated: true }));
      } catch { res.writeHead(400); res.end(); }
    }); return;
  }
  res.writeHead(404); res.end();
});
server.listen(port, "0.0.0.0", () => console.log(`mock TextBee listening on ${port}`));

