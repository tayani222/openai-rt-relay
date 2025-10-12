import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// Беcкрэшовый режим: логируем, не падаем
process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// ===== ENV =====
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD   = process.env.USE_INWORLD === "1";
const INWORLD_TTS   = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUTH  = process.env.INWORLD_API_KEY || ""; // "Basic <base64>"
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Anastasia"; // поставьте RU-voice вашего аккаунта
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
const INWORLD_LANG  = process.env.INWORLD_LANG  || "ru-RU";

const INWORLD_SR    = Number(process.env.INWORLD_SAMPLE_RATE || 16000); // стабильнее всего 16k
const CHUNK_SAMPLES = Number(process.env.CHUNK_SAMPLES || 960);   // 60 мс @16k
const PREBUFFER_MS  = Number(process.env.PREBUFFER_MS  || 240);   // стартовый буфер
const CHUNK_TEXT_MAX= Number(process.env.CHUNK_TEXT_MAX|| 800);   // сегментация текста
const MIN_SENTENCE  = Number(process.env.MIN_SENTENCE_CHARS || 100); // мин. размер фразы для раннего TTS

const EARLY_TTS     = process.env.EARLY_TTS !== "0"; // по умолчанию включён ранний синтез
const AUDIO_EVENT_PREFIX = process.env.AUDIO_EVENT_PREFIX || "response.output_audio"; // или "response.audio"
const FAKE_TONE     = process.env.FAKE_TONE === "1";

const PORT = Number(process.env.PORT || 10000);

// ===== APP =====
const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({
  ok: true, useInworld: USE_INWORLD, sr: INWORLD_SR,
  chunkSamples: CHUNK_SAMPLES, prebufferMs: PREBUFFER_MS,
  earlyTts: EARLY_TTS, audioEventPrefix: AUDIO_EVENT_PREFIX
}));
const server = http.createServer(app);

