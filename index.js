import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD = process.env.USE_INWORLD === "1";
const INWORLD_TTS_URL = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_API_KEY = S0pmd3E5VWJ6WkRSSUtIYnNhZUlkbmIwZmFYcGdpdHo6YVVKc1JzN2FYcDdnVWtWYUdJbjZPRndvaUt2QU9pZ0ZvaHBiNnRRRGwxTmhzTUZ6aTJ0eFZLWFNVUGN0elVqRw==
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Deborah";
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
// если Inworld требует язык, можно добавить INWORLD_LANG и прокинуть в payload
const INWORLD_LANG  = process.env.INWORLD_LANG || ""; // "ru" при необходимости

const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true, useInworld: USE_INWORLD }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://x");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  const upstreamUrl =
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`;

  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  const textByResponse = new Map();

  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      let s = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        const obj = JSON.parse(s);
        if (USE_INWORLD && obj?.type === "response.create") {
          obj.response = obj.response || {};
          obj.response.modalities = ["text"]; // у OpenAI просим только текст
          s = JSON.stringify(obj);
        }
        upstream.send(s, { binary: false });
      } catch {
        upstream.send(s, { binary: false });
      }
    } else {
      upstream.send(data, { binary: true });
    }
  });

  upstream.on("message", async (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (isBinary) { client.send(data, { binary: true }); return; }

    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let evt;
    try { evt = JSON.parse(text); } catch { client.send(text, { binary: false }); return; }

    const type = evt?.type || "";

    // копим текст дельт, когда USE_INWORLD
    if (USE_INWORLD && (type.includes("output_text.delta") || type.includes("text.delta"))) {
      const rid = evt.response_id || evt.response?.id;
      if (rid) {
        const prev = textByResponse.get(rid) || "";
        textByResponse.set(rid, prev + (evt.delta || ""));
      }
      return; // UE текст не нужен
    }

    if (USE_INWORLD && type === "response.completed") {
      const rid = evt.response_id || evt.response?.id;
      const fullText = (rid && textByResponse.get(rid)) ? textByResponse.get(rid).trim() : "";
      try {
        if (fullText) {
          const pcm16 = await synthesizeWithInworld(fullText, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG);
          await streamPcm16ToClient(client, pcm16);
        }
      } catch (e) {
        console.error("inworld synth error:", e);
      } finally {
        textByResponse.delete(rid);
      }
      client.send(JSON.stringify(evt));
      return;
    }

    // проксируем остальное
    client.send(JSON.stringify(evt), { binary: false });
  });

  upstream.on("open", () => {
    console.log("upstream open");
    const init = {
      type: "session.update",
      session: {
        voice,
        modalities: USE_INWORLD ? ["text"] : ["audio", "text"],
        input_audio_format: "pcm16",
        output_audio_format: USE_INWORLD ? "text" : "pcm16"
      }
    };
    upstream.send(JSON.stringify(init));
  });

  const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {}; };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", (e) => console.error("upstream error", e.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// ---------- Inworld TTS ----------
async function synthesizeWithInworld(text, voiceId, modelId, lang) {
  const payload = { text, voiceId, modelId };
  if (lang) payload.language = lang;

  const r = await fetch(INWORLD_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Если ключ уже содержит префикс "Basic ", оставь так. Иначе добавим:
      "Authorization": INWORLD_API_KEY.startsWith("Basic ")
        ? INWORLD_API_KEY
        : `Basic ${INWORLD_API_KEY}`,
      // лучше просить WAV:
      "Accept": "audio/wav"
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Inworld TTS ${r.status} ${txt}`);
  }

  const ct = r.headers.get("content-type") || "";
  if (ct.includes("audio/")) {
    const buf = Buffer.from(await r.arrayBuffer());
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    let mono = pcm16;
    if (channels > 1) mono = stereoToMono(mono);
    return sampleRate === 16000 ? mono : resamplePcm16(mono, sampleRate, 16000);
  } else {
    // вдруг пришёл JSON с base64
    const j = await r.json();
    const b64 = j.audio || j.audioBase64 || j.data;
    if (!b64) throw new Error("Unexpected Inworld TTS response");
    const wav = Buffer.from(b64, "base64");
    const { sampleRate, channels, pcm16 } = parseWavPcm16(wav);
    let mono = pcm16;
    if (channels > 1) mono = stereoToMono(mono);
    return sampleRate === 16000 ? mono : resamplePcm16(mono, sampleRate, 16000);
  }
}

async function streamPcm16ToClient(client, pcm) {
  const chunkBytes = 480 * 2; // 30мс @16kHz
  for (let o = 0; o < pcm.length; o += chunkBytes) {
    const chunk = pcm.subarray(o, Math.min(o + chunkBytes, pcm.length));
    const b64 = chunk.toString("base64");
    const msg = JSON.stringify({ type: "output_audio_buffer.append", audio: b64 });
    if (client.readyState !== WebSocket.OPEN) break;
    client.send(msg);
    await wait(30);
  }
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- WAV utils ----------
function parseWavPcm16(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let pos = 12, sampleRate = 16000, channels = 1, bitsPerSample = 16;
  let dataStart = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      const audioFormat = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bitsPerSample = buf.readUInt16LE(pos + 22);
      if (audioFormat !== 1 || bitsPerSample !== 16) {
        throw new Error(`Unsupported WAV: format=${audioFormat}, bps=${bitsPerSample}`);
      }
    } else if (id === "data") {
      dataStart = pos + 8; dataLen = size; break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("WAV data chunk not found");
  return { sampleRate, channels, pcm16: buf.subarray(dataStart, dataStart + dataLen) };
}
function stereoToMono(pcm16) {
  const in16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length/2);
  const out16 = new Int16Array(in16.length/2);
  for (let i=0, j=0; j<out16.length; i+=2, j++) out16[j] = ((in16[i] + in16[i+1]) / 2) | 0;
  return Buffer.from(out16.buffer, out16.byteOffset, out16.length*2);
}
function resamplePcm16(pcm16, inRate, outRate) {
  const in16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length/2);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.floor(in16.length * ratio));
  const out16 = new Int16Array(outLen);
  for (let i=0; i<outLen; i++) {
    const src = i / ratio;
    const s0 = Math.floor(src);
    const s1 = Math.min(s0 + 1, in16.length - 1);
    const t = src - s0;
    out16[i] = (in16[s0] * (1 - t) + in16[s1] * t) | 0;
  }
  return Buffer.from(out16.buffer, out16.byteOffset, out16.length*2);
}
