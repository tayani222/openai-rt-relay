import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const app = express();
app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://x");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  const upstream = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
    { headers: { Authorization: `Bearer ${KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  upstream.on("open", () => {
    const init = {
      type: "session.update",
      session: {
        voice,
        modalities: ["audio", "text"],
        input_audio_format: "pcm16",
        input_audio_sample_rate: 16000,
        output_audio_format: "pcm16"
      }
    };
    upstream.send(JSON.stringify(init));
  });

  client.on("message", (d) => { if (upstream.readyState === 1) upstream.send(d); });
  upstream.on("message", (d) => { if (client.readyState === 1) client.send(d); });

  const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {}; };
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`relay listening on ${PORT}`));