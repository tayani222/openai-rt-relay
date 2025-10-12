import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// -------- ENV --------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD   = process.env.USE_INWORLD === "1";
const INWORLD_TTS   = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUTH  = process.env.INWORLD_API_KEY || "";  // желательно "Basic <base64>"
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Deborah";
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
const INWORLD_LANG  = process.env.INWORLD_LANG  || "";

// -------- APP --------
const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true, useInworld: USE_INWORLD }));
const server = http.createServer(app);

// -------- WS RELAY --------
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://x");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`;
  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  // накапливаем текст по response_id
  const textByResponse = new Map();
  let lastRid = null;

  // клиент -> openai
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

  // openai -> клиент (и синтез Inworld)
  upstream.on("message", async (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;

    if (isBinary) { client.send(data, { binary: true }); return; }

    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let evt;
    try { evt = JSON.parse(text); } catch { client.send(text, { binary: false }); return; }

    const type = evt?.type || "";

    // запоминаем последний response_id, если обнаружили
    const ridNow = evt.response_id || evt.response?.id || null;
    if (ridNow) lastRid = ridNow;

    // Копим любые строковые дельты (более надёжно, чем проверять тип)
    if (USE_INWORLD && typeof evt.delta === "string") {
      const rid = ridNow || lastRid;
      if (rid) {
        textByResponse.set(rid, (textByResponse.get(rid) || "") + evt.delta);
        return; // текст UE не нужен
      }
    }

    // финал ответа: запускаем синтез и стримим в UE
    if (USE_INWORLD && (type === "response.done" || type === "response.completed")) {
      const rid = ridNow || lastRid;
      const full = rid ? (textByResponse.get(rid) || "").trim() : "";
      try {
        if (full) {
          console.log("INWORLD synth start, len=", full.length);
          const pcm16 = await synthesizeWithInworld(full, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG);
          await streamPcm16ToClient(client, pcm16);
        } else {
          console.log("INWORLD synth: empty text");
        }
      } catch (e) {
        console.error("inworld synth error:", e);
      } finally {
        if (rid) textByResponse.delete(rid);
      }
      client.send(JSON.stringify(evt));
      return;
    }

    // проксируем прочие события (session.*, errors, и т.д.)
    client.send(JSON.stringify(evt), { binary: false });
  });

  upstream.on("open", () => {
    console.log("upstream open");
    const init = {
      type: "session.update",
      session: {
        voice,
        modalities: USE_INWORLD ? ["text"] : ["audio","text"],
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
  upstream.on("error", (e) => console.error("upstream error:", e.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// -------- INWORLD TTS --------
async function synthesizeWithInworld(text, voiceId, modelId, lang) {
  const payload = { text, voiceId, modelId };
  if (lang) payload.language = lang;

  const r = await fetch(INWORLD_TTS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "*/*", // примем и audio/wav, и json
      "Authorization": INWORLD_AUTH.startsWith("Basic ") ? INWORLD_AUTH : `Basic ${INWORLD_AUTH}`
    },
    body: JSON.stringify(payload)
  });

  const ct = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  // 1) бинарный WAV
  if (looksLikeWav(buf)) {
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
    return sampleRate === 16000 ? mono : resamplePcm16(mono, sampleRate, 16000);
  }

  // 2) JSON с base64 или ссылкой
  try {
    const txt = buf.toString("utf8");
    const json = JSON.parse(txt);

    // base64 в разных полях
    let b64 = extractBase64Audio(json);
    if (b64) {
      const wav = Buffer.from(b64, "base64");
      if (!looksLikeWav(wav)) throw new Error("Got base64 but not WAV");
      const { sampleRate, channels, pcm16 } = parseWavPcm16(wav);
      const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
      return sampleRate === 16000 ? mono : resamplePcm16(mono, sampleRate, 16000);
    }

    // или url на файл
    const url = extractAudioUrl(json);
    if (url) {
      const r2 = await fetch(url);
      const buf2 = Buffer.from(await r2.arrayBuffer());
      if (!looksLikeWav(buf2)) throw new Error(`Fetched URL but not WAV (ct=${r2.headers.get("content-type")})`);
      const { sampleRate, channels, pcm16 } = parseWavPcm16(buf2);
      const mono2 = channels > 1 ? stereoToMono(pcm16) : pcm16;
      return sampleRate === 16000 ? mono2 : resamplePcm16(mono2, sampleRate, 16000);
    }

    console.error("Inworld TTS JSON keys:", Object.keys(json));
    throw new Error("No audio field in JSON");
  } catch (e) {
    console.error("Inworld TTS content-type:", ct, "len:", buf.length, "head:", buf.subarray(0,16).toString("hex"));
    throw new Error("Unexpected Inworld TTS response");
  }
}

// -------- STREAM PCM TO UE --------
async function streamPcm16ToClient(client, pcm) {
  const chunkBytes = 480 * 2; // ~30мс @16kHz
  for (let o = 0; o < pcm.length; o += chunkBytes) {
    if (client.readyState !== WebSocket.OPEN) break;
    const chunk = pcm.subarray(o, Math.min(o + chunkBytes, pcm.length));
    const b64 = chunk.toString("base64");
    client.send(JSON.stringify({ type: "output_audio_buffer.append", audio: b64 }));
    await wait(30);
  }
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// -------- WAV UTILS --------
function looksLikeWav(buf) {
  return buf.length >= 12 &&
         buf.toString("ascii", 0, 4) === "RIFF" &&
         buf.toString("ascii", 8, 12) === "WAVE";
}
function parseWavPcm16(buf) {
  if (!looksLikeWav(buf)) throw new Error("Not a WAV file");
  let pos = 12, sampleRate = 16000, channels = 1, bitsPerSample = 16;
  let dataStart = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bitsPerSample = buf.readUInt16LE(pos + 22);
      if (fmt !== 1 || bitsPerSample !== 16) throw new Error(`Unsupported WAV: fmt=${fmt}, bps=${bitsPerSample}`);
    } else if (id === "data") {
      dataStart = pos + 8; dataLen = size; break;
    }
    pos += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("WAV data chunk not found");
  return { sampleRate, channels, pcm16: buf.subarray(dataStart, dataStart + dataLen) };
}
function stereoToMono(pcm16){
  const in16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length/2);
  const out16 = new Int16Array(in16.length/2);
  for (let i=0,j=0; j<out16.length; i+=2, j++) out16[j] = ((in16[i]+in16[i+1])/2) | 0;
  return Buffer.from(out16.buffer, out16.byteOffset, out16.length*2);
}
function resamplePcm16(pcm16, inRate, outRate){
  const in16 = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length/2);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.floor(in16.length * ratio));
  const out16 = new Int16Array(outLen);
  for (let i=0; i<outLen; i++){
    const src = i/ratio;
    const s0 = Math.floor(src);
    const s1 = Math.min(s0+1, in16.length-1);
    const t = src - s0;
    out16[i] = (in16[s0]*(1-t) + in16[s1]*t) | 0;
  }
  return Buffer.from(out16.buffer, out16.byteOffset, out16.length*2);
}

// -------- JSON AUDIO HELPERS --------
function looksLikeBase64(s){
  return typeof s === "string" && s.length > 80 && /^[A-Za-z0-9+/=\r\n]+$/.test(s);
}
function extractBase64Audio(obj){
  if (!obj || typeof obj !== "object") return null;
  const cand = ["audio", "audioBase64", "audio_base64", "data", "audioContent", "wav"];
  for (const k of cand) {
    const v = obj[k];
    if (looksLikeBase64(v)) return v;
    if (v && typeof v === "object") {
      if (looksLikeBase64(v.data)) return v.data;
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (looksLikeBase64(v)) return v;
    if (v && typeof v === "object") {
      const inner = extractBase64Audio(v);
      if (inner) return inner;
    }
  }
  return null;
}
function extractAudioUrl(obj){
  if (!obj || typeof obj !== "object") return null;
  const cand = ["url","audioUrl","href","signedUrl","link"];
  for (const k of cand) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const inner = extractAudioUrl(v);
      if (inner) return inner;
    }
  }
  return null;
}
