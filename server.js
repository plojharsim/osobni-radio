import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

loadEnv(path.join(ROOT, '.env'));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const YTDLP = process.env.YTDLP_BIN || 'yt-dlp';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const LB = 'https://api.listenbrainz.org';
const LB_LABS = 'https://labs.api.listenbrainz.org';
const UA = 'PersonalRadio/1.0 (self-hosted)';

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

/* ---------- jednoduché JSON úložiště ---------- */
function store(name, fallback) {
  const file = path.join(DATA, name);
  let value = fallback;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let timer;
  return {
    get: () => value,
    save() {
      clearTimeout(timer);
      timer = setTimeout(() => fs.writeFile(file, JSON.stringify(value, null, 1), () => {}), 300);
    },
  };
}
const settings = store('settings.json', {});
const history = store('history.json', []);      // klíče naposledy hraných skladeb
const feedback = store('feedback.json', { love: [], hate: [] });

const cfg = () => ({
  username: process.env.LB_USER || settings.get().username || '',
  token: process.env.LB_TOKEN || settings.get().token || '',
});

/* ---------- ListenBrainz ---------- */
async function lb(url, { token, method = 'GET', body } = {}) {
  const headers = { 'User-Agent': UA };
  if (token) headers.Authorization = `Token ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  try {
    const value = await fn();
    cache.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  } catch (e) {
    if (hit) return hit.value;
    console.warn('[lb]', e.message);
    cache.set(key, { value: [], exp: Date.now() + 5 * 60e3 });   // nezahlcuj API opakovanými chybami
    return [];
  }
}

const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.random() * a.length | 0];
const cover = (rel) => (rel ? `https://coverartarchive.org/release/${rel}/front-500` : null);
const trackKey = (artist, title) => `${artist}|${title}`.toLowerCase().replace(/\s+/g, ' ').trim();

function mkTrack(artist, title, mbid, release, source) {
  return { id: trackKey(artist, title), artist, title, mbid: mbid || null, cover: cover(release), source };
}

// Doporučení ListenBrainz (collaborative filtering)
const recommended = (u) => cached(`rec:${u}`, 30 * 60e3, async () => {
  const r = await lb(`${LB}/1/cf/recommendation/user/${encodeURIComponent(u)}/recording?count=100`);
  const mbids = (r?.payload?.mbids || []).map((m) => m.recording_mbid);
  if (!mbids.length) return [];
  const meta = await lb(`${LB}/1/metadata/recording/?recording_mbids=${mbids.join(',')}&inc=artist+release`);
  return mbids.map((id) => {
    const m = meta?.[id];
    if (!m?.recording?.name || !m?.artist?.name) return null;
    return mkTrack(m.artist.name, m.recording.name, id, m.release?.mbid, 'doporučení');
  }).filter(Boolean);
});

// Oblíbené skladby uživatele
const favourites = (u) => cached(`fav:${u}`, 60 * 60e3, async () => {
  const r = await lb(`${LB}/1/stats/user/${encodeURIComponent(u)}/recordings?range=year&count=100`);
  let list = r?.payload?.recordings || [];
  if (list.length < 20) list = (await lb(`${LB}/1/stats/user/${encodeURIComponent(u)}/recordings?range=all_time&count=100`))?.payload?.recordings || [];
  return list.map((x) => mkTrack(x.artist_name, x.track_name, x.recording_mbid, x.caa_release_mbid || x.release_mbid, 'oblíbené'));
});

const topArtists = (u) => cached(`art:${u}`, 60 * 60e3, async () => {
  const r = await lb(`${LB}/1/stats/user/${encodeURIComponent(u)}/artists?range=year&count=40`);
  let list = r?.payload?.artists || [];
  if (list.length < 5) list = (await lb(`${LB}/1/stats/user/${encodeURIComponent(u)}/artists?range=all_time&count=40`))?.payload?.artists || [];
  return list.filter((a) => a.artist_mbid || a.artist_mbids?.length).map((a) => ({ name: a.artist_name, mbid: a.artist_mbid || a.artist_mbids[0] }));
});

const similarArtists = (mbid) => cached(`sim:${mbid}`, 24 * 3600e3, async () => {
  const algo = 'session_based_days_9000_session_300_contribution_5_threshold_15_limit_50_skip_30';
  const r = await lb(`${LB_LABS}/similar-artists/json?artist_mbids=${mbid}&algorithm=${algo}`);
  const arr = Array.isArray(r) ? r : r?.payload || [];
  return arr.filter((a) => a.artist_mbid && a.artist_mbid !== mbid).slice(0, 30);
});

const artistTop = (mbid) => cached(`top:${mbid}`, 24 * 3600e3, async () => {
  const { token } = cfg();
  if (!token) return [];   // tento endpoint ListenBrainz vyžaduje token
  const r = await lb(`${LB}/1/popularity/top-recordings-for-artist/${mbid}`, { token });
  return (Array.isArray(r) ? r : []).slice(0, 15);
});

// Objevování: podobní interpreti k těm, které posloucháš
async function discover(u) {
  const mine = await topArtists(u);
  if (!mine.length) return [];
  const seed = pick(mine);
  const sims = await similarArtists(seed.mbid);
  if (!sims.length) return [];
  const a = pick(sims);
  const top = await artistTop(a.artist_mbid);
  return shuffle(top).slice(0, 3).map((t) => mkTrack(t.artist_name || a.name, t.recording_name, t.recording_mbid, t.release_mbid, `podobné: ${seed.name}`));
}

// Normalizace pro ochranu proti opakování: hlavní interpret a název bez závorek / "remastered" apod.
const primaryArtist = (a) => a.toLowerCase().split(/\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[,&/;]\s*|\s+and\s+/)[0].replace(/^the\s+/, '').trim();
const cleanTitle = (t) => t.toLowerCase().replace(/[(\[].*?[)\]]/g, ' ').replace(/\s+-\s+.*(remaster|version|mix|edit|live|mono|stereo).*$/, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const songKey = (id) => { const [a = '', ...t] = id.split('|'); return `${primaryArtist(a)}|${cleanTitle(t.join('|'))}`; };
const artistOf = (id) => primaryArtist(id.split('|')[0]);
const ARTIST_COOLDOWN = 12;   // tolik posledních skladeb se nesmí opakovat interpret

async function nextTracks(n, exclude = []) {
  const { username } = cfg();
  const hist = history.get();
  const blockedSongs = new Set([...hist, ...exclude].map(songKey));
  const hate = new Set(feedback.get().hate.map(songKey));
  const recentArtists = new Set([...hist.slice(-ARTIST_COOLDOWN), ...exclude].map(artistOf));
  const love = feedback.get().love;
  const out = [], seen = new Set(), deferred = [];
  const accept = (t) => { seen.add(songKey(t.id)); out.push(t); recentArtists.add(artistOf(t.id)); };
  const add = (t) => {
    if (!t || out.length >= n) return;
    const k = songKey(t.id);
    if (blockedSongs.has(k) || hate.has(k) || seen.has(k)) return;
    if (recentArtists.has(artistOf(t.id))) { deferred.push(t); return; }   // interpret hrál nedávno → jen jako nouzová záloha
    accept(t);
  };

  const [rec, fav] = await Promise.all([recommended(username), favourites(username)]);
  const recPool = shuffle(rec), favPool = shuffle(fav);
  const lovedPool = shuffle(love.map((x) => mkTrack(x.artist, x.title, x.mbid, null, 'tvoje ♥')));

  for (let guard = 0; out.length < n && guard < n * 10; guard++) {
    const r = Math.random();
    if (r < 0.4) { for (const t of await discover(username)) add(t); }
    else if (r < 0.7) add(recPool.pop());
    else if (r < 0.9) add(favPool.pop());
    else add(lovedPool.pop());
  }
  for (const t of [...recPool, ...favPool]) add(t);
  // nouzově povol i nedávné interprety (stále ne stejné skladby), ale jen jednou za dávku
  for (const t of deferred) {
    const k = songKey(t.id);
    if (out.length < n && !seen.has(k) && !out.some((o) => artistOf(o.id) === artistOf(t.id))) { seen.add(k); out.push(t); }
  }
  return out;
}

/* ---------- yt-dlp ---------- */
let running = 0; const waiting = [];
function ytdlp(args, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      execFile(YTDLP, args, { timeout, maxBuffer: 20e6 }, (err, stdout, stderr) => {
        running--; waiting.shift()?.();
        err ? reject(new Error((stderr || err.message).split('\n').filter(Boolean).pop())) : resolve(stdout);
      });
    };
    running < 3 ? run() : waiting.push(run);
  });
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ');
function score(entry, artist, title) {
  const dur = entry.duration || 0;
  if (dur < 45 || dur > 15 * 60) return -1;
  const hay = norm(`${entry.title} ${entry.channel || entry.uploader || ''}`);
  let s = 0;
  if ((entry.channel || entry.uploader || '').endsWith('- Topic')) s += 4;
  if (hay.includes(norm(artist).trim())) s += 2;
  if (hay.includes(norm(title).trim())) s += 3;
  if (/live|cover|reaction|remix|karaoke|instrumental|slowed|sped up|8d|nightcore/.test(hay) &&
      !/live|cover|remix|karaoke|instrumental/.test(norm(title))) s -= 3;
  if (/official audio|official video|lyrics/.test(hay)) s += 1;
  return s;
}