// ===== WS RELAY =====
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://local");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  // При USE_INWORLD НЕ передаем voice в OpenAI, чтобы он не слал свой TTS
  const upstreamUrl = USE_INWORLD
    ? `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`
    : `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}&voice=${encodeURIComponent(voice)}`;

  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  // По response_id храним состояние синтеза/стрима
  const byRid = new Map(); // rid -> { textPending, itemId, outputIndex, speakChain, started }

  // клиент -> OpenAI
  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (!isBinary) {
      let s = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      try {
        const obj = JSON.parse(s);
        if (USE_INWORLD && obj?.type === "response.create") {
          obj.response = obj.response || {};
          obj.response.modalities = ["text"]; // только текст
          delete obj.response.voice;
          delete obj.response.audio;
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

    // Отрезаем любое аудио от OpenAI
    if (USE_INWORLD && /^response\.(output_)?audio\./.test(type)) return;

    // Инициализация трекера
    if (USE_INWORLD && rid && !byRid.has(rid)) {
      byRid.set(rid, { textPending: "", itemId: undefined, outputIndex: 0, speakChain: Promise.resolve(), started: false });
    }
    const tracker = rid ? byRid.get(rid) : null;

    // Захват item_id / output_index (и сразу «будим» тех, кто ждал)
    if (USE_INWORLD && rid && tracker) {
      if (type === "response.output_item.added" || type === "response.content.part.added") {
        const gotItemId = evt.item_id || evt.item?.id;
        if (gotItemId && !tracker.itemId) tracker.itemId = gotItemId;
        if (typeof evt.output_index === "number") tracker.outputIndex = evt.output_index;
      }
      if (type === "conversation.item.created" && evt.item?.id && !tracker.itemId) {
        tracker.itemId = evt.item.id;
      }
    }

    // Копим текст + ранний синтез по завершённым предложениям
    if (USE_INWORLD && rid && tracker) {
      const picked = collectTextFromEvent(evt);
      if (picked) {
        tracker.textPending += picked;

        if (EARLY_TTS) {
          const { complete, rest } = cutCompleteSentences(tracker.textPending, MIN_SENTENCE, CHUNK_TEXT_MAX);
          tracker.textPending = rest;

          for (const raw of complete) {
            const seg = sanitizeSegment(raw);
            if (!isSpeakable(seg)) continue; // игнорируем «пустые» сегменты, чтобы не падало
            tracker.speakChain = tracker.speakChain.then(async () => {
              try {
                const pcm = FAKE_TONE
                  ? makeSinePcm16(900, 900, INWORLD_SR)
                  : await synthesizeWithInworld(seg, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG, INWORLD_SR);
                await streamPcm16ToClient(client, pcm, rid, tracker.itemId, tracker.outputIndex, !tracker.started);
                tracker.started = true;
              } catch (e) {
                console.error("speakChain synth error:", e?.message || e);
              }
            }).catch(e => console.error("speakChain error:", e));
          }
        }
      }
    }

    // Финал — докручиваем хвост и закрываем аудио
    if (USE_INWORLD && rid && (type === "response.done" || type === "response.completed")) {
      try {
        if (tracker) {
          const tail = sanitizeSegment(tracker.textPending || "");
          tracker.textPending = "";

          const segments = [];
          if (isSpeakable(tail)) {
            for (const part of chunkText(tail, CHUNK_TEXT_MAX)) {
              const seg = sanitizeSegment(part);
              if (isSpeakable(seg)) segments.push(seg);
            }
          }

          if (segments.length === 0 && !tracker.started) {
            // бывает, весь ответ — «…»/кавычки и т.п.; просто не озвучиваем
            console.log("No speakable text to synth (skipping audio).");
          } else {
            for (const seg of segments) {
              tracker.speakChain = tracker.speakChain.then(async () => {
                try {
                  const pcm = FAKE_TONE
                    ? makeSinePcm16(900, 900, INWORLD_SR)
                    : await synthesizeWithInworld(seg, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG, INWORLD_SR);
                  await streamPcm16ToClient(client, pcm, rid, tracker.itemId, tracker.outputIndex, !tracker.started);
                  tracker.started = true;
                } catch (e) {
                  console.error("final tail synth error:", e?.message || e);
                }
              });
            }
          }

          // После очереди — посылаем done
          tracker.speakChain = tracker.speakChain.then(async () => {
            client.send(JSON.stringify({
              type: `${AUDIO_EVENT_PREFIX}.done`,
              response_id: rid,
              ...(tracker.itemId ? { item_id: tracker.itemId } : {}),
              output_index: tracker.outputIndex
            }));
          }).finally(() => byRid.delete(rid));
        }
      } catch (e) {
        console.error("finalize error:", e);
      } finally {
        // Проксируем оригинальный done
        client.send(JSON.stringify(evt));
      }
      return;
    }

    // Прочее — проксируем
    client.send(JSON.stringify(evt), { binary: false });
  });

  upstream.on("open", () => {
    console.log("upstream open");
    const session = {
      modalities: USE_INWORLD ? ["text"] : ["audio","text"],
      input_audio_format: "pcm16",
      output_audio_format: { type: "pcm16", sample_rate: INWORLD_SR, channels: 1 }
    };
    if (!USE_INWORLD) session.voice = voice; // голос OpenAI только если Inworld OFF
    upstream.send(JSON.stringify({ type: "session.update", session }));
  });

  const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {}; };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", (e) => console.error("upstream error:", e.message));
});

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// ===== TEXT HELPERS =====
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
function sanitizeSegment(s) {
  // убираем лишнее, нормализуем пробелы
  return String(s).replace(/\s+/g, " ").trim();
}
function isSpeakable(s) {
  // хотя бы одна буква или цифра в любом Юникоде
  return /[\p{L}\p{N}]/u.test(s);
}
// ранний TTS: режем по завершённым предложениям с минимальной длиной
function cutCompleteSentences(input, minChars = 100, hardMax = 800) {
  const t = sanitizeSegment(input);
  if (!t) return { complete: [], rest: "" };
  const out = [];
  let last = 0;
  const re = /([.!?…]+)(\s+|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[1].length;
    const seg = t.slice(last, end).trim();
    if (seg.length >= minChars || seg.length >= hardMax) {
      out.push(seg);
      last = m.index + m[0].length;
    }
  }
  const rest = t.slice(last).trim();
  // если остаток слишком длинный — порежем
  const extra = [];
  if (rest.length > hardMax) {
    const parts = chunkText(rest, hardMax);
    extra.push(...parts.slice(0, -1));
    return { complete: out.concat(extra), rest: parts.at(-1) || "" };
  }
  return { complete: out, rest };
}
function chunkText(input, max = 800) {
  const t = sanitizeSegment(input);
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

// ===== STREAM PCM (с пре-буфером) =====
async function streamPcm16ToClient(client, pcm, responseId, itemId, outputIndex = 0, prebufferFirst = true) {
  const sr = INWORLD_SR;
  const bytesPerSample = 2;
  const bytesPerChunk = CHUNK_SAMPLES * bytesPerSample;
  const chunkMs = Math.round(CHUNK_SAMPLES / sr * 1000);
  const burstChunks = prebufferFirst ? Math.max(0, Math.floor(PREBUFFER_MS / chunkMs)) : 0;

  let sent = 0;
  let chunkIdx = 0;
  const t0 = Date.now();

  while (sent < pcm.length) {
    if (client.readyState !== WebSocket.OPEN) break;
    const end = Math.min(sent + bytesPerChunk, pcm.length);
    const chunk = pcm.subarray(sent, end);
    sent = end;

    client.send(JSON.stringify({
      type: `${AUDIO_EVENT_PREFIX}.delta`,
      response_id: responseId,
      ...(itemId ? { item_id: itemId } : {}),
      output_index: outputIndex,
      audio: chunk.toString("base64")
    }));

    if (chunkIdx >= burstChunks) {
      const ideal = t0 + chunkIdx * chunkMs;
      const delay = Math.max(0, ideal - Date.now());
      await wait(delay || chunkMs);
    } else {
      await wait(1); // набиваем буфер
    }
    chunkIdx++;
  }
}
function wait(ms){ return new Promise(r => setTimeout(r, ms)); }
function makeSinePcm16(ms = 900, hz = 900, sr = 16000) {
  const len = Math.floor(ms / 1000 * sr);
  const out = new Int16Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(32767 * Math.sin(2 * Math.PI * hz * i / sr));
  return Buffer.from(out.buffer);
}

// ===== Inworld TTS (WAV или JSON audioContent LINEAR16) =====
async function synthesizeWithInworld(text, voiceId, modelId, lang, targetSr = 16000) {
  if (!isSpeakable(text)) throw new Error("synthesizeWithInworld: empty/unspeakable text");

  const payload = {
    text, voiceId, modelId, language: lang,
    // просим несжатый PCM
    format: "wav", audioFormat: "wav", container: "wav",
    encoding: "LINEAR16", audioEncoding: "LINEAR16",
    sampleRate: targetSr, sampleRateHertz: targetSr,
    channels: 1,
    audio: { format: "wav", sampleRate: targetSr, channels: 1 },
    audioConfig: { audioFormat: "wav", audioEncoding: "LINEAR16", sampleRateHertz: targetSr, channels: 1 }
  };

  const r = await fetch(INWORLD_TTS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "audio/wav, application/json;q=0.9",
      "Authorization": INWORLD_AUTH.startsWith("Basic ") ? INWORLD_AUTH : `Basic ${INWORLD_AUTH}`
    },
    body: JSON.stringify(payload)
  });

  const ct  = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  // 1) WAV в теле
  if (looksLikeWav(buf)) {
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
    return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
  }

  // 2) JSON: audioContent/URL/base64
  if (ct.includes("application/json")) {
    try {
      const json = JSON.parse(buf.toString("utf8"));

      if (json && typeof json === "object" && (json.code || json.message)) {
        console.error("Inworld error json:", json);
        throw new Error(`Inworld TTS error code=${json.code} message=${json.message}`);
      }

      const ac = findAudioContent(json);
      if (ac) {
        const audioBuf = decodeBase64Loose(ac);
        if (looksLikeWav(audioBuf)) {
          const { sampleRate, channels, pcm16 } = parseWavPcm16(audioBuf);
          const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
          return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
        }
        const enc = (json.audioEncoding || json.encoding || json.audioConfig?.audioEncoding || "LINEAR16").toUpperCase();
        const sr  = Number(json.sampleRateHertz || json.sampleRate || json.audioConfig?.sampleRateHertz || targetSr) || targetSr;
        const ch  = Number(json.channels || json.channelCount || 1) || 1;

        if (enc.includes("LINEAR16") || enc.includes("PCM")) {
          const pcmRaw = ch > 1 ? stereoToMono(audioBuf) : audioBuf;
          return sr === targetSr ? pcmRaw : resamplePcm16(pcmRaw, sr, targetSr);
        }
        if (isCompressedAudio(audioBuf)) throw new Error("Inworld returned compressed audio (mp3/ogg). Configure WAV/LINEAR16.");
        if (audioBuf.length % 2 === 0) return audioBuf; // возможно raw PCM16
        throw new Error("Unknown audioContent encoding");
      }

      const wavBuf = findWavBase64InJson(json);
      if (wavBuf) {
        const { sampleRate, channels, pcm16 } = parseWavPcm16(wavBuf);
        const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
        return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
      }

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
      throw new Error("No audio found in JSON");
    } catch (e) {
      console.error("Inworld TTS content-type:", ct, "len:", buf.length, "head:", buf.subarray(0,16).toString("hex"));
      throw e;
    }
  }

  if (isCompressedAudio(buf)) throw new Error("Inworld returned compressed audio (mp3/ogg). Configure WAV/LINEAR16.");
  console.error("Inworld TTS content-type:", ct, "len:", buf.length);
  throw new Error("Unexpected Inworld TTS response");
}

