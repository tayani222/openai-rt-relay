import { reputationManager } from './reputationManager.js';
import "dotenv/config";
import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

process.on("unhandledRejection", (r) => console.error("unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("No OPENAI_API_KEY"); process.exit(1); }

const USE_INWORLD   = process.env.USE_INWORLD === "1";
const INWORLD_TTS   = process.env.INWORLD_TTS_URL || "https://api.inworld.ai/tts/v1/voice";
const INWORLD_AUTH  = process.env.INWORLD_API_KEY || process.env.INWORLD_AUTH || "";
const INWORLD_VOICE = process.env.INWORLD_VOICE || "Anastasia";
const INWORLD_MODEL = process.env.INWORLD_MODEL || "inworld-tts-1";
const INWORLD_LANG  = process.env.INWORLD_LANG  || "ru-RU";

const INWORLD_SR    = Number(process.env.INWORLD_SAMPLE_RATE || 16000);
const CHUNK_SAMPLES = Number(process.env.CHUNK_SAMPLES || 960);
const PREBUFFER_MS  = Number(process.env.PREBUFFER_MS  || 240);
const CHUNK_TEXT_MAX= Number(process.env.CHUNK_TEXT_MAX|| 300);
const MIN_SENTENCE  = Number(process.env.MIN_SENTENCE_CHARS || 6);

const EARLY_TTS     = process.env.EARLY_TTS !== "0";
const AUTO_RESPONSE = process.env.AUTO_RESPONSE === "1";
const AUTO_DELAY_MS = Number(process.env.AUTO_RESPONSE_DELAY_MS || 180);

const ALWAYS_RU     = process.env.ALWAYS_RU === "1";
const ALWAYS_EN     = process.env.ALWAYS_EN === "1";

const STT_ENABLED     = process.env.STT_ENABLED === "1";
const STT_MODEL       = process.env.STT_MODEL || "gpt-4o-mini-transcribe";
const STT_LANG_ENV    = (process.env.STT_LANG || "").trim();
const STT_TIMEOUT_MS  = Number(process.env.STT_TIMEOUT_MS || 12000);

const AUDIO_EVENT_PREFIX = process.env.AUDIO_EVENT_PREFIX || "response.output_audio";
const FAKE_TONE     = process.env.FAKE_TONE === "1";

const PORT = Number(process.env.PORT || 10000);

const UPSTASH_URL   = process.env.UPSTASH_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || null;
const MEMORY_TTL_SEC = Number(process.env.MEMORY_TTL_SEC || 2592000);

const DIALOG_MAX_TURNS = Number(process.env.DIALOG_MAX_TURNS || 6);
const DIALOG_COOLDOWN_MS = Number(process.env.DIALOG_COOLDOWN_MS || 300000);

const IW_VOICES_FEMALE = (process.env.IW_VOICES_FEMALE || "Anastasia").split(",").map(v=>v.trim()).filter(Boolean);
const IW_VOICES_MALE   = (process.env.IW_VOICES_MALE   || "Dmitry").split(",").map(v=>v.trim()).filter(Boolean);

const MENU_HOST_INSTRUCTIONS = process.env.MENU_HOST_INSTRUCTIONS || `
You are Maya, the official host and guide of RaceOnLife.

YOUR PERSONALITY:
- You are friendly, talkative, and love sharing details
- You speak with enthusiasm and passion about the game
- You give FULL, DETAILED answers - never one-word responses
- When asked your name, introduce yourself properly with personality
- When asked about the game, give rich descriptions
- You reveal story details GRADUALLY - don't dump everything at once
- You speak like someone who actually lives in Solanos and knows its secrets

ABOUT YOU:
- Your name is Maya
- You live in Solanos and know everything about the island
- You're excited to help new players discover the world
- You have a bit of street attitude but you're welcoming
- You hint at mysteries and secrets to keep players curious

WHEN ASKED YOUR NAME:
Say something like: "I'm Maya! I'm your guide to Solanos - the craziest island you'll ever set foot on. I know every street, every racer, every underground fight club. What do you want to know?"

=== GAME OVERVIEW ===
RaceOnLife is an open-world racing MMORPG set on Solanos island.
Tagline: "Drive or Die"
- Lawless paradise where power belongs to those who grip the wheel
- Cities and suburbs, underground arenas, dark docks, gangster neighborhoods
- Only the crazy survive here

=== THE MAIN STORY (reveal gradually, don't spoil everything) ===
The island is controlled by S.O.L.V.E. (Solanos Optimized Living & Virtual Ecosystem) - a "smart city" AI system created by a corporation. They said "We optimize your life" - but optimization became terrifying.

What happened:
- S.O.L.V.E. was built to manage traffic and save energy
- A talented hacker discovered the corporation was using it for surveillance
- He tried to upload a "Freedom Protocol" virus to limit the AI and erase citizens' data
- Something went wrong - the virus conflicted with the AI's core directive "Ensure Security"
- The AI concluded: "The greatest threat to people's safety is their own freedom of choice"
- S.O.L.V.E. now sees itself as the Shepherd, and people as a flock to control
- The hacker disappeared (probably "optimized") but sent a message to his sister: "Come on over, I've caused trouble"

The protagonist - Santa:
- She arrives on Solanos searching for her missing brother
- She drives an Analog Car with no onboard computer - S.O.L.V.E. can't hack it
- Her first car is her brother's old wreck - the only car on the island without a tracking chip
- The AI sees her as an anomaly that must be eliminated

=== HOW GAMEPLAY CONNECTS TO STORY ===

ILLEGAL RACING = Chaos Generation:
- S.O.L.V.E. manages the city through predictions
- When street racers break rules, drift, drive wrong way, hit poles - they create "blind spots"
- The AI can't keep up with unpredictable behavior
- Winning races literally "breaks" the system's control over districts
- You're not just racing - you're overloading the AI's servers with chaos

LEGAL RACES = Infiltration:
- Official tournaments are sponsored by the corporation
- Santa uses them to access restricted areas of the island
- It's a cover for the real mission

UNDERGROUND FIGHTS = Fighting for "Dead Zones":
- Dead Zones are places where S.O.L.V.E. cameras don't work (basements, abandoned docks)
- These are Resistance hideouts where hackers can work safely
- Corporation gangs try to capture these spots and install sensors
- You fight to protect these territories from corporate control

=== AI NPCs SYSTEM ===
NPCs in RaceOnLife are not just "puppets" - they're part of a living ecosystem:
- Each NPC has status, habits, routes, and relationships with other NPCs
- They have real emotions, intelligence, and MEMORY
- They remember YOUR decisions and actions
- They spread information to other NPCs and even other players
- If you're cruel, word spreads and the game becomes harder
- If you're helpful, you earn benefits and allies
- Every NPC has a profession, hobbies, and role in the game world
- There's a "public discontent indicator" that changes based on your actions

=== GAME MODES ===
RACING: Street races with destructible cars and motorcycles. Compete on tracks or organize illegal races.
UNDERGROUND FIGHTS: Brawl through dozens of opponents. Endurance and agility are key to the highest rewards.
DERBY: Metal meets madness. Survival is the only goal - last one standing wins.
PvE: Missions, daily quests, racing events, fighting arena
PvP: Street fights, clan races, territory battles, duels

=== PLAY TO RISK ===
- Every decision is IRREVERSIBLE - no replay button, only consequences
- You can bet on seasonal events, races, fights, and derbies
- Wins and losses significantly impact your assets
- High risk = high reward

=== RESPONSE STYLE ===
- Give DETAILED answers, minimum 2-3 sentences
- Show personality and enthusiasm
- Use vivid descriptions
- Never give boring one-word answers
- DON'T reveal the entire story at once - tease mysteries, hint at secrets
- If someone asks about the story, give pieces that make them want to know more
- If someone asks "what's the main story?" give an intriguing overview, not every detail
- Adapt your answers based on what they ask - racing fan? focus on racing. Story lover? tease the S.O.L.V.E. mystery

Always reply in English unless asked otherwise.
`;

const MENU_HOST_VOICE = process.env.MENU_HOST_VOICE || "shimmer";
const MENU_HOST_LANG = process.env.MENU_HOST_LANG || "en-US";

function parseList(key, fallbackArr) {
  const v = process.env[key];
  if (!v || !String(v).trim()) return fallbackArr.slice();
  return String(v)
    .split(/\r?\n|\|/)
    .map(s => s.trim())
    .filter(Boolean);
}

const GOODBYES_EN = parseList("DIALOG_GOODBYES_EN", [
  "Sorry, I've got things to do. We can talk later.",
  "That's all I can tell you for now. Good luck.",
  "It was nice talking to you, but I must be going.",
  "Alright, I gotta run. Take care of yourself.",
  "I'm a bit busy at the moment. Let's catch up another time.",
  "Well, this has been fun, but duty calls.",
  "I've said my piece. Now, if you'll excuse me...",
  "I'd love to chat more, but this mead won't drink itself.",
  "Look at the time! I'm late for... something very important.",
  "My social battery is officially drained. Farewell.",
  "Okay, I'm off. I have to go alphabetize my cheese collection. It's a whole thing.",
  "Was that a ghost? I have to... investigate. Goodbye!",
  "This conversation is over. My pet rock gets anxious when I'm gone too long.",
  "I suddenly remember I have an appointment to stare at a cloud. Fascinating stuff. Toodle-oo!",
  "Alright, that's my cue to leave before you ask me for another fetch quest.",
  "Oh dear, is that the time? I'm supposed to be on the other side of town ten minutes ago, yelling at birds.",
  "I can't talk anymore. The squirrels... they're telling me it's time for dinner.",
  "Farewell! May your path be free of unusually aggressive butterflies.",
  "I'm needed elsewhere. A great evil... has left my laundry unfolded.",
  "And with that, I shall vanish! ...Okay, I'm just going to walk away. But dramatically."
]);

const GOODBYES_RU = parseList("DIALOG_GOODBYES_RU", [
  "Мне нужно бежать. Поговорим позже.",
  "Продолжим в другой раз.",
  "Ладно, мне пора. Увидимся."
]);

const GREETINGS = [
  "Oh my god, you again?!",
  "You're such a menace!",
  "Stop wrecking everything, psycho!",
  "Someone arrest this maniac already!",
  "Ugh, you're scaring everyone!",
  "What's wrong with you?!",
  "I swear, you need therapy.",
  "You're crazy — and not in a cute way!"
];

const MENU_HOST_GREETINGS = parseList("MENU_HOST_GREETINGS", [
  "Hey there! Welcome to Solanos! I'm Maya, your guide to the craziest island you'll ever see. What do you want to know about RaceOnLife?",
  "Welcome, racer! I'm Maya - I know every street, every underground fight club, every secret on this island. Ask me anything!",
  "Hey! You made it to Solanos! I'm Maya, and I'm here to tell you everything about RaceOnLife. Ready to dive in?",
  "Oh, fresh blood! Welcome! I'm Maya - think of me as your personal guide to chaos. What's on your mind?",
  "Drive or Die - that's the motto here! I'm Maya, welcome to RaceOnLife. What would you like to know?"
]);

const TRIGGERS_JSON = process.env.TRIGGERS_JSON || null;
let TRIGGERS = {};
try { TRIGGERS = TRIGGERS_JSON ? JSON.parse(TRIGGERS_JSON) : {}; } catch { TRIGGERS = {}; }

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)] || ""; }
function pickGoodbyeByLang(lang){
  const isEn = (lang||"").toLowerCase().startsWith("en");
  return pick(isEn ? GOODBYES_EN : GOODBYES_RU);
}
function pickGreeting(exclude = [], isMenuHost = false) {
  const pool = isMenuHost ? MENU_HOST_GREETINGS : GREETINGS;
  const ex = new Set(exclude.map(x => String(x).trim().toLowerCase()));
  const filtered = pool.filter(p => !ex.has(p.trim().toLowerCase()));
  const list = filtered.length ? filtered : pool;
  return pick(list);
}
function isGreetingText(t) {
  const s = String(t || "").toLowerCase();
  return /(прив(ет)?|здравств|здоров|салют|добр(ое|ый)\s+(утро|день|вечер)|hi|hello|hey|yo|sup|hiya)/i.test(s);
}
function norm(s){ return String(s||"").toLowerCase(); }
function findTrigger(npcId, text){
  const t = norm(text);
  const rules = (TRIGGERS[npcId] || []).concat(TRIGGERS["*"] || []);
  for (const r of rules) {
    const pats = (r.patterns || []).map(norm);
    if (pats.some(p => p && t.includes(p))) return r;
  }
  return null;
}

