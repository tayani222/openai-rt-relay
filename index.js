import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// Node 18+/20+ уже содержит fetch. Если у тебя старее — раскомментируй строку ниже.
// import fetch from "node-fetch";

process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// ===== ENV =====
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD   = process.env.USE_INWORLD === "1";           // 1 — синтез через Inworld TTS, 0 — голос OpenAI
const INWORLD_TTS   = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUTH  = process.env.INWORLD_API_KEY || "";         // "Basic <base64>" или просто "<base64>"
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Anastasia";  // RU voiceId
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
const INWORLD_LANG  = process.env.INWORLD_LANG  || "ru-RU";

const INWORLD_SR    = Number(process.env.INWORLD_SAMPLE_RATE || 16000);
const CHUNK_SAMPLES = Number(process.env.CHUNK_SAMPLES || 960);   // ~60мс @16k
const PREBUFFER_MS  = Number(process.env.PREBUFFER_MS  || 240);
const CHUNK_TEXT_MAX= Number(process.env.CHUNK_TEXT_MAX|| 300);
const MIN_SENTENCE  = Number(process.env.MIN_SENTENCE_CHARS || 6);

const EARLY_TTS     = process.env.EARLY_TTS !== "0";              // ранний синтез по завершённым фразам
const AUTO_RESPONSE = process.env.AUTO_RESPONSE === "1";          // если 1 — сервер сам отправляет response.create
const AUTO_DELAY_MS = Number(process.env.AUTO_RESPONSE_DELAY_MS || 180);

const ALWAYS_RU     = process.env.ALWAYS_RU !== "0";              // добавлять «говори по‑русски»
const AUDIO_EVENT_PREFIX = process.env.AUDIO_EVENT_PREFIX || "response.output_audio";
const FAKE_TONE     = process.env.FAKE_TONE === "1";

const PORT = Number(process.env.PORT || 10000);

// ===== APP =====
const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({
  ok: true, useInworld: USE_INWORLD, sr: INWORLD_SR,
  chunkSamples: CHUNK_SAMPLES, prebufferMs: PREBUFFER_MS,
  earlyTts: EARLY_TTS, autoResponse: AUTO_RESPONSE, autoDelayMs: AUTO_DELAY_MS,
  audioEventPrefix: AUDIO_EVENT_PREFIX
}));
const server = http.createServer(app);