let ytdlpVer;
const ytdlpVersion = async () => (ytdlpVer ||= (await ytdlp(['--version']).catch(() => 'nedostupný')).trim());
const streamCache = new Map();   // videoId -> { url, exp }
const resolveCache = new Map();  // trackKey -> Promise

async function directUrl(videoId) {
  const hit = streamCache.get(videoId);
  if (hit && hit.exp > Date.now()) return hit.url;
  const out = await ytdlp(['--no-playlist', '--no-warnings', '-f', 'bestaudio[ext=m4a]/bestaudio', '-g', `https://www.youtube.com/watch?v=${videoId}`]);
  const url = out.trim().split('\n')[0];
  if (!url) throw new Error('prázdná URL');
  streamCache.set(videoId, { url, exp: Date.now() + 4 * 3600e3 });
  return url;
}

function resolveTrack(artist, title) {
  const key = trackKey(artist, title);
  if (!resolveCache.has(key)) {
    const p = (async () => {
      const out = await ytdlp(['--flat-playlist', '--no-warnings', '-j', `ytsearch6:${artist} - ${title}`]);
      const entries = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const best = entries.map((e) => ({ e, s: score(e, artist, title) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error('nic nenalezeno');
      await directUrl(best.e.id);
      return { videoId: best.e.id, duration: best.e.duration, thumb: `https://i.ytimg.com/vi/${best.e.id}/hqdefault.jpg` };
    })();
    p.catch(() => resolveCache.delete(key));
    resolveCache.set(key, p);
    if (resolveCache.size > 300) resolveCache.delete(resolveCache.keys().next().value);
  }
  return resolveCache.get(key);
}

// Hlasitost skladby (LUFS) – změří se z úseku uprostřed přes ffmpeg, klient podle toho dorovná gain
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const loudCache = new Map();
function loudness(videoId) {
  if (!loudCache.has(videoId)) {
    const p = directUrl(videoId).then((url) => new Promise((resolve, reject) => {
      execFile(FFMPEG, ['-hide_banner', '-nostats', '-ss', '15', '-t', '40', '-i', url, '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'],
        { timeout: 40000, maxBuffer: 5e6 }, (err, _o, stderr) => {
          const m = [...String(stderr).matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)].pop();
          m ? resolve({ lufs: Number(m[1]) }) : reject(err || new Error('bez výsledku'));
        });
    }));
    p.catch(() => loudCache.delete(videoId));
    loudCache.set(videoId, p);
    if (loudCache.size > 300) loudCache.delete(loudCache.keys().next().value);
  }
  return loudCache.get(videoId);
}

// Texty písní z LRCLIB (včetně časovaných)
const lyricsCache = new Map();
function parseLrc(lrc) {
  return lrc.split('\n').flatMap((l) => {
    const m = l.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s?(.*)$/);
    return m ? [{ t: Number(m[1]) * 60 + Number(m[2]), text: m[3] }] : [];
  });
}
async function lrclib(path) {
  const r = await fetch(`https://lrclib.net/api/${path}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`lrclib ${r.status}`);
  return r.json();
}
async function lyrics(artist, title, duration) {
  const key = trackKey(artist, title);
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  const q = new URLSearchParams({ artist_name: artist, track_name: title });
  let hit = await lrclib(`get?${q}${duration ? `&duration=${Math.round(duration)}` : ''}`).catch(() => null);
  if (!hit || (!hit.syncedLyrics && !hit.plainLyrics)) {
    const list = (await lrclib(`search?${q}`).catch(() => null)) || [];
    hit = list.filter((x) => x.syncedLyrics || x.plainLyrics)
      .sort((a, b) => Math.abs((a.duration || 0) - (duration || 0)) - Math.abs((b.duration || 0) - (duration || 0)))[0];
  }
  const out = hit && !hit.instrumental
    ? { synced: hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : null, plain: hit.plainLyrics || null }
    : { synced: null, plain: null };
  lyricsCache.set(key, out);
  if (lyricsCache.size > 300) lyricsCache.delete(lyricsCache.keys().next().value);
  return out;
}

async function proxyStream(req, res, videoId) {
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = await directUrl(videoId);
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = await fetch(url, { headers, signal: ac.signal });
    if ((up.status === 403 || up.status === 410) && attempt === 0) { streamCache.delete(videoId); continue; }
    const h = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    for (const k of ['content-type', 'content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
    res.writeHead(up.status, h);
    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
    return;
  }
  throw new Error('stream nedostupný');
}

/* ---------- AI moderátor (OpenRouter + Edge neural TTS) ---------- */
const TTS_BIN = process.env.TTS_BIN || (fs.existsSync(path.join(ROOT, '.venv/bin/edge-tts')) ? path.join(ROOT, '.venv/bin/edge-tts') : 'edge-tts');
const TTS_DIR = path.join(DATA, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';
const DJ_MODEL = 'dots-studio/dots-3-note-preview:free';   // pevně daný model, nelze měnit
const DJ_DEFAULTS = { enabled: true, lang: 'cs', voice: DEFAULT_VOICE, freq: 'normal', news: true, weather: true };
const djCfg = () => ({
  ...DJ_DEFAULTS, ...(settings.get().dj || {}), model: DJ_MODEL,
  key: process.env.OPENROUTER_API_KEY || settings.get().openrouterKey || '',
});
const djFreq = (f) => (f === 'rare' ? 'few' : f);   // starší hodnota z dřívějšího nastavení

async function chat(model, messages, key) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(75000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost', 'X-Title': 'Personal Radio' },
    body: JSON.stringify({ model, messages, temperature: 0.9, max_tokens: 600 }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `OpenRouter ${r.status}`);
  const c = j.choices?.[0]?.message?.content;
  return Array.isArray(c) ? c.map((x) => x.text || '').join('') : c || '';
}

const cleanSpeech = (t) => t
  .replace(/<think>[\s\S]*?<\/think>/gi, ' ').replace(/[*_#`>~]/g, '')
  .replace(/\p{Extended_Pictographic}/gu, '').replace(/^["„“'\s]+|["“”'\s]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 700);

/* zprávy (RSS) a počasí (Open-Meteo, bez klíče) */
const FEEDS = { cs: 'https://ct24.ceskatelevize.cz/rss/hlavni-zpravy', en: 'https://feeds.bbci.co.uk/news/world/rss.xml' };
const unxml = (x) => x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const usedNews = new Set();
async function getNews(lang) {
  const items = await cached(`news:${lang}`, 10 * 60e3, async () => {
    const r = await fetch(FEEDS[lang] || FEEDS.cs, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`RSS ${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map((m) => ({
      title: unxml(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
      summary: unxml(m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1] || '').slice(0, 280),
    })).filter((x) => x.title);
  });
  const fresh = items.filter((x) => !usedNews.has(x.title)).slice(0, 4);
  if (!fresh.length) throw new Error('žádné nové zprávy');
  return fresh;
}
const WMO = { 0: 'jasno', 1: 'převážně jasno', 2: 'polojasno', 3: 'zataženo', 45: 'mlha', 48: 'namrzající mlha', 51: 'slabé mrholení', 53: 'mrholení', 55: 'silné mrholení', 56: 'mrznoucí mrholení', 57: 'mrznoucí mrholení',
  61: 'slabý déšť', 63: 'déšť', 65: 'silný déšť', 66: 'mrznoucí déšť', 67: 'mrznoucí déšť', 71: 'slabé sněžení', 73: 'sněžení', 75: 'husté sněžení', 77: 'sněhové zrnka', 80: 'přeháňky', 81: 'silnější přeháňky', 82: 'prudké přeháňky', 85: 'sněhové přeháňky', 86: 'silné sněhové přeháňky', 95: 'bouřka', 96: 'bouřka s kroupami', 99: 'silná bouřka s kroupami' };
async function getWeather(loc) {
  return cached(`wx:${loc.lat},${loc.lon}`, 15 * 60e3, async () => {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=1`;
    const j = await (await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) })).json();
    if (!j.current) throw new Error('počasí nedostupné');
    return { now: j.current.temperature_2m, feels: j.current.apparent_temperature, desc: WMO[j.current.weather_code] || 'proměnlivo', wind: j.current.wind_speed_10m,
      min: j.daily.temperature_2m_min[0], max: j.daily.temperature_2m_max[0], rain: j.daily.precipitation_probability_max?.[0] };
  });
}
async function geocode(name) {
  const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=cs`, { signal: AbortSignal.timeout(15000) })).json();
  const g = r.results?.[0];
  return g ? { name: g.name, lat: g.latitude, lon: g.longitude } : null;
}
const lastKind = { news: 0, weather: 0 };

const recentLines = [];
const djLog = [];
const SOURCE_HINT = (src = '') =>
  src.startsWith('podobné:') ? `interpret podobný tomu, co posluchač rád poslouchá (${src.slice(8).trim()})`
  : src === 'doporučení' ? 'doporučení podle jeho hudebního vkusu'
  : src === 'oblíbené' ? 'jedna z jeho nejposlouchanějších skladeb'
  : src.includes('♥') ? 'skladba, kterou si posluchač označil jako oblíbenou' : '';
const STYLES = ['stručné plynulé spojení obou skladeb', 'krátká poznámka k náladě a atmosféře další skladby', 'pozdrav odpovídající času dne a pak představení další skladby', 'lehce vtipná hláška a představení další skladby', 'jen jednou větou představ další skladbu, bez zbytečností'];

async function djScript({ prev, next, when, kind = 'chat' }, c) {
  const lang = c.lang === 'en' ? 'English' : 'česky';
  const base = `Jsi moderátor osobního internetového rádia pro jednoho posluchače. Mluv ${lang}, přirozeně a uvolněně jako skutečný rozhlasový DJ, ne jako robot. ` +
    'Žádná emoji, žádný markdown, žádné uvozovky ani hvězdičky – text se čte nahlas. Piš gramaticky správně, krátkými větami. ' +
    'Jména interpretů a skladeb piš v originále. Nepoužívej žádné jméno stanice. Každá hláška musí znít jinak než předchozí. ';
  const track = `Hned potom zazní: ${next.title} – ${next.artist}${SOURCE_HINT(next.source) ? ` (${SOURCE_HINT(next.source)})` : ''}.`;
  let system, user;
  if (kind === 'weather') {
    const w = c.weatherData, loc = c.cityName;
    system = base + 'Teď máš přečíst krátkou předpověď počasí (do 45 slov). Použij POUZE dodané údaje, čísla zaokrouhli na celé, nic nepřidávej ani nevymýšlej. Nakonec jednou větou plynule přejdi k hudbě.';
    user = [`Teď je: ${when}.`, `Počasí v místě ${loc}: nyní ${Math.round(w.now)} °C (pocitově ${Math.round(w.feels)} °C), ${w.desc}, vítr ${Math.round(w.wind)} km/h. Dnes ${Math.round(w.min)} až ${Math.round(w.max)} °C${w.rain != null ? `, pravděpodobnost srážek ${w.rain} %` : ''}.`, track, 'Napiš jen text hlášky.'].join('\n');
  } else if (kind === 'news') {
    system = base + 'Teď máš přečíst krátké zprávy (do 70 slov) jako rozhlasový hlasatel: věcně, neutrálně, vážným tónem, žádné vtipy ani hodnocení. Vyber 1–2 z dodaných zpráv a přeformuluj je vlastními slovy. Použij POUZE dodané informace, nic nepřidávej ani nedomýšlej. Nakonec jednou větou plynule přejdi k hudbě.';
    user = [`Teď je: ${when}.`, 'Dodané zprávy:', ...c.newsData.map((n, i) => `${i + 1}. ${n.title}${n.summary ? ` – ${n.summary}` : ''}`), track, 'Napiš jen text hlášky.'].join('\n');
  } else {
    system = base + 'Maximálně 1–3 krátké věty (do 40 slov). NIKDY nevymýšlej fakta o skladbách ani interpretech (rok vydání, ocenění, příběhy, žebříčky, členy kapely). Pokud si nejsi naprosto jistý, drž se obecné nálady, času dne a toho, jak skladba zapadá do poslechu.';
    user = [`Teď je: ${when || 'neznámý čas'}.`, prev ? `Právě dohrála skladba: ${prev.title} – ${prev.artist}.` : '', track,
      `Styl hlášky: ${STYLES[Math.random() * STYLES.length | 0]}.`,
      recentLines.length ? `Dřívější hlášky (nezačínej podobně): ${recentLines.slice(-4).join(' | ')}` : '', 'Napiš jen text hlášky.'].filter(Boolean).join('\n');
  }
  const msgs = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const model = c.model;
    try {
      const text = cleanSpeech(await chat(model, msgs, c.key));
      if (text.length > 5) return { text, model };
      lastErr = new Error('prázdná odpověď');
    } catch (e) { lastErr = e; console.warn('[dj]', model, e.message); if (/401|key|auth/i.test(e.message)) break; await new Promise((r) => setTimeout(r, 1500)); }
  }
  throw lastErr;
}

function synth(text, voice) {
  const id = crypto.createHash('sha1').update(`${voice}|${text}`).digest('hex').slice(0, 16);
  const out = path.join(TTS_DIR, `${id}.mp3`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return Promise.resolve(id);
  const run = (v) => new Promise((resolve, reject) => {
    execFile(TTS_BIN, ['--voice', v, '--rate=+4%', `--text=${text}`, '--write-media', out], { timeout: 40000 },
      (err, _o, stderr) => (err || !fs.existsSync(out) || fs.statSync(out).size < 1000) ? reject(new Error((stderr || err?.message || 'TTS selhalo').split('\n').filter(Boolean).pop())) : resolve(id));
  });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return run(voice).catch(() => wait(800).then(() => run(voice))).catch(() => wait(1500).then(() => run(voice))).catch((e) => {
    console.warn('[tts] selhalo pro text:', JSON.stringify(text));
    if (voice === DEFAULT_VOICE) throw e;
    console.warn('[tts] hlas', voice, 'selhal, používám', DEFAULT_VOICE);
    return run(DEFAULT_VOICE);
  });
}
function cleanTts() {
  const old = Date.now() - 2 * 3600e3;
  for (const f of fs.readdirSync(TTS_DIR)) { const p = path.join(TTS_DIR, f); try { if (fs.statSync(p).mtimeMs < old) fs.unlinkSync(p); } catch {} }
}

const djJobs = new Map();
function makeBreak(body) {
  const c = djCfg();
  if (!c.enabled || !c.key) return Promise.reject(new Error('moderátor není nastaven'));
  const k = `${body.kind || 'chat'}|${body.next?.title}|${body.next?.artist}${body.force ? `|${Date.now()}` : ''}`;
  if (!djJobs.has(k)) {
    const p = (async () => {
      cleanTts();
      let kind = body.kind || 'chat';
      const loc = settings.get().location;
      const ready = Date.now();
      // zprávy a počasí mají odstup, aby se neopakovaly
      if (kind === 'weather' && (!c.weather || !loc || (!body.force && ready - lastKind.weather < 60 * 60e3))) kind = 'chat';
      if (kind === 'news' && (!c.news || (!body.force && ready - lastKind.news < 25 * 60e3))) kind = 'chat';
      const ctx = { ...c, cityName: loc?.name };
      try {
        if (kind === 'weather') { ctx.weatherData = await getWeather(loc); if (!ctx.weatherData?.desc) throw new Error('počasí nedostupné'); }
        if (kind === 'news') ctx.newsData = await getNews(c.lang);
      } catch (e) { console.warn('[dj]', kind, e.message); kind = 'chat'; }
      const t0 = Date.now();
      const { text, model } = await djScript({ ...body, kind }, ctx);
      const llmMs = Date.now() - t0;
      const id = await synth(text, c.voice);
      djLog.push({ at: Date.now(), text, kind, asked: body.kind || 'chat', model, llmMs, totalMs: Date.now() - t0, next: `${body.next.artist} – ${body.next.title}` });
      if (djLog.length > 15) djLog.shift();
      if (kind === 'chat') { recentLines.push(text); if (recentLines.length > 8) recentLines.shift(); }
      else { lastKind[kind] = Date.now(); if (kind === 'news') ctx.newsData.forEach((n) => usedNews.add(n.title)); }
      return { id, text, kind };
    })();
    p.catch(() => djJobs.delete(k));
    djJobs.set(k, p);
    if (djJobs.size > 50) djJobs.delete(djJobs.keys().next().value);
  }
  return djJobs.get(k);
}

function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size, m = (req.headers.range || '').match(/bytes=(\d*)-(\d*)/);
  let start = 0, end = size - 1, code = 200;
  if (m) { start = m[1] ? Number(m[1]) : size - Number(m[2]); end = m[2] && m[1] ? Math.min(Number(m[2]), size - 1) : size - 1; code = 206; }
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store' };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  fs.createReadStream(file, { start, end }).pipe(res);
}

/* ---------- HTTP ---------- */
const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

/* ---------- přihlášení heslem (jen heslo, bez jména; cookie relace) ---------- */
const SALT_FILE = path.join(DATA, 'session.salt');
let salt = '';
try { salt = fs.readFileSync(SALT_FILE, 'utf8').trim(); } catch {}
if (!salt) { salt = crypto.randomBytes(24).toString('hex'); try { fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 }); } catch {} }
const SESSION = crypto.createHash('sha256').update(`radio|${APP_PASSWORD}|${salt}`).digest('hex');   // změna hesla zneplatní všechny relace
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');

function authorized(req) {
  if (!APP_PASSWORD) return true;
  if (safeEq(cookieOf(req, 'radio_auth') || '', SESSION)) return true;
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/);   // pro skripty (curl -u x:heslo)
  return !!m && safeEq(Buffer.from(m[1], 'base64').toString().split(':').slice(1).join(':'), APP_PASSWORD);
}

let failures = [];   // časy neúspěšných pokusů – po 5 za minutu se přihlašování na chvíli zamkne (ochrana proti hádání hesla)
const LOGIN_PAGE = `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b0b0d"><title>Osobní rádio</title>
<style>
*{box-sizing:border-box;margin:0}html{background:#0b0b0d}
body{min-height:100dvh;display:grid;place-items:center;padding:20px;color:#f4f4f6;font:17px/1.4 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
form{width:min(360px,100%);background:#131316;border:1px solid rgba(255,255,255,.14);border-radius:20px;padding:28px}
h1{font-size:18px;font-weight:650}h1 small{font-size:12px;font-weight:400;color:#adadb8;margin-left:6px}
p{font-size:13px;color:#adadb8;margin-top:6px}
input{display:block;width:100%;margin-top:20px;padding:12px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0b0b0d;color:#f4f4f6;font:inherit;font-size:16px}
input:focus{outline:2px solid #b794f6;outline-offset:-1px}
button{width:100%;margin-top:14px;padding:12px;border-radius:12px;border:0;background:#f4f4f6;color:#0b0b0d;font:inherit;font-size:15px;font-weight:600;cursor:pointer}
button:disabled{opacity:.6}#err{min-height:20px;margin-top:12px;font-size:13px;color:#fca5a5}
</style></head><body>
<form id="f"><h1>Osobní rádio<small>by plojharsim</small></h1><p>Zadej heslo pro vstup.</p>
<input id="pw" type="password" placeholder="Heslo" autocomplete="current-password" autofocus required>
<button id="b">Vstoupit</button><div id="err" role="alert"></div></form>
<script>
f.onsubmit=async e=>{e.preventDefault();b.disabled=true;err.textContent='';
try{const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
if(r.ok)return location.reload();const j=await r.json().catch(()=>({}));err.textContent=j.error||'Nepodařilo se přihlásit';}
catch{err.textContent='Server neodpovídá';}b.disabled=false;pw.select();};
</script></body></html>`;

async function handleLogin(req, res) {
  const now = Date.now();
  failures = failures.filter((t) => now - t < 60e3);
  if (failures.length >= 5) return send(res, 429, { error: 'Příliš mnoho pokusů, zkus to za minutu.' });
  const { password } = await readBody(req);
  if (typeof password !== 'string' || !safeEq(password, APP_PASSWORD)) {
    failures.push(now);
    await new Promise((r) => setTimeout(r, 600));
    return send(res, 401, { error: 'Špatné heslo' });
  }
  failures = [];
  res.setHeader('Set-Cookie', `radio_auth=${SESSION}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${isHttps(req) ? '; Secure' : ''}`);
  return send(res, 200, { ok: true });
}

async function handle(req, res) {
  const route = new URL(req.url, 'http://x').pathname;
  if (APP_PASSWORD && route === '/login' && req.method === 'POST') return handleLogin(req, res);
  if (APP_PASSWORD && route === '/logout') {
    res.writeHead(302, { 'Set-Cookie': 'radio_auth=; Path=/; HttpOnly; Max-Age=0', Location: '/' });
    return res.end();
  }
  if (!authorized(req)) {
    if (route.startsWith('/api/')) return send(res, 401, { error: 'Přihlášení vyžadováno' });
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(LOGIN_PAGE);
  }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/api/state') {
    const c = cfg();
    const d = djCfg();
    return send(res, 200, { configured: !!c.username, username: c.username, hasToken: !!c.token,
      dj: { enabled: d.enabled, hasKey: !!d.key, lang: d.lang, voice: d.voice, freq: djFreq(d.freq), model: d.model, news: d.news, weather: d.weather, city: settings.get().location?.name || '' } });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    const b = await readBody(req);
    const s = settings.get();
    if (typeof b.username === 'string') s.username = b.username.trim();
    if (typeof b.token === 'string' && b.token !== '') s.token = b.token.trim();
    if (b.clearToken) delete s.token;
    if (typeof b.openrouterKey === 'string' && b.openrouterKey !== '') s.openrouterKey = b.openrouterKey.trim();
    if (b.clearOpenrouterKey) delete s.openrouterKey;
    if (b.dj && typeof b.dj === 'object') {
      const d = (s.dj ||= {});
      if (typeof b.dj.enabled === 'boolean') d.enabled = b.dj.enabled;
      if (['cs', 'en'].includes(b.dj.lang)) d.lang = b.dj.lang;
      if (typeof b.dj.voice === 'string' && /^[\w-]{5,60}$/.test(b.dj.voice)) d.voice = b.dj.voice;
      if (['few', 'sometimes', 'normal', 'more', 'often', 'always'].includes(b.dj.freq)) d.freq = b.dj.freq;
      if (typeof b.dj.news === 'boolean') d.news = b.dj.news;
      if (typeof b.dj.weather === 'boolean') d.weather = b.dj.weather;
    }
    let cityError;
    if (typeof b.city === 'string') {
      const name = b.city.trim();
      if (!name) delete s.location;
      else if (name !== s.location?.name) {
        try { const g = await geocode(name); if (g) s.location = g; else cityError = `Město „${name}“ se nenašlo`; }
        catch { cityError = 'Hledání města selhalo'; }
      }
    }
    settings.save(); cache.clear();
    return send(res, 200, { ok: true, cityError });
  }
  if (p === '/api/next') {
    if (!cfg().username) return send(res, 400, { error: 'setup' });
    const n = Math.min(Number(url.searchParams.get('n')) || 5, 15);
    const exclude = (url.searchParams.get('exclude') || '').split('\n').filter(Boolean);
    const tracks = await nextTracks(n, exclude);
    if (!tracks.length) return send(res, 404, { error: 'Nepodařilo se získat žádné skladby. Má tvůj ListenBrainz účet dost poslechů?' });
    return send(res, 200, { tracks });
  }
  if (p === '/api/resolve') {
    const artist = url.searchParams.get('artist'), title = url.searchParams.get('title');
    if (!artist || !title) return send(res, 400, { error: 'chybí parametry' });
    try { return send(res, 200, await resolveTrack(artist, title)); }
    catch (e) { return send(res, 404, { error: e.message }); }
  }
  if (p === '/api/debug') {
    const c = djCfg(), loc = settings.get().location;
    const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) : null);
    return send(res, 200, {
      uptimeSec: Math.round(process.uptime()), node: process.version, ytdlp: await ytdlpVersion(), ttsBin: TTS_BIN,
      caches: { resolve: resolveCache.size, streamUrls: streamCache.size, loudness: loudCache.size, lyrics: lyricsCache.size, djJobs: djJobs.size, lb: cache.size },
      historySize: history.get().length, loved: feedback.get().love.length, hated: feedback.get().hate.length,
      ttsFiles: fs.readdirSync(TTS_DIR).length, ytdlpRunning: running, ytdlpWaiting: waiting.length,
      dj: { enabled: c.enabled, hasKey: !!c.key, model: c.model, voice: c.voice, lang: c.lang, freq: djFreq(c.freq), news: c.news, weather: c.weather, city: loc?.name || null,
        newsCooldownLeftSec: Math.max(0, 25 * 60 - (ago(lastKind.news) ?? 1e9)), weatherCooldownLeftSec: Math.max(0, 60 * 60 - (ago(lastKind.weather) ?? 1e9)), usedNews: usedNews.size },
      djLog,
    });
  }
  if (p === '/api/dj' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.next?.title) return send(res, 400, { error: 'chybí další skladba' });
    try { return send(res, 200, await makeBreak(b)); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p === '/api/dj/test' && req.method === 'POST') {
    const c = djCfg();
    const text = c.lang === 'en' ? 'And that was a little taste of how I sound. Hope you like it, now back to the music.' : 'A takhle nějak budu znít mezi písničkami. Doufám, že se ti to líbí, a teď zpátky k hudbě.';
    try { return send(res, 200, { id: await synth(text, c.voice), text }); } catch (e) { return send(res, 502, { error: e.message }); }
  }
  if (p.startsWith('/api/dj/audio/')) {
    const id = p.slice(14).replace(/\.mp3$/, '');
    const f = path.join(TTS_DIR, `${id}.mp3`);
    if (!/^[0-9a-f]{16}$/.test(id) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    return serveFile(req, res, f, 'audio/mpeg');
  }
  if (p === '/api/lyrics') {
    const artist = url.searchParams.get('artist'), title = url.searchParams.get('title');
    if (!artist || !title) return send(res, 400, { error: 'chybí parametry' });
    try { return send(res, 200, await lyrics(artist, title, Number(url.searchParams.get('duration')) || 0)); }
    catch (e) { return send(res, 200, { synced: null, plain: null }); }
  }
  if (p === '/api/loudness') {
    const id = url.searchParams.get('id') || '';
    if (!/^[\w-]{6,20}$/.test(id)) return send(res, 400, { error: 'špatné id' });
    try { return send(res, 200, await loudness(id)); }
    catch (e) { return send(res, 200, { lufs: null }); }
  }
  if (p.startsWith('/api/stream/')) {
    const id = p.slice(12);
    if (!/^[\w-]{6,20}$/.test(id)) return send(res, 400, { error: 'špatné id' });
    try { return await proxyStream(req, res, id); }
    catch (e) { if (!res.headersSent) return send(res, 502, { error: e.message }); return res.destroy(); }
  }
  if (p === '/api/played' && req.method === 'POST') {
    const { track } = await readBody(req);
    if (track?.id) { const h = history.get(); h.push(track.id); if (h.length > 400) h.splice(0, h.length - 400); history.save(); }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/feedback' && req.method === 'POST') {
    const { track, kind } = await readBody(req);
    if (!track?.id) return send(res, 400, { error: 'chybí skladba' });
    const f = feedback.get();
    f.love = f.love.filter((x) => x.id !== track.id); f.hate = f.hate.filter((x) => x !== track.id);
    if (kind === 'love') f.love.push({ id: track.id, artist: track.artist, title: track.title, mbid: track.mbid });
    if (kind === 'hate') f.hate.push(track.id);
    feedback.save();
    const { token } = cfg();
    if (token && track.mbid) {
      lb(`${LB}/1/feedback/recording-feedback`, { token, method: 'POST', body: { recording_mbid: track.mbid, score: kind === 'love' ? 1 : kind === 'hate' ? -1 : 0 } })
        .catch((e) => console.warn('[feedback]', e.message));
    }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/feedback' && req.method === 'GET') {
    return send(res, 200, { love: feedback.get().love.map((x) => x.id), hate: feedback.get().hate });
  }
  if (p === '/api/listen' && req.method === 'POST') {
    const { track, listened_at } = await readBody(req);
    const { token } = cfg();
    if (!token || !track) return send(res, 200, { ok: true, submitted: false });
    try {
      await lb(`${LB}/1/submit-listens`, { token, method: 'POST', body: {
        listen_type: 'single',
        payload: [{ listened_at: listened_at || Math.floor(Date.now() / 1000), track_metadata: {
          artist_name: track.artist, track_name: track.title,
          additional_info: { submission_client: 'Personal Radio', media_player: 'Personal Radio', ...(track.mbid && { recording_mbid: track.mbid }) },
        } }],
      } });
      return send(res, 200, { ok: true, submitted: true });
    } catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/health') return send(res, 200, { ok: true });

  // statické soubory
  let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Nenalezeno'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) send(res, 500, { error: e.message }); else res.destroy(); });
}).listen(PORT, HOST, () => console.log(`Personal Radio běží na http://${HOST}:${PORT}`));