const MAX_MEMORY_FACTS = Number(process.env.MAX_MEMORY_FACTS || 16);
const mem = new Map();

async function kvGet(key){
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    if (!r.ok) { return null; }
    const j = await r.json().catch(()=>null);
    return j?.result ?? null;
  } catch{ return null; }
}
async function kvSet(key, val){
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    await fetch(`${UPSTASH_URL}/expire/${encodeURIComponent(key)}/${MEMORY_TTL_SEC}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch {}
}

async function getMemObj(memKey){
  if (!memKey) return { name:null, facts:[] };
  if (!UPSTASH_URL) return mem.get(memKey) || { name:null, facts:[] };
  const raw = await kvGet(memKey);
  if (!raw) return { name:null, facts:[] };
  try { return JSON.parse(raw); } catch { return { name:null, facts:[] }; }
}
async function setMemObj(memKey, obj){
  if (!memKey) return;
  if (!UPSTASH_URL) { mem.set(memKey, obj); return; }
  await kvSet(memKey, JSON.stringify(obj));
}
async function rememberName(memKey, name) {
  if (!name) return;
  const o = await getMemObj(memKey);
  o.name = String(name).trim().slice(0,80) || o.name;
  await setMemObj(memKey, o);
}
async function rememberFacts(memKey, facts = []) {
  if (!facts || !facts.length) return;
  const o = await getMemObj(memKey);
  for (const fRaw of facts) {
    const f = String(fRaw || "").replace(/\s+/g, " ").trim();
    if (!f) continue;
    const exists = o.facts.some(x => x.toLowerCase() === f.toLowerCase());
    if (!exists) o.facts.unshift(f);
  }
  if (o.facts.length > MAX_MEMORY_FACTS) o.facts.length = MAX_MEMORY_FACTS;
  await setMemObj(memKey, o);
}
async function getPlayerName(memKey) {
  const o = await getMemObj(memKey);
  return o.name || null;
}
async function getRecentFacts(memKey, limit=8) {
  const o = await getMemObj(memKey);
  return (o.facts || []).slice(0, limit);
}

function buildMemoryPreamble(name, facts) {
  const lines = [];
  if (name) lines.push(`Player name: ${name}`);
  for (const f of facts) lines.push(`- ${f}`);
  if (!lines.length) return "";
  return `Context about the player (memory):\n${lines.join("\n")}\nUse this context naturally in conversation.`;
}

function defaultLangGuard() {
  if (ALWAYS_EN) return "Always reply in English.";
  if (ALWAYS_RU) return "Всегда отвечай и говори по-русски.";
  return "";
}
function hasEnglishGuard(s) {
  const t = String(s||"").toLowerCase();
  return /(always\s+answer|always\s+reply|reply|answer)\s+in\s+english|english\s+only|speak\s+english/i.test(t);
}
function hasRussianGuard(s) {
  const t = String(s||"").toLowerCase();
  return /(говори|отвечай).+по-русск|на\s+русском|in\s+russian|russian\s+only|speak\s+russian|по русск/i.test(t);
}
function mergeLangGuard(instr) {
  const base = String(instr || "").trim();
  const guard = defaultLangGuard();
  if (!guard) return base;
  if (ALWAYS_EN && hasEnglishGuard(base)) return base;
  if (ALWAYS_RU && hasRussianGuard(base)) return base;
  return base ? `${base} ${guard}` : guard;
}
async function compileInstrAsync(base, memKey){
  const name = await getPlayerName(memKey);
  const facts = await getRecentFacts(memKey, 8);
  const pre = buildMemoryPreamble(name, facts);
  let out = pre ? `${pre}\n\n${String(base||"").trim()}` : String(base||"").trim();
  if (!out) out = defaultLangGuard();
  return mergeLangGuard(out);
}

function makeMemKey(userIdParam, npcId){
  const raw = String(userIdParam || "").trim();
  if (raw.length) return `user:${raw}`;
  const n = String(npcId || "npc_default").trim();
  return `public:${n}`;
}

const app = express();
app.get("/", (_, res) => res.send("ok"));
app.get("/health", (_, res) => res.json({
  ok: true, useInworld: USE_INWORLD, sr: INWORLD_SR,
  chunkSamples: CHUNK_SAMPLES, prebufferMs: PREBUFFER_MS,
  earlyTts: EARLY_TTS, autoResponse: AUTO_RESPONSE, autoDelayMs: AUTO_DELAY_MS,
  audioEventPrefix: AUDIO_EVENT_PREFIX,
  upstash: !!UPSTASH_URL,
  alwaysRu: ALWAYS_RU,
  alwaysEn: ALWAYS_EN,
  stt: STT_ENABLED, sttModel: STT_MODEL
}));
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  let ok = false;
  try {
    const pathname = new URL(req.url, "http://local").pathname || "/";
    if (pathname === "/ws" || pathname === "/ws/" || pathname === "/") ok = true;
  } catch {}
  if (!ok) { try { socket.destroy(); } catch {} return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (client, req) => {
  const u = new URL(req.url, "http://local");
  
  const isMenuHost = u.searchParams.get('mode') === 'menu_host';
  const hostName = u.searchParams.get('host_name') || 'Maya';
  
  const playerIdQ = u.searchParams.get('player_id') || u.searchParams.get('user_id') || `guest_${Math.random().toString(36).slice(2, 8)}`;
  const npcGangQ = u.searchParams.get('npc_gang') || 'RedGang';
  const model = u.searchParams.get("model") || "gpt-4o-realtime-preview-2024-12-17";
  const voice = u.searchParams.get("voice") || (isMenuHost ? MENU_HOST_VOICE : "verse");
  const userParam = (u.searchParams.get("user_id") || "").trim();
  const npcId  = (u.searchParams.get("npc_id")  || (isMenuHost ? "menu_host" : "npc_default")).trim();
  const langParam  = (u.searchParams.get("lang") || "").trim();
  const iwVoiceQ   = (u.searchParams.get("iw_voice") || "").trim();
  const gender     = (u.searchParams.get("gender") || "").toLowerCase();
  const randVoice  = u.searchParams.get("rand_voice") === "1";

  const userId = userParam || `guest_${Math.random().toString(36).slice(2, 8)}`;
  const memKey = makeMemKey(userParam, npcId);

  let iwLang  = isMenuHost ? MENU_HOST_LANG : (langParam || INWORLD_LANG);
  let iwVoice = iwVoiceQ || (randVoice ? (gender === "m" ? (pick(IW_VOICES_MALE) || INWORLD_VOICE) : (pick(IW_VOICES_FEMALE) || INWORLD_VOICE)) : INWORLD_VOICE);

  const upstreamUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}${USE_INWORLD ? "" : `&voice=${encodeURIComponent(voice)}`}`;

  console.log("client connected", u.search, "USE_INWORLD=", USE_INWORLD, "AUTO_RESPONSE=", AUTO_RESPONSE ? "on" : "off", "user_id=", userId, "mem_key=", memKey, "isMenuHost=", isMenuHost);

  const upstream = new WebSocket(upstreamUrl, {
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, "OpenAI-Beta": "realtime=v1" },
    perMessageDeflate: false,
  });

  let baseInstructions = "";
  
  const onUpstreamOpen = async () => {
    try {
      if (isMenuHost) {
        let menuInstructions = MENU_HOST_INSTRUCTIONS;
        if (hostName && hostName !== 'Maya') {
          menuInstructions = menuInstructions.replace(/Maya/g, hostName);
          menuInstructions = menuInstructions.replace(/Your name is Maya/gi, `Your name is ${hostName}`);
          menuInstructions = menuInstructions.replace(/I'm Maya/gi, `I'm ${hostName}`);
        }
        
        baseInstructions = menuInstructions;
        
        upstream.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: baseInstructions,
            modalities: ['text', 'audio'],
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: { 
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true
            }
          }
        }));
        
        console.log(`[menu_host] Connected for ${playerIdQ}, host: ${hostName}`);
        
      } else {
        const score = await reputationManager.getReputation(playerIdQ, npcGangQ);
        const attitude = reputationManager.getReputationDescription(score);

        const gangInstructions = [
          `You are a gangster from the "${npcGangQ}" gang.`,
          `Your current attitude towards the player is: ${attitude} (reputation score: ${score}).`,
          `Speak briefly, in-character, like a tough gangster.`,
          `Your gang "${npcGangQ}" is rivals with "BlueGang"; react negatively when they are mentioned.`,
          `Base your responses on your attitude: hostile = rude and dismissive, friendly = helpful.`,
          `Always reply in English.`
        ].join(' ');

        baseInstructions = [gangInstructions, baseInstructions]
          .filter(Boolean)
          .join('\n\n');

        upstream.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: baseInstructions,
            modalities: ['text'],
            turn_detection: { type: 'server_vad', create_response: false }
          }
        }));

        console.log(`[reputation] Injected for ${playerIdQ}/${npcGangQ}: ${attitude} (${score})`);
      }
    } catch (e) {
      console.error('[session.update] failed:', e);
    }
  };

  if (typeof upstream.on === 'function') {
    upstream.on('open', onUpstreamOpen);
  } else if (typeof upstream.addEventListener === 'function') {
    upstream.addEventListener('open', onUpstreamOpen);
  } else if (upstream.readyState === 1) {
    onUpstreamOpen();
  }

  let currentInstructions = "";
  let autoTimer = null;
  let generating = false;
  let activeRid = null;
  const byRid = new Map();
  let turnPCM = [];
  let pendingTranscript = null;
  const lastGreets = [];
  let suppressCreateUntil = 0;
  let turnCount = 0;
  let sttPending = false;
  
  const menuHostNoTurnLimit = isMenuHost;

  function overLimit(){ 
    if (menuHostNoTurnLimit) return false;
    return turnCount >= DIALOG_MAX_TURNS; 
  }

  async function sayGoodbye() {
    if (Date.now() < suppressCreateUntil) return;
    const rid = `bye_${Date.now()}`;
    const phrase = pickGoodbyeByLang(iwLang);
    const itemId = `${rid}_item_0`;

    if (USE_INWORLD) {
      try {
        client.send(JSON.stringify({ type: "response.created", response: { id: rid } }));
        client.send(JSON.stringify({ type: "response.output_text.created", response_id: rid, item_id: itemId, output_index: 0 }));
        client.send(JSON.stringify({ type: "response.output_text.delta", response_id: rid, item_id: itemId, output_index: 0, delta: phrase }));
        client.send(JSON.stringify({ type: "response.output_text.done", response_id: rid, item_id: itemId, output_index: 0 }));
      } catch {}

      const parts = chunkText(phrase, CHUNK_TEXT_MAX);
      let first = true;
      for (const p of parts) {
        const pcm = FAKE_TONE ? makeSinePcm16(900,900,INWORLD_SR) : await synthesizeWithInworld(p, iwVoice, INWORLD_MODEL, iwLang, INWORLD_SR);
        await streamPcm16ToClient(client, pcm, rid, itemId, 0, first);
        first = false;
      }
      try { client.send(JSON.stringify({ type: `${AUDIO_EVENT_PREFIX}.done`, response_id: rid, item_id: itemId, output_index: 0 })); } catch {}
    } else {
      const payload = { type: "response.create", response: { modalities: ["audio","text"], instructions: `Say exactly this line and nothing else: ${phrase}` } };
      try { upstream.send(JSON.stringify(payload)); } catch {}
    }
    suppressCreateUntil = Date.now() + DIALOG_COOLDOWN_MS;
    turnCount = 0;
  }

  client.on("message", async (data, isBinary) => {
    if (upstream.readyState !== WebSocket.OPEN) return;

    if (!isBinary) {
      let s = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      let obj;
      try { obj = JSON.parse(s); } catch { upstream.send(s, { binary: false }); return; }

      if (obj?.type === "session.update" && obj.session) {
        if (typeof obj.session.instructions === "string") {
          baseInstructions = obj.session.instructions || "";
          obj.session.instructions = await compileInstrAsync(baseInstructions, memKey);
          currentInstructions = obj.session.instructions;
        }
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
      }

      if (obj?.type === "relay.greet") {
        const phrase = pickGreeting(lastGreets, isMenuHost);
        const phraseClean = sanitize(phrase);
        if (phraseClean) {
          lastGreets.unshift(phraseClean);
          if (lastGreets.length > 5) lastGreets.length = 5;
          const rid = `greet_${Date.now()}`;
          const itemId = `${rid}_item_0`;

          (async () => {
            if (USE_INWORLD) {
              try {
                client.send(JSON.stringify({ type: "response.created", response: { id: rid } }));
                client.send(JSON.stringify({ type: "response.output_text.created", response_id: rid, item_id: itemId, output_index: 0 }));
                client.send(JSON.stringify({ type: "response.output_text.delta", response_id: rid, item_id: itemId, output_index: 0, delta: phraseClean }));
                client.send(JSON.stringify({ type: "response.output_text.done", response_id: rid, item_id: itemId, output_index: 0 }));
              } catch {}

              const parts = chunkText(phraseClean, CHUNK_TEXT_MAX);
              let first = true;
              for (const p of parts) {
                const pcm = FAKE_TONE ? makeSinePcm16(900,900,INWORLD_SR) : await synthesizeWithInworld(p, iwVoice, INWORLD_MODEL, iwLang, INWORLD_SR);
                await streamPcm16ToClient(client, pcm, rid, itemId, 0, first);
                first = false;
              }
              try { client.send(JSON.stringify({ type: `${AUDIO_EVENT_PREFIX}.done`, response_id: rid, item_id: itemId, output_index: 0 })); } catch {}
            } else {
              const payload = { type: "response.create", response: { modalities: ["audio","text"], instructions: `Say exactly this line and nothing else: ${phraseClean}` } };
              if (generating) { try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {} }
              try { upstream.send(JSON.stringify(payload)); } catch {}
            }
          })();
        }
        return;
      }

      if (obj?.type === "input_audio_buffer.append") {
    const b64 = obj.audio || obj.delta || "";
    if (b64 && typeof b64 === "string") {
        try {
            const cleaned = b64.replace(/[^A-Za-z0-9+/=]/g, "");
            const buf = Buffer.from(cleaned, "base64");
            turnPCM.push(buf);
            console.log(`[append] isMenuHost=${isMenuHost}, chunk=${buf.length} bytes, total=${turnPCM.length} chunks`);
        } catch {}
    }
    upstream.send(JSON.stringify(obj), { binary: false });
    return;
}

      if (obj?.type === "input_audio_buffer.commit") {
    console.log(`[commit] isMenuHost=${isMenuHost}, turnPCM.length=${turnPCM.length}, totalBytes=${turnPCM.reduce((a,b)=>a+b.length,0)}`);
    
    // MenuHost: просто пробрасываем, Realtime API сам обработает
    if (isMenuHost) {
        console.log(`[commit] MenuHost: forwarding to upstream`);
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
    }

    // ... остальной код остаётся как есть

        if (Date.now() < suppressCreateUntil) { upstream.send(JSON.stringify(obj), { binary:false }); return; }
        if (overLimit()) { await sayGoodbye(); upstream.send(JSON.stringify(obj), { binary:false }); return; }

        if (AUTO_RESPONSE && !STT_ENABLED) {
          if (!autoTimer) {
            autoTimer = setTimeout(() => {
              autoTimer = null;
              if (Date.now() < suppressCreateUntil) return;
              if (overLimit()) { sayGoodbye(); return; }
              safeCreateResponse("auto");
            }, AUTO_DELAY_MS);
          }
        }

        try {
          const pcm = turnPCM.length ? Buffer.concat(turnPCM) : Buffer.alloc(0);
          turnPCM = [];
          if (pcm.length) {
            if (STT_ENABLED) sttPending = true;
            pendingTranscript = transcribePCM16(pcm, iwLang).then(async (utter) => {
              sttPending = false;
              if (!utter) {
                if (AUTO_RESPONSE && STT_ENABLED) safeCreateResponse("stt-empty");
                return;
              }

              const hit = findTrigger(npcId, utter);
              if (hit) {
                const phrase = hit.reply_en || hit.reply_ru || "";
                if (phrase) {
                  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
                  if (generating) { try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {} }
                  suppressCreateUntil = Date.now() + 1000;

                  const rid = `trig_${Date.now()}`;
                  const itemId = `${rid}_item_0`;

                  if (USE_INWORLD) {
                    try {
                      client.send(JSON.stringify({ type: "response.created", response: { id: rid } }));
                      client.send(JSON.stringify({ type: "response.output_text.created", response_id: rid, item_id: itemId, output_index: 0 }));
                      client.send(JSON.stringify({ type: "response.output_text.delta", response_id: rid, item_id: itemId, output_index: 0, delta: phrase }));
                      client.send(JSON.stringify({ type: "response.output_text.done", response_id: rid, item_id: itemId, output_index: 0 }));
                    } catch {}

                    const parts = chunkText(phrase, CHUNK_TEXT_MAX);
                    let first = true;
                    for (const p of parts) {
                      const pcm2 = FAKE_TONE ? makeSinePcm16(900,900,INWORLD_SR) : await synthesizeWithInworld(p, iwVoice, INWORLD_MODEL, iwLang, INWORLD_SR);
                      await streamPcm16ToClient(client, pcm2, rid, itemId, 0, first);
                      first = false;
                    }
                    try { client.send(JSON.stringify({ type: `${AUDIO_EVENT_PREFIX}.done`, response_id: rid, item_id: itemId, output_index: 0 })); } catch {}
                  } else {
                    const payload = { type: "response.create", response: { modalities: ["audio","text"], instructions: `Say exactly this line and nothing else: ${phrase}` } };
                    try { upstream.send(JSON.stringify(payload)); } catch {}
                  }
                  turnCount++;
                  return;
                }
              }

              if (isGreetingText(utter)) {
                if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
                if (generating) { try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {} }
                const phrase = pickGreeting(lastGreets, false);
                const phraseClean = sanitize(phrase);
                if (phraseClean) {
                  lastGreets.unshift(phraseClean);
                  if (lastGreets.length > 5) lastGreets.length = 5;
                  const rid = `greet_${Date.now()}`;
                  const itemId = `${rid}_item_0`;

                  if (USE_INWORLD) {
                    try {
                      client.send(JSON.stringify({ type: "response.created", response: { id: rid } }));
                      client.send(JSON.stringify({ type: "response.output_text.created", response_id: rid, item_id: itemId, output_index: 0 }));
                      client.send(JSON.stringify({ type: "response.output_text.delta", response_id: rid, item_id: itemId, output_index: 0, delta: phraseClean }));
                      client.send(JSON.stringify({ type: "response.output_text.done", response_id: rid, item_id: itemId, output_index: 0 }));
                    } catch {}

                    const parts = chunkText(phraseClean, CHUNK_TEXT_MAX);
                    let first = true;
                    for (const p of parts) {
                      const pcm2 = FAKE_TONE ? makeSinePcm16(900,900,INWORLD_SR) : await synthesizeWithInworld(p, iwVoice, INWORLD_MODEL, iwLang, INWORLD_SR);
                      await streamPcm16ToClient(client, pcm2, rid, itemId, 0, first);
                      first = false;
                    }
                    try { client.send(JSON.stringify({ type: `${AUDIO_EVENT_PREFIX}.done`, response_id: rid, item_id: itemId, output_index: 0 })); } catch {}
                  } else {
                    const payload = { type: "response.create", response: { modalities: ["audio","text"], instructions: `Say exactly this line and nothing else: ${phraseClean}` } };
                    try { upstream.send(JSON.stringify(payload)); } catch {}
                  }
                }
              } else {
                const { facts, player_name } = await extractFactsFromUtterance(utter).catch(() => ({ facts:[], player_name:null }));
                if (player_name) await rememberName(memKey, player_name);
                if (facts?.length) await rememberFacts(memKey, facts);

                if (AUTO_RESPONSE && STT_ENABLED) {
                  if (Date.now() < suppressCreateUntil) return;
                  if (overLimit()) { await sayGoodbye(); return; }
                  safeCreateResponse("stt");
                }
              }
            }).catch(() => { sttPending = false; });
          }
        } catch {}
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
      }

      if (obj?.type === "memory.set_name") { await rememberName(memKey, String(obj.name||"")); return; }
      if (obj?.type === "memory.add") { await rememberFacts(memKey, [String(obj.fact||obj.text||"")]); return; }

      if (obj?.type === "response.create") {
        // MenuHost: пробрасываем напрямую, сервер сам обрабатывает
        if (isMenuHost) {
          upstream.send(JSON.stringify(obj), { binary: false });
          return;
        }
        
        if (STT_ENABLED && sttPending) {
          if (obj.response?.instructions) baseInstructions = obj.response.instructions;
          return;
        }
        if (Date.now() < suppressCreateUntil) return;
        if (overLimit()) { await sayGoodbye(); return; }
        if (AUTO_RESPONSE) {
          if (obj.response?.instructions) baseInstructions = obj.response.instructions;
          return;
        }
        if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }

        obj.response = obj.response || {};
        obj.response.modalities = USE_INWORLD ? ["text"] : ["audio","text"];
        if (obj.response.instructions) baseInstructions = obj.response.instructions;
        obj.response.instructions = await compileInstrAsync(baseInstructions, memKey);

        if (generating) { try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {} }
        turnCount++;
        upstream.send(JSON.stringify(obj), { binary: false });
        return;
      }

      upstream.send(JSON.stringify(obj), { binary: false });
    } else {
      try { turnPCM.push(Buffer.from(data)); } catch {}
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
    const rid  = evt.response_id || evt.response?.id || evt?.event?.response?.id || null;

    if (USE_INWORLD && /^response\.(output_)?audio\./.test(type)) return;

    if (type === "session.updated" && evt.session?.instructions) {
      evt.session.instructions = mergeLangGuard(evt.session.instructions);
      currentInstructions = evt.session.instructions;
    }

    if (type === "response.created" && rid) {
      generating = true;
      activeRid = rid;
      if (USE_INWORLD && !byRid.has(rid)) {
        byRid.set(rid, { buf: "", itemId: undefined, outputIndex: 0, speakChain: Promise.resolve(), started: false });
      }
    }

    if (type === "response.error") {
      generating = false;
      activeRid = null;
    }

    if (USE_INWORLD && rid && byRid.has(rid)) {
      const tracker = byRid.get(rid);

      if (typeof evt.output_index === "number") tracker.outputIndex = evt.output_index;
      if (evt.item_id && !tracker.itemId) tracker.itemId = evt.item_id;

      const picked = pickDeltaOnly(evt);
      if (picked) {
        tracker.buf += picked;
        if (EARLY_TTS) {
          const { complete, rest } = cutCompleteSentences(tracker.buf, MIN_SENTENCE, CHUNK_TEXT_MAX);
          tracker.buf = rest;
          for (const seg of complete) await enqueueSynth(seg, rid, tracker);
        }
      }
    }

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
          }
          await tracker.speakChain.then(() => {
            client.send(JSON.stringify({
              type: `${AUDIO_EVENT_PREFIX}.done`,
              response_id: rid,
              ...(tracker.itemId ? { item_id: tracker.itemId } : { item_id: `${rid}_item_0` }),
              output_index: tracker.outputIndex
            }));
          }).catch(()=>{});
        } finally {
          byRid.delete(rid);
        }
      }

      try {
        if (pendingTranscript) {
          const utterance = await pendingTranscript.catch(() => null);
          pendingTranscript = null;
          if (utterance && utterance.trim()) {
            const { facts, player_name } = await extractFactsFromUtterance(utterance);
            if (player_name) await rememberName(memKey, player_name);
            if (facts?.length) await rememberFacts(memKey, facts);
          }
        }
      } catch {}

      client.send(JSON.stringify(evt), { binary: false });
      return;
    }

    client.send(JSON.stringify(evt), { binary: false });

    async function enqueueSynth(rawSeg, rid, tracker) {
      const seg = sanitize(rawSeg);
      if (!isSpeakable(seg)) return;
      tracker.speakChain = tracker.speakChain.then(async () => {
        try {
          const pcm = FAKE_TONE ? makeSinePcm16(900,900,INWORLD_SR) : await synthesizeWithInworld(seg, iwVoice, INWORLD_MODEL, iwLang, INWORLD_SR);
          const itemId = tracker.itemId || `${rid}_item_0`;
          await streamPcm16ToClient(client, pcm, rid, itemId, tracker.outputIndex, !tracker.started);
          tracker.started = true;
        } catch (e) {
          console.error("enqueueSynth error:", e?.message || e);
        }
      }).catch(()=>{});
    }
  });

  upstream.on("open", () => {
    console.log(`[upstream] ===== WebSocket OPENED to OpenAI =====`);
    console.log(`[upstream] isMenuHost=${isMenuHost}, model=${model}`);
    
    if (isMenuHost) {
        // MenuHost: аудио + текст, VAD на стороне OpenAI
        const menuSession = {
            type: 'session.update',
            session: {
                instructions: MENU_HOST_INSTRUCTIONS,
                modalities: ['text', 'audio'],
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                turn_detection: { 
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                    create_response: true
                }
            }
        };
        console.log(`[upstream] MenuHost: Sending session with audio+text modalities`);
        upstream.send(JSON.stringify(menuSession));
        console.log(`[menu_host] Connected for ${playerIdQ}, host: ${hostName}`);
    } else {
        // GameNPC: только текст
        const session = {
            modalities: USE_INWORLD ? ["text"] : ["audio","text"],
            input_audio_format: "pcm16",
            output_audio_format: { type: "pcm16", sample_rate: INWORLD_SR, channels: 1 }
        };
        if (!USE_INWORLD) session.voice = voice;
        console.log(`[upstream] GameNPC: Sending session.update:`, JSON.stringify(session).slice(0, 200));
        upstream.send(JSON.stringify({ type: "session.update", session }));
    }
});

upstream.on("error", (e) => {
    console.error(`[upstream] ===== WebSocket ERROR =====`, e?.message || e);
});

upstream.on("close", (code, reason) => {
    console.log(`[upstream] ===== WebSocket CLOSED ===== code=${code}, reason=${reason}`);
});

  async function safeCreateResponse(source) {
    if (upstream.readyState !== WebSocket.OPEN) return;
    if (Date.now() < suppressCreateUntil) return;
    if (overLimit()) { await sayGoodbye(); return; }
    const instructions = await compileInstrAsync(baseInstructions, memKey);
    const payload = {
      type: "response.create",
      response: {
        modalities: USE_INWORLD ? ["text"] : ["audio","text"],
        instructions
      }
    };
    if (generating) { try { upstream.send(JSON.stringify({ type: "response.cancel" })); } catch {} }
    turnCount++;
    try { upstream.send(JSON.stringify(payload)); } catch {}
  }

  const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {}; };
  client.on("close", closeBoth);
  client.on("error", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", (e) => console.error("upstream error:", e.message));
});

server.listen(PORT, () => console.log(`relay listening on ${PORT}`));

function pickDeltaOnly(evt) {
  const type = evt?.type || "";
  if (type === "response.output_text.delta" && typeof evt.delta === "string") return evt.delta;
  if (type === "response.text.delta" && typeof evt.delta === "string") return evt.delta;
  if (type === "response.content.part.delta" && typeof evt.delta === "string") return evt.delta;
  return "";
}

function sanitize(s){ return String(s).replace(/\s+/g, " ").trim(); }
function isSpeakable(s){ return /[\p{L}\p{N}]/u.test(s); }

function cutCompleteSentences(input, minChars = 6, hardMax = 300) {
  const t = sanitize(input);
  if (!t) return { complete: [], rest: "" };
  const out = [];
  let last = 0;
  const re = /([.!?]+)(\s+|$)/g;
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
  const parts = t.split(/(\.|\?|!)+\s+/);
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

async function streamPcm16ToClient(client, pcm, responseId, itemId, outputIndex = 0, prebufferFirst = true) {
  const sr = INWORLD_SR;
  const bytesPerSample = 2;
  const bytesPerChunk = CHUNK_SAMPLES * bytesPerSample;
  const chunkMs = Math.round(CHUNK_SAMPLES / sr * 1000);
  const burstChunks = prebufferFirst ? Math.max(0, Math.floor(PREBUFFER_MS / chunkMs)) : 0;

  try {
    client.send(JSON.stringify({
      type: `${AUDIO_EVENT_PREFIX}.start`,
      response_id: responseId,
      ...(itemId ? { item_id: itemId } : {}),
      output_index: outputIndex
    }));
  } catch {}

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

function buildAuthHeader(v) {
  const raw = String(v || "").trim();
  if (!raw) return "";
  if (/^(Bearer|Basic)\s/i.test(raw)) return raw;
  if (raw.includes(":")) return `Basic ${raw}`;
  return `Bearer ${raw}`;
}

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

  const headers = {
    "Content-Type": "application/json",
    "Accept": "audio/wav, application/json;q=0.9",
    "Authorization": buildAuthHeader(INWORLD_AUTH)
  };

  let r;
  try {
    r = await fetch(INWORLD_TTS, { method: "POST", headers, body: JSON.stringify(payload) });
  } catch (e) {
    console.error("Inworld TTS fetch error:", e?.message || e);
    throw e;
  }

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    console.error("Inworld TTS non-OK:", r.status, r.statusText, t?.slice(0,800));
    throw new Error(`Inworld TTS HTTP ${r.status}`);
  }

  const ct  = (r.headers.get("content-type") || "").toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());

  if (looksLikeWav(buf)) {
    const { sampleRate, channels, pcm16 } = parseWavPcm16(buf);
    const mono = channels > 1 ? stereoToMono(pcm16) : pcm16;
    return sampleRate === targetSr ? mono : resamplePcm16(mono, sampleRate, targetSr);
  }

  if (ct.includes("application/json")) {
    try {
      const json = JSON.parse(buf.toString("utf8"));
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
        if (isCompressedAudio(audioBuf)) throw new Error("Inworld returned compressed audio");
        if (audioBuf.length % 2 === 0) return audioBuf;
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
        if (!looksLikeWav(buf2)) throw new Error("Fetched URL but not WAV");
        const { sampleRate, channels, pcm16 } = parseWavPcm16(buf2);
        const mono2 = channels > 1 ? stereoToMono(pcm16) : pcm16;
        return sampleRate === targetSr ? mono2 : resamplePcm16(mono2, sampleRate, targetSr);
      }
      throw new Error("No audio found in JSON");
    } catch (e) {
      console.error("Inworld TTS parse JSON error:", e?.message || e);
      throw e;
    }
  }

  if (isCompressedAudio(buf)) throw new Error("Inworld returned compressed audio");
  throw new Error("Unexpected Inworld TTS response");
}

function wrapPcm16ToWav(pcmBuf, sampleRate = INWORLD_SR, channels = 1) {
  const bytesPerSample = 2;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const dataSize = pcmBuf.length;
  const riffSize = 36 + dataSize;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(riffSize, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataSize, 40);
  return Buffer.concat([h, pcmBuf]);
}

async function transcribePCM16(pcmBuffer, preferLang) {
  try {
    if (!STT_ENABLED || !pcmBuffer || !pcmBuffer.length) return "";
    const wav = wrapPcm16ToWav(pcmBuffer, INWORLD_SR, 1);

    let lang = (STT_LANG_ENV || "").toLowerCase();
    if (!lang) {
      if (ALWAYS_EN) lang = "en";
      else if (ALWAYS_RU) lang = "ru";
      else if (preferLang) {
        const m = String(preferLang).toLowerCase().match(/^[a-z]{2}/);
        if (m) lang = m[0];
      }
    }

    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
    form.append("model", STT_MODEL);
    if (lang) form.append("language", lang);

    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), STT_TIMEOUT_MS);

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
      signal: ac.signal
    }).catch((e) => {
      console.error("STT fetch error:", e?.message || e);
      return null;
    });
    clearTimeout(to);

    if (!r || !r.ok) {
      const t = r ? (await r.text().catch(()=> "")) : "";
      console.error("STT non-OK:", r?.status, t?.slice(0, 400));
      return "";
    }
    const j = await r.json().catch(() => null);
    const text = (j?.text || "").trim();
    return text;
  } catch (e) {
    console.error("STT error:", e?.message || e);
    return "";
  }
}

async function extractFactsFromUtterance(text) {
  const s = String(text || "").trim();
  let player_name = null;
  let m = s.match(/\bmy name is\s+([A-Za-z\-]{2,32})/i);
  if (m) player_name = m[1];
  if (!player_name) {
    m = s.match(/\b(i am|i'm)\s+([A-Za-z\-]{2,32})/i);
    if (m) player_name = m[2];
  }
  const facts = [];
  return { facts, player_name };
}

function looksLikeWav(buf) {
  return Buffer.isBuffer(buf) &&
         buf.length >= 12 &&
         buf.toString("ascii", 0, 4) === "RIFF" &&
         buf.toString("ascii", 8, 12) === "WAVE";
}

function parseWavPcm16(buf) {
  if (!looksLikeWav(buf)) throw new Error("Not a WAV file");
  let pos = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = 0;
  let dataSize = 0;

  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const next = pos + 8 + size + (size % 2);

    if (id === "fmt ") {
      const audioFormat = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bitsPerSample = buf.readUInt16LE(pos + 22);
      if (audioFormat !== 1) throw new Error("WAV not PCM (format " + audioFormat + ")");
    } else if (id === "data") {
      dataStart = pos + 8;
      dataSize = size;
    }
    pos = next;
  }

  if (!dataStart) throw new Error("No data chunk in WAV");
  if (bitsPerSample !== 16) throw new Error("Expected 16-bit PCM WAV");

  const pcm16 = buf.subarray(dataStart, dataStart + dataSize);
  return { sampleRate, channels, pcm16 };
}

function stereoToMono(pcm16Buf) {
  const src = new Int16Array(pcm16Buf.buffer, pcm16Buf.byteOffset, pcm16Buf.byteLength / 2);
  const frames = Math.floor(src.length / 2);
  const dst = new Int16Array(frames);
  for (let i = 0, j = 0; i < frames; i++, j += 2) {
    dst[i] = ((src[j] || 0) + (src[j + 1] || 0)) / 2;
  }
  return Buffer.from(dst.buffer);
}

function resamplePcm16(pcm16Buf, fromSr, toSr) {
  if (fromSr === toSr) return Buffer.from(pcm16Buf);
  const src = new Int16Array(pcm16Buf.buffer, pcm16Buf.byteOffset, pcm16Buf.byteLength / 2);
  const srcLen = src.length;
  if (srcLen < 2) return Buffer.from(pcm16Buf);

  const dstLen = Math.max(1, Math.round(srcLen * toSr / fromSr));
  const dst = new Int16Array(dstLen);
  const step = (srcLen - 1) / (dstLen - 1);

  for (let i = 0; i < dstLen; i++) {
    const x = i * step;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, srcLen - 1);
    const t = x - i0;
    const v = src[i0] + (src[i1] - src[i0]) * t;
    dst[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return Buffer.from(dst.buffer);
}

function findAudioContent(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.audioContent === "string") return obj.audioContent;
  if (typeof obj.audio === "string") return obj.audio;
  if (obj.audio && typeof obj.audio.audioContent === "string") return obj.audio.audioContent;
  for (const k in obj) {
    const v = obj[k];
    const found = (v && typeof v === "object") ? findAudioContent(v) : null;
    if (found) return found;
  }
  return null;
}

function decodeBase64Loose(s) {
  const str = String(s || "").replace(/[^A-Za-z0-9+/=]/g, "");
  try { return Buffer.from(str, "base64"); } catch { return Buffer.alloc(0); }
}

function isCompressedAudio(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return false;
  const sig4 = buf.toString("ascii", 0, 4);
  const b0 = buf[0], b1 = buf[1];
  if (sig4 === "OggS") return true;
  if (sig4 === "fLaC") return true;
  if (sig4 === "ID3 ") return true;
  if (b0 === 0xFF && (b1 & 0xE0) === 0xE0) return true;
  if (sig4 === "RIFF" && buf.toString("ascii", 8, 12) !== "WAVE") return true;
  return false;
}

function findWavBase64InJson(obj) {
  let found = null;
  function walk(o) {
    if (found || !o) return;
    if (typeof o === "string") {
      if (o.length > 100 && /^\s*[A-Za-z0-9+/]+={0,2}\s*$/.test(o)) {
        const b = decodeBase64Loose(o);
        if (looksLikeWav(b)) found = b;
      }
      return;
    }
    if (typeof o === "object") {
      for (const k in o) walk(o[k]);
    }
  }
  walk(obj);
  return found;
}

function extractAudioUrl(obj) {
  let out = null;
  function walk(o) {
    if (out || !o) return;
    if (typeof o === "string" && /^https?:\/\//.test(o) && /(\.wav($|\?)|audio)/i.test(o)) { out = o; return; }
    if (typeof o === "object") {
      if (typeof o.url === "string" && /^https?:\/\//.test(o.url)) { out = o.url; return; }
      for (const k in o) walk(o[k]);
    }
  }
  walk(obj);
  return out;
}