// ===== WS RELAY =====
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://local");
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || "verse";

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}${USE_INWORLD ? "" : `&voice=${encodeURIComponent(voice)}`}`;

  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD, "AUTO_RESPONSE=", AUTO_RESPONSE ? "on" : "off");

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  // Состояние диалога
  let currentInstructions = ""; // инструкция из UE (биография персонажа)
  let autoTimer = null;         // отложенный auto response.create
  let generating = false;       // сейчас идёт генерация?
  let activeRid = null;         // текущий response_id (для TTS)
  const byRid = new Map();      // rid -> { buf, itemId, outputIndex, speakChain, started }

  // ===== CLIENT -> OPENAI =====
  client.on("message", (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      let s = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let obj;
      try { obj = JSON.parse(s); } catch { upstream.send(s, { binary: false }); return; }

      // Запоминаем инструкции (биография)
      if (obj?.type === "session.update" && obj.session) {
        if (typeof obj.session.instructions === "string" && obj.session.instructions.trim()) {
          currentInstructions = mergeRusGuard(obj.session.instructions);
        }
      }

      // Автоответ сервером: реагируем на commit (если включен AUTO_RESPONSE)
      if (obj?.type === "input_audio_buffer.commit" && AUTO_RESPONSE) {
        if (!autoTimer) {
          autoTimer = setTimeout(() => {
            autoTimer = null;
            safeCreateResponse("auto");
          }, AUTO_DELAY_MS);
        }
        // Коммит всё равно пробрасываем
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
      }

      // Клиентский response.create
      if (obj?.type === "response.create") {
        if (AUTO_RESPONSE) {
          // В авто‑режиме сервер — единственный источник create
          if (obj.response?.instructions) currentInstructions = mergeRusGuard(obj.response.instructions);
          console.log("drop client response.create (AUTO_RESPONSE active)");
          return;
        }
        // Ручной режим: клиент — единый источник create
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }

        obj.response = obj.response || {};
        obj.response.modalities = USE_INWORLD ? ["text"] : ["audio","text"];
        if (obj.response.instructions) currentInstructions = mergeRusGuard(obj.response.instructions);
        obj.response.instructions = currentInstructions || defaultRusGuard();

        // Перед новым create — отменим текущее поколение (если идёт)
        if (generating) {
          try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {}
        }
        console.log("send client response.create");
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
      }

      // Прочие события — просто проксируем
      upstream.send(JSON.stringify(obj), { binary: false });
    } else {
      // бинарный аудио-ввод
      upstream.send(data, { binary: true });
    }
  });

  // ===== OPENAI -> CLIENT (+ Inworld TTS) =====
  upstream.on("message", async (data, isBinary) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (isBinary) { client.send(data, { binary: true }); return; }

    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let evt;
    try { evt = JSON.parse(text); } catch { client.send(text, { binary: false }); return; }

    const type = evt?.type || "";
    const rid  = evt.response_id || evt.response?.id || evt?.event?.response?.id || null;

    // Фильтр: при Inworld TTS — не пересылаем аудио OpenAI
    if (USE_INWORLD && /^response\.(output_)?audio\./.test(type)) return;

    // Инструкции могут приехать через session.updated
    if (type === "session.updated" && evt.session?.instructions) {
      currentInstructions = mergeRusGuard(evt.session.instructions);
    }

    // Трек статуса генерации
    if (type === "response.created" && rid) {
      generating = true;
      activeRid = rid;
      if (USE_INWORLD && !byRid.has(rid)) {
        byRid.set(rid, { buf: "", itemId: undefined, outputIndex: 0, speakChain: Promise.resolve(), started: false });
      }
    }

    // Если модель прислала ошибку — сбросим состояние
    if (type === "response.error") {
      generating = false;
      activeRid = null;
    }

    // Трекинг item_id / output_index
    if (USE_INWORLD && rid && byRid.has(rid)) {
      const tracker = byRid.get(rid);
      if (type === "response.output_item.added" || type === "response.content.part.added") {
        const gotItemId = evt.item_id || evt.item?.id;
        if (gotItemId && !tracker.itemId) tracker.itemId = gotItemId;
        if (typeof evt.output_index === "number") tracker.outputIndex = evt.output_index;
      }
      if (type === "conversation.item.created" && evt.item?.id && !tracker.itemId) {
        tracker.itemId = evt.item.id;
      }
    }

    // Сбор ТОЛЬКО дельт текста (без накопительных полей)
    if (USE_INWORLD && rid && byRid.has(rid)) {
      const tracker = byRid.get(rid);
      const picked = pickDeltaOnly(evt);
      if (picked) {
        tracker.buf += picked;

        // Ранний синтез по завершённым фразам
        if (EARLY_TTS) {
          const { complete, rest } = cutCompleteSentences(tracker.buf, MIN_SENTENCE, CHUNK_TEXT_MAX);
          tracker.buf = rest;
          for (const seg of complete) await enqueueSynth(seg, rid, tracker);
        }
      }
    }

    // Завершение ответа
    if (rid && (type === "response.done" || type === "response.completed")) {
      generating = false;
      if (activeRid === rid) activeRid = null;

      if (USE_INWORLD && byRid.has(rid)) {
        const tracker = byRid.get(rid);
        try {
          const tail = sanitize(tracker.buf);
          tracker.buf = "";
          if (isSpeakable(tail)) {
            for (const seg of chunkText(tail, CHUNK_TEXT_MAX)) await enqueueSynth(seg, rid, tracker);
          } else if (!tracker.started) {
            console.log("No speakable text to synth (skipping audio).");
          }

          // Закрываем аудиопоток
          await tracker.speakChain.then(() => {
            client.send(JSON.stringify({
              type: `${AUDIO_EVENT_PREFIX}.done`,
              response_id: rid,
              ...(tracker.itemId ? { item_id: tracker.itemId } : {}),
              output_index: tracker.outputIndex
            }));
          }).catch(e => console.error("speakChain tail error:", e));
        } finally {
          byRid.delete(rid);
        }
      }

      // Проксируем done клиенту
      client.send(JSON.stringify(evt), { binary: false });
      return;
    }

    // Прочие события — проксируем
    client.send(JSON.stringify(evt), { binary: false });

    // Локальная: постановка сегмента в очередь синтеза
    async function enqueueSynth(rawSeg, rid, tracker) {
      const seg = sanitize(rawSeg);
      if (!isSpeakable(seg)) return;

      logSeg("SAY", rid, seg);
      tracker.speakChain = tracker.speakChain.then(async () => {
        try {
          const pcm = FAKE_TONE
            ? makeSinePcm16(900, 900, INWORLD_SR)
            : await synthesizeWithInworld(seg, INWORLD_VOICE, INWORLD_MODEL, INWORLD_LANG, INWORLD_SR);
          await streamPcm16ToClient(client, pcm, rid, tracker.itemId, tracker.outputIndex, !tracker.started);
          tracker.started = true;
        } catch (e) {
          console.error("synth error:", e?.message || e);
        }
      }).catch(e => console.error("speakChain error:", e));
    }
  });

  // Инициализация сессии
  upstream.on("open", () => {
    console.log("upstream open");
    const session = {
      modalities: USE_INWORLD ? ["text"] : ["audio","text"],
      input_audio_format: "pcm16",
      output_audio_format: { type: "pcm16", sample_rate: INWORLD_SR, channels: 1 }
    };
    if (!USE_INWORLD) session.voice = voice;
    upstream.send(JSON.stringify({ type: "session.update", session }));
  });

  // Помощник: безопасный запуск response.create сервером (в авто-режиме)
  function safeCreateResponse(source) {
    if (upstream.readyState !== WebSocket.OPEN) return;
    const payload = {
      type: "response.create",
      response: {
        modalities: USE_INWORLD ? ["text"] : ["audio","text"],
        instructions: currentInstructions || defaultRusGuard()
      }
    };
    if (generating) {
      try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {}
    }
    console.log(`send ${source} response.create`);
    try { upstream.send(JSON.stringify(payload)); } catch {}
  }

  const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {}; };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", (e) => console.error("upstream error:", e.message));
});

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

// ===== TEXT utils (ТОЛЬКО дельты) =====
function pickDeltaOnly(evt) {
  const type = evt?.type || "";
  // Типовые дельты Realtime
  if (type === "response.output_text.delta" && typeof evt.delta === "string") return evt.delta;
  if (type === "response.text.delta" && typeof evt.delta === "string") return evt.delta;
  if (type === "response.content.part.delta" && typeof evt.delta === "string") return evt.delta;

  // ВАЖНО: НЕ использовать evt.part.text — это часто накопительный текст и даёт повторы
  return "";
}

function sanitize(s){ return String(s).replace(/\s+/g, " ").trim(); }
function isSpeakable(s){ return /[\p{L}\p{N}]/u.test(s); }

// Инструкции RU-guard
function defaultRusGuard() {
  return ALWAYS_RU ? "Всегда отвечай и говори по‑русски." : "";
}
function mergeRusGuard(instr) {
  const base = String(instr || "").trim();
  if (!ALWAYS_RU) return base;
  const hasRu = /русск/i.test(base);
  return hasRu ? base : (base ? base + " " : "") + defaultRusGuard();
}

// Разделение текста на завершённые фразы
function cutCompleteSentences(input, minChars = 6, hardMax = 300) {
  const t = sanitize(input);
  if (!t) return { complete: [], rest: "" };
  const out = [];
  let last = 0;
  const re = /([.!?…]+)(\s+|$)/g;
  let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[1].length;
    const seg = t.slice(last, end).trim();
    if (seg.length >= minChars || /[!?]/.test(seg)) {
      out.push(seg);
      last = m.index + m[0].length;
    }
  }
  const rest = t.slice(last).trim();
  if (rest.length > hardMax) {
    const parts = chunkText(rest, hardMax);
    return { complete: out.concat(parts.slice(0, -1)), rest: parts.at(-1) || "" };
  }
  return { complete: out, rest };
}
function chunkText(input, max = 300) {
  const t = sanitize(input);
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
function logSeg(tag, rid, seg){
  const s = seg.length > 140 ? seg.slice(0,140)+"..." : seg;
  console.log(`[${tag}] rid=${rid} "${s}"`);
}

// ===== STREAM PCM (пре-буфер) =====
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
      await wait(1);
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

// ===== Inworld TTS =====
async function synthesizeWithInworld(text, voiceId, modelId, lang, targetSr = 16000) {
  if (!isSpeakable(text)) throw new Error("synthesizeWithInworld: empty/unspeakable text");

  const payload = {
    text, voiceId, modelId, language: lang,
    format: "wav", audioFormat: "wav", container: "wav",
    encoding: "LINEAR16", audioEncoding: "LINEAR16",
    sampleRate: targetSr, sampleRateHertz: targetSr, channels: 1,
    audio: { format: "wav", sampleRate: targetSr, channels: 1 },
    audioConfig: { audioFormat: "wav", audioEncoding: "LINEAR16", sampleRateHertz: targetSr, channels: 1 },
    locale: lang,
    style: process.env.INWORLD_STYLE || "neutral",
    emotion: process.env.INWORLD_EMOTION || "calm",
    speakingRate: Number(process.env.INWORLD_RATE || 1.0),
    pitch: Number(process.env.INWORLD_PITCH || 0)
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

  // WAV
  if (looksLikeWav(buf)) {
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
    return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
  }

  // JSON: audioContent/URL/base64
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

// ===== WAV/Audio helpers =====
function looksLikeWav(buf) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
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

// ===== JSON helpers =====
function looksLikeBase64Loose(s){ return typeof s === "string" && s.length > 32 && /^[A-Za-z0-9+/_=:\s-]+$/.test(s); }
function stripDataPrefix(s){ const i = s.indexOf("base64,"); return i >= 0 ? s.slice(i + 7) : s; }
function decodeBase64Loose(s){
  const clean = stripDataPrefix(String(s || "").trim()).replace(/[^\w/+==\-_:]/g, "");
  return Buffer.from(clean, "base64");
}
function findAudioContent(json) {
  if (!json || typeof json !== "object") return null;
  const candidates = [
    json.audioContent,
    json.audio?.content,
    json.data?.[0]?.audioContent,
    json.result?.audioContent,
    json.media?.audioContent
  ];
  for (const c of candidates) if (looksLikeBase64Loose(c)) return c;
  return null;
}
function findWavBase64InJson(json) {
  let found = null;
  (function scan(obj){
    if (!obj || typeof obj !== "object" || found) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && looksLikeBase64Loose(v)) {
        const buf = decodeBase64Loose(v);
        if (looksLikeWav(buf)) { found = buf; return; }
      } else if (typeof v === "object") scan(v);
    }
  })(json);
  return found;
}
function extractAudioUrl(json) {
  let url = null;
  (function scan(obj){
    if (!obj || typeof obj !== "object" || url) return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" && /^https?:\/\//i.test(v) && /(\.wav(\?|$)|audio\/wav)/i.test(v)) { url = v; return; }
      else if (typeof v === "object") scan(v);
    }
  })(json);
  return url;
}
