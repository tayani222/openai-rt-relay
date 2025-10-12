import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// ===== ENV =====
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD   = process.env.USE_INWORLD === "1";
const INWORLD_TTS   = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUTH  = process.env.INWORLD_API_KEY || ""; // "Basic <base64>" или просто "<base64>"
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Deborah";
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
const INWORLD_LANG  = process.env.INWORLD_LANG  || "";
const INWORLD_SR    = Number(process.env.INWORLD_SAMPLE_RATE || 16000);
const AUDIO_EVENT_PREFIX = process.env.AUDIO_EVENT_PREFIX || "response.output_audio"; // "response.audio" для старых клиентов
const FAKE_TONE     = process.env.FAKE_TONE === "1"; // режим быстрой проверки канала

const PORT = Number(process.env.PORT || 10000);

// ===== APP =====
const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({ ok: true, useInworld: USE_INWORLD }));
const server = http.createServer(app);

// ===== WS RELAY =====
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://local");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`;
  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  const textByResponse = new Map(); // rid -> concat text
  const outInfoByResponse = new Map(); // rid -> { itemId?: string, outputIndex?: number }

  // клиент -> OpenAI
  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      let s = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        const obj = JSON.parse(s);
        if (USE_INWORLD && obj?.type === "response.create") {
          obj.response = obj.response || {};
          obj.response.modalities = ["text"]; // просим у OpenAI только текст
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

  // OpenAI -> клиент (+ Inworld TTS)
  upstream.on("message", async (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (isBinary) { client.send(data, { binary: true }); return; }

    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let evt;
    try { evt = JSON.parse(text); } catch { client.send(text, { binary: false }); return; }

    const type = evt?.type || "";
    const rid  = evt.response_id || evt.response?.id || evt?.event?.response?.id || null;

    // Сохраняем связки item_id/output_index по ранним событиям
    if (USE_INWORLD && rid) {
      if (type === "response.output_item.added" || type === "response.content.part.added") {
        const info = outInfoByResponse.get(rid) || {};
        const gotItemId = evt.item_id || evt.item?.id;
        if (gotItemId && !info.itemId) info.itemId = gotItemId;
        if (typeof evt.output_index === "number") info.outputIndex = evt.output_index;
        outInfoByResponse.set(rid, info);
      }
      if (type === "conversation.item.created" && evt.item?.id) {
        const info = outInfoByResponse.get(rid) || {};
        if (!info.itemId) info.itemId = evt.item.id;
        outInfoByResponse.set(rid, info);
      }
    }

    // Копим текст из любых текстовых ивентов
    if (USE_INWORLD && rid) {
      const picked = collectTextFromEvent(evt);
      if (picked) {
        const prev = textByResponse.get(rid) || "";
        textByResponse.set(rid, prev + picked);
      }
    }

    // Финал ответа — синтез и стрим аудио
    if (USE_INWORLD && rid && (type === "response.done" || type === "response.completed")) {
      const fullRaw = normalizeSpaces(textByResponse.get(rid) || "");
      try {
        const info = outInfoByResponse.get(rid) || {};
        const itemId = info.itemId;
        const outputIndex = info.outputIndex ?? 0;

        if (FAKE_TONE) {
          console.log("FAKE_TONE enabled: streaming test tone");
          const tone = makeSinePcm16(1200, 1000, INWORLD_SR);
          await streamPcm16ToClient(client, tone, rid, itemId, outputIndex);
          client.send(JSON.stringify({
            type: `${AUDIO_EVENT_PREFIX}.done`,
            response_id: rid,
            ...(itemId ? { item_id: itemId } : {}),
            output_index: outputIndex
          }));
        } else if (fullRaw) {
          const segments = chunkText(fullRaw, 1800);
          console.log(`INWORLD synth segments=${segments.length}, totalLen=${fullRaw.length}`);
          for (const seg of segments) {
            const pcm16 = await synthesizeWithInworld(seg, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG, INWORLD_SR);
            await streamPcm16ToClient(client, pcm16, rid, itemId, outputIndex);
          }
          client.send(JSON.stringify({
            type: `${AUDIO_EVENT_PREFIX}.done`,
            response_id: rid,
            ...(itemId ? { item_id: itemId } : {}),
            output_index: outputIndex
          }));
        } else {
          console.log("INWORLD synth: empty text");
        }
      } catch (e) {
        console.error("inworld synth error:", e);
      } finally {
        textByResponse.delete(rid);
        outInfoByResponse.delete(rid);
      }

      // после аудио — проксируем оригинальный done
      client.send(JSON.stringify(evt));
      return;
    }

    // Прочее — просто проксируем
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
        output_audio_format: "pcm16" // безопасный формат
        // при необходимости можно расширить до объекта:
        // output_audio_format: { type: "pcm16", sample_rate: INWORLD_SR, channels: 1 }
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

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// ===== Collect text from any event =====
function collectTextFromEvent(evt) {
  const type = evt?.type || "";
  if (/(response\.(output_)?text\.delta)/.test(type) && typeof evt.delta === "string") return evt.delta;
  if (/(response\.(output_)?text\.done)/.test(type) && typeof evt.text === "string") return evt.text;
  if (type === "conversation.item.created" && evt.item && Array.isArray(evt.item.content)) {
    let s = "";
    for (const part of evt.item.content) if (part && typeof part.text === "string") s += (s ? " " : "") + part.text;
    return s || "";
  }
  return "";
}

// ===== Inworld TTS (устойчив к audio/wav и JSON audioContent) =====
async function synthesizeWithInworld(text, voiceId, modelId, lang, targetSr = 16000) {
  const payload = { text, voiceId, modelId };
  if (lang) payload.language = lang;

  // Пытаемся явно попросить WAV/PCM у бэка (если он поддерживает — ок, если нет — игнорирует):
  payload.format = payload.format || "wav";
  payload.sampleRate = payload.sampleRate || targetSr;
  payload.sampleRateHertz = payload.sampleRateHertz || targetSr;
  payload.audioEncoding = payload.audioEncoding || "LINEAR16";
  payload.container = payload.container || "wav";
  payload.encoding = payload.encoding || "LINEAR16";

  const r = await fetch(INWORLD_TTS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Предпочитаем бинарный WAV, но согласны на JSON:
      "Accept": "audio/wav, application/json;q=0.9",
      "Authorization": INWORLD_AUTH.startsWith("Basic ") ? INWORLD_AUTH : `Basic ${INWORLD_AUTH}`
    },
    body: JSON.stringify(payload)
  });

  const ct  = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  // Вариант 1: пришёл WAV в теле
  if (looksLikeWav(buf)) {
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
    return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
  }

  // Вариант 2: пришёл JSON (audioContent base64 либо URL)
  if (ct.includes("application/json")) {
    try {
      const json = JSON.parse(buf.toString("utf8"));
      // Ошибка от Inworld?
      if (json && typeof json === "object" && (json.code || json.message)) {
        console.error("Inworld error json:", json);
        throw new Error(`Inworld TTS error code=${json.code} message=${json.message}`);
      }

      // 2.1) Прямое поле audioContent (как в Google TTS)
      const ac = findAudioContent(json);
      if (ac) {
        const audioBuf = decodeBase64Loose(ac);
        // Если это WAV — парсим
        if (looksLikeWav(audioBuf)) {
          const { sampleRate, channels, pcm16 } = parseWavPcm16(audioBuf);
          const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
          return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
        }
        // Если это LINEAR16 (raw PCM) — используем как есть
        const enc = (json.audioEncoding || json.encoding || json.audioConfig?.audioEncoding || "LINEAR16").toUpperCase();
        const sr  = Number(json.sampleRateHertz || json.sampleRate || json.audioConfig?.sampleRateHertz || targetSr) || targetSr;
        const ch  = Number(json.channels || json.channelCount || 1) || 1;

        if (enc.includes("LINEAR16") || enc.includes("PCM")) {
          const pcmRaw = ch > 1 ? stereoToMono(audioBuf) : audioBuf;
          return sr === targetSr ? pcmRaw : resamplePcm16(pcmRaw, sr, targetSr);
        }

        // Если сжал (MP3/OGG) — не декодируем, просим настроить WAV
        if (isCompressedAudio(audioBuf)) {
          throw new Error("Inworld returned compressed audio (mp3/ogg). Set Accept=audio/wav or format=wav.");
        }

        // Последний шанс: длина кратна 2 — похоже на PCM16
        if (audioBuf.length % 2 === 0) {
          return audioBuf; // считаем PCM16 @ targetSr
        }

        throw new Error("Unknown audioContent encoding");
      }

      // 2.2) Ищем WAV base64 где угодно в JSON
      const wavBuf = findWavBase64InJson(json);
      if (wavBuf) {
        const { sampleRate, channels, pcm16 } = parseWavPcm16(wavBuf);
        const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
        return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
      }

      // 2.3) Или URL на WAV
      const url = extractAudioUrl(json);
      if (url) {
        const r2 = await fetch(url, { headers: { "Accept": "audio/wav,*/*;q=0.1" } });
        const buf2 = Buffer.from(await r2.arrayBuffer());
        if (!looksLikeWav(buf2)) throw new Error(`Fetched URL but not WAV (ct=${r2.headers.get("content-type")})`);
        const { sampleRate, channels, pcm16 } = parseWavPcm16(buf2);
        const mono2 = channels > 1 ? stereoToMono(pcm16) : pcm16;
        return sampleRate === targetSr ? mono2 : resamplePcm16(mono2, sampleRate, targetSr);
      }

      console.error("Inworld TTS JSON keys:", Object.keys(json));
      throw new Error("No audioContent / WAV / URL in JSON");
    } catch (e) {
      console.error("Inworld TTS content-type:", ct, "len:", buf.length, "head:", buf.subarray(0,16).toString("hex"));
      throw e;
    }
  }

  // Не JSON и не WAV — пробуем распознать по сигнатурам или ругаемся
  if (isCompressedAudio(buf)) {
    throw new Error("Inworld returned compressed audio (mp3/ogg). Set Accept=audio/wav or format=wav.");
  }

  console.error("Inworld TTS content-type:", ct, "len:", buf.length, "head:", buf.subarray(0,16).toString("hex"));
  throw new Error("Unexpected Inworld TTS response");
}

// ===== STREAM PCM TO CLIENT =====
async function streamPcm16ToClient(client, pcm, responseId, itemId, outputIndex = 0) {
  const sampleRate = INWORLD_SR;
  const bytesPerChunk = 480 * 2; // ~30мс @16k
  for (let o = 0; o < pcm.length; o += bytesPerChunk) {
    if (client.readyState !== WebSocket.OPEN) break;
    const chunk = pcm.subarray(o, Math.min(o + bytesPerChunk, pcm.length));
    const b64 = chunk.toString("base64");

    client.send(JSON.stringify({
      type: `${AUDIO_EVENT_PREFIX}.delta`,
      response_id: responseId,
      ...(itemId ? { item_id: itemId } : {}),
      output_index: outputIndex,
      audio: b64
    }));

    const ms = Math.round((chunk.length / 2) / sampleRate * 1000);
    await wait(Math.max(1, ms));
  }
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }

// ===== Helpers: test tone =====
function makeSinePcm16(ms = 1200, hz = 1000, sr = 16000) {
  const len = Math.floor(ms / 1000 * sr);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(32767 * Math.sin(2 * Math.PI * hz * i / sr));
  return Buffer.from(out.buffer);
}

// ===== TEXT CHUNKING =====
function chunkText(input, max = 1800) {
  const t = normalizeSpaces(input);
  if (t.length <= max) return [t];
  const out = []; let cur = "";
  const parts = t.split(/(\.|\?|!|…)+\s+/);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]; if (!seg) continue;
    const next = (cur ? cur + " " : "") + seg;
    if (next.length <= max) cur = next;
    else {
      if (cur) out.push(cur);
      if (seg.length <= max) cur = seg;
      else {
        const words = seg.split(/\s+/); let buf = "";
        for (const w of words) {
          const n2 = (buf ? buf + " " : "") + w;
          if (n2.length <= max) buf = n2; else { if (buf) out.push(buf); buf = w; }
        }
        cur = buf;
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}
function normalizeSpaces(s){ return s.replace(/\s+/g, " ").trim(); }

// ===== WAV/Audio utils =====
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
  if (inRate === outRate) return pcm16;
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
function isCompressedAudio(buf){
  // MP3: "ID3" или 0xFFEx; OGG: "OggS"; M4A/AAC: "ftyp"
  if (buf.length < 4) return false;
  const a = buf[0], b = buf[1], c = buf[2], d = buf[3];
  if (a===0x49 && b===0x44 && c===0x33) return true;            // "ID3"
  if (a===0xFF && (b & 0xE0) === 0xE0) return true;             // mp3 frame
  if (String.fromCharCode(a,b,c,d) === "OggS") return true;     // ogg
  if (String.fromCharCode(a,b,c,d) === "ftyp") return true;     // mp4/m4a
  return false;
}

// ===== JSON AUDIO HELPERS =====
function looksLikeBase64Loose(s){
  return typeof s === "string" &&
         s.length > 32 &&
         /^[A-Za-z0-9+/_=:\s-]+$/.test(s);
}
function stripDataPrefix(s){
  const i = s.indexOf("base64,");
  return i >= 0 ? s.slice(i + 7) : s;
}
function decodeBase64Loose(s){
  return Buffer.from(stripDataPrefix(String(s)).replace(/\s+/g,""), "base64");
}
function findAudioContent(obj){
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.audioContent === "string") return obj.audioContent;
  if (obj.output && typeof obj.output.audioContent === "string") return obj.output.audioContent;
  // по массивам тоже пройдёмся
  if (Array.isArray(obj)) {
    for (const v of obj) { const r = findAudioContent(v); if (r) return r; }
  } else {
    for (const v of Object.values(obj)) { if (v && typeof v === "object") { const r = findAudioContent(v); if (r) return r; } }
  }
  return null;
}
function tryDecodeWavBase64(s) {
  if (typeof s !== "string") return null;
  const buf = decodeBase64Loose(s);
  return looksLikeWav(buf) ? buf : null;
}
function findWavBase64InJson(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) { for (const v of obj) { const got = findWavBase64InJson(v); if (got) return got; } return null; }
  for (const [_, v] of Object.entries(obj)) {
    if (typeof v === "string" && looksLikeBase64Loose(v)) {
      const decoded = tryDecodeWavBase64(v);
      if (decoded) return decoded;
    } else if (v && typeof v === "object") {
      const inner = findWavBase64InJson(v);
      if (inner) return inner;
    }
  }
  return null;
}
function extractAudioUrl(obj){
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) { for (const v of obj) { const u = extractAudioUrl(v); if (u) return u; } return null; }
  const cand = ["url","audioUrl","href","signedUrl","link"];
  for (const k of cand) {
    const v = obj[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const inner = extractAudioUrl(v);
      if (inner) return inner;
    }
  }
  return null;
}