// ===== WAV/Audio utils =====
function looksLikeWav(buf) {
  return buf.length >= 12 &&
         buf.toString("ascii", 0, 4) === "RIFF" &&
         buf.toString("ascii", 8, 12) === "WAVE";
}
function parseWavPcm16(buf) {
  if (!looksLikeWav(buf)) throw new Error("Not a WAV file");
  let pos = 12, sampleRate = 16000, channels = 1, bps = 16;
  let dataStart = -1, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      const fmt = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bps = buf.readUInt16LE(pos + 22);
      if (fmt !== 1 || bps !== 16) throw new Error(`Unsupported WAV: fmt=${fmt}, bps=${bps}`);
    } else if (id === "data") { dataStart = pos + 8; dataLen = size; break; }
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
  if (buf.length < 4) return false;
  const a = buf[0], b = buf[1], c = buf[2], d = buf[3];
  if (a===0x49 && b===0x44 && c===0x33) return true; // "ID3"
  if (a===0xFF && (b & 0xE0) === 0xE0) return true;  // MP3 frame
  if (String.fromCharCode(a,b,c,d) === "OggS") return true;
  if (String.fromCharCode(a,b,c,d) === "ftyp") return true; // MP4/AAC
  return false;
}

// ===== JSON audio helpers =====
function looksLikeBase64Loose(s){ return typeof s === "string" && s.length > 32 && /^[A-Za-z0-9+/_=:\s-]+$/.test(s); }
function stripDataPrefix(s){ const i = s.indexOf("base64,"); return i >= 0 ? s.slice(i + 7) : s; }
function decodeBase64Loose(s){ return Buffer.from(stripDataPrefix(String(s)).replace(/\s+/g,""), "base64"); }
function findAudioContent(obj){
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.audioContent === "string") return obj.audioContent;
  if (obj.output && typeof obj.output.audioContent === "string") return obj.output.audioContent;
  if (Array.isArray(obj)) { for (const v of obj) { const r = findAudioContent(v); if (r) return r; } }
  else { for (const v of Object.values(obj)) if (v && typeof v === "object") { const r = findAudioContent(v); if (r) return r; } }
  return null;
}
function tryDecodeWavBase64(s){ const buf = decodeBase64Loose(s); return looksLikeWav(buf) ? buf : null; }
function findWavBase64InJson(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) { for (const v of obj) { const got = findWavBase64InJson(v); if (got) return got; } return null; }
  for (const [_, v] of Object.entries(obj)) {
    if (typeof v === "string" && looksLikeBase64Loose(v)) { const decoded = tryDecodeWavBase64(v); if (decoded) return decoded; }
    else if (v && typeof v === "object") { const inner = findWavBase64InJson(v); if (inner) return inner; }
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
  for (const v of Object.values(obj)) if (v && typeof v === "object") {
    const inner = extractAudioUrl(v); if (inner) return inner;
  }
  return null;
}
