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

  // Добавим voice и выключим компрессию
  const upstreamUrl =
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`;

  console.log("client connected", u.search);
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      Authorization: `Bearer ${KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
    perMessageDeflate: false, // важно: без компрессии
  });

  upstream.on("open", () => {
    console.log("upstream open");
    // Базовая настройка сессии (аудио 16к, голос, рус.инструкции)
    const init = {
      type: "session.update",
      session: {
        voice,
        modalities: ["audio", "text"],
        input_audio_format: "pcm16",
        input_audio_sample_rate: 16000,
        output_audio_format: "pcm16",
        instructions: "Отвечай по‑русски и кратко."
      }
    };
    upstream.send(JSON.stringify(init));
  });

  upstream.on("close", (code, reason) =>
    console.log("upstream close", code, reason?.toString?.() || "")
  );
  upstream.on("error", (e) => console.error("upstream error", e.message));
  client.on("close", (code, reason) =>
    console.log("client close", code, reason?.toString?.() || "")
  );
  client.on("error", (e) => console.error("client error", e.message));

  // Клиент -> OpenAI
  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) {
      // если вдруг бинарь — просто пробрасываем как бинарь
      upstream.send(data, { binary: true });
    } else {
      // текст шлём как текст
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      upstream.send(text, { binary: false });
    }
  });

  // OpenAI -> Клиент
  // ВАЖНО: JSON-события шлём именно текстом, а не бинарём
  upstream.on("message", (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      client.send(text, { binary: false });
      return;
    }

    // Если пришло как бинарь, проверим — вдруг это на самом деле текст JSON
    const maybeText = Buffer.isBuffer(data) ? data.toString("utf8") : "";
    if (maybeText.startsWith("{") || maybeText.startsWith("[")) {
      client.send(maybeText, { binary: false });
    } else {
      client.send(data, { binary: true });
    }
  });

  const closeBoth = () => {
    try { client.close(); } catch {}
    try { upstream.close(); } catch {}
  };
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`relay listening on ${PORT}`));
