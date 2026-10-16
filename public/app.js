const $ = (id) => document.getElementById(id);
const audio = $('audio');
const api = async (path, opts) => {
  const r = await fetch(path, opts && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.reload(); throw new Error('Přihlášení vypršelo'); }
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data });
  return data;
};

const MOODS = [['all', 'Vše'], ['auto', 'Podle denní doby'], ['energize', 'Nabuzení'], ['relax', 'Relax'], ['happy', 'Veselé'], ['sad', 'Smutné'], ['wake', 'Na probuzení'],
  ['morning', 'Ráno'], ['afternoon', 'Odpoledne'], ['evening', 'Večer'], ['night', 'Noc'], ['focus', 'Soustředění'], ['party', 'Párty'], ['workout', 'Sport']];
let mood = 'all';
try { const m = localStorage.getItem('mood'); if (MOODS.some(([id]) => id === m)) mood = m; } catch {}
const moodLabel = (id) => MOODS.find(([k]) => k === id)?.[1] || 'Vše';
function dayPart() { const h = new Date().getHours(); return h >= 5 && h < 10 ? 'morning' : h < 17 && h >= 10 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night'; }
const resolvedMood = () => (mood === 'all' ? '' : mood === 'auto' ? dayPart() : mood);   // co se posílá serveru
const state = { dj: { cfg: null, since: 0, plan: null }, djActive: false, queue: [], current: null, started: false, listenSent: false, fb: { love: new Set(), hate: new Set() }, fails: 0 };

const fmt = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
function message(text, info = false) {
  $('msg').hidden = !text; $('msg').textContent = text || ''; $('msg').classList.toggle('info', info);
}

/* ---------- fronta ---------- */
let fetching = null, moodGen = 0;   // moodGen: výsledky dotazu na starou náladu se zahodí
function refill() {
  if (fetching) return fetching;            // běžící dotaz sdílíme, ať na něj playNext počká
  if (state.queue.length >= 4) return Promise.resolve();
  const gen = moodGen;
  fetching = (async () => {
    try {
      const exclude = [state.current, ...state.queue].filter(Boolean).map((t) => t.id).join('\n');
      const { tracks } = await api(`/api/next?n=6&mood=${resolvedMood()}&exclude=${encodeURIComponent(exclude)}`);
      if (gen !== moodGen) return;
      const have = new Set([state.current?.id, ...state.queue.map((t) => t.id)]);
      state.queue.push(...tracks.filter((t) => !have.has(t.id)));
      renderQueue(); prefetch(); scheduleDj(); updateDjInfo();
    } catch (e) {
      if (e.data?.error === 'setup') openSettings();
      else if (!state.current) message(e.message);
    } finally { if (gen === moodGen) fetching = null; }
  })();
  return fetching;
}

function renderQueue() {
  const ul = $('queueList'); ul.innerHTML = '';
  state.queue.slice(0, 4).forEach((t, i) => {
    const li = document.createElement('li'), btn = document.createElement('button');
    btn.title = 'Přehrát hned';
    const b = document.createElement('b'); b.textContent = t.title;
    const s = document.createElement('span'); s.textContent = t.artist;
    btn.onclick = () => { initAudioGraph(); state.queue.splice(0, i); state.started = true; playNext(true); };
    btn.append(b, s); li.append(btn); ul.append(li);
  });
  $('upnext').hidden = !state.queue.length;
}

const resolve = (t) => (t.resolving ||= (() => {
  return api(`/api/resolve?artist=${encodeURIComponent(t.artist)}&title=${encodeURIComponent(t.title)}`).then((r) => {
    return Object.assign(t, r);
  });
})());
const measure = (t) => (t.measuring ||= resolve(t).then(() => api(`/api/loudness?id=${t.videoId}`)).then((r) => (t.lufs = r.lufs)).catch(() => null));

/* ---------- normalizace hlasitosti (Web Audio) ---------- */
const TARGET_LUFS = -14;
let ctx, gain;
function initAudioGraph() {
  if (ctx) return ctx.state === 'suspended' && ctx.resume();
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    gain = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();   // pojistka proti clippingu při zesilování
    Object.entries({ threshold: -2, knee: 0, ratio: 20, attack: 0.003, release: 0.15 }).forEach(([k, v]) => (limiter[k].value = v));
    ctx.createMediaElementSource(audio).connect(gain).connect(limiter).connect(ctx.destination);
  } catch { ctx = null; }
}
function applyGain(t) {
  if (!gain || !t || state.current !== t) return;
  const db = typeof t.lufs === 'number' ? Math.max(-12, Math.min(9, TARGET_LUFS - t.lufs)) : -3;
  gain.gain.setTargetAtTime(Math.pow(10, db / 20), ctx.currentTime, 0.4);
}
function prefetch() { const t = state.queue[0]; if (t) measure(t); }

/* ---------- přehrávání ---------- */
async function playNext(manual = false) {
  state.dj.plan = null; updateDjInfo();
  if (state.current && !manual) api('/api/played', { track: state.current }).catch(() => {});
  else if (state.current && manual) api('/api/played', { track: state.current }).catch(() => {});

  if (!state.queue.length) { setLoading(true); await refill(); }
  const t = state.queue.shift();
  if (!t) { setLoading(false); setPlaying(false); return; }
  state.current = t; state.listenSent = false;
  state.dj.since++;
  scheduleDj();
  show(t); renderQueue(); refill(); loadLyrics(t); updateDjInfo();

  setLoading(true); message('');
  try {
    await resolve(t);
    if (gain) gain.gain.value = Math.pow(10, (typeof t.lufs === 'number' ? Math.max(-12, Math.min(9, TARGET_LUFS - t.lufs)) : -3) / 20);
    audio.src = `/api/stream/${t.videoId}`;
    measure(t).then(() => applyGain(t));
    await audio.play();
    state.fails = 0;
    refill().then(planDj);
  } catch (e) {
    if (e.name === 'NotAllowedError') { setLoading(false); setPlaying(false); return; }
    if (++state.fails >= 5) { setLoading(false); setPlaying(false); message('Nepodařilo se přehrát několik skladeb po sobě. Zkontroluj yt-dlp na serveru.'); return; }
    return playNext();
  }
  prefetch();
}

function show(t) {
  $('title').textContent = t.title; $('artist').textContent = t.artist;
  $('source').textContent = t.source || '';
  document.title = `${t.title} · ${t.artist}`;
  $('love').classList.toggle('on', state.fb.love.has(t.id));
  $('hate').classList.toggle('on', state.fb.hate.has(t.id));
  setCover(t.cover, t);
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, artwork: t.cover ? [{ src: t.cover, sizes: '500x500' }] : [] });
}

function setCover(url, t) {
  const img = $('coverImg'); img.classList.remove('show');
  const apply = (src) => {
    const isThumb = src === t.thumb;
    img.classList.toggle('thumb', isThumb);
    img.onload = () => { if (state.current === t) { img.classList.add('show'); paintBg(img, isThumb); } };
    img.src = src;
  };
  img.onerror = () => { img.onerror = null; resolve(t).then(() => state.current === t && apply(t.thumb)).catch(() => {}); };
  if (url) apply(url); else img.onerror();
}

// Pozadí: obálka se postupně zmenší (průměrování) a zase zvětší (vyhlazení) na malém canvasu a roztáhne přes stránku.
// Bez CSS blur filtru, který dělal artefakty.
function paintBg(img, isThumb) {
  const c = $('bg'), g = c.getContext('2d');
  try {
    const w = img.naturalWidth, h = img.naturalHeight, cut = isThumb ? h * 0.125 : 0;   // miniatury z YouTube mají černé pruhy
    let src = img, sx = 0, sy = cut, sw = w, sh = h - 2 * cut;
    const hop = (size) => {
      const t = document.createElement('canvas'); t.width = t.height = size;
      const x = t.getContext('2d'); x.imageSmoothingQuality = 'high';
      x.drawImage(src, sx, sy, sw, sh, 0, 0, size, size);
      src = t; sx = sy = 0; sw = sh = size;
    };
    for (const size of [64, 32, 16, 8, 16, 32, 64, 128]) hop(size);   // dolů na 8×8, pak postupně zpět nahoru (hladké přechody)
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, sw, sh, 0, 0, c.width, c.height);
    g.fillStyle = 'rgba(11,11,13,.65)'; g.fillRect(0, 0, c.width, c.height);   // tmavý závoj: text je čitelný i na bílé obálce
    c.classList.add('on');
  } catch { c.classList.remove('on'); }
}

function setLoading(on) { $('cover').classList.toggle('loading', on); }
function setPlaying(on) {
  $('play').classList.toggle('playing', on);
  $('play').setAttribute('aria-label', on ? 'Pauza' : 'Přehrát');
  $('cover').classList.toggle('playing', on);
}
const syncPlaying = () => setPlaying(!audio.paused && !audio.ended);

async function toggle() {
  initAudioGraph();
  if (!state.started) { state.started = true; return playNext(); }
  audio.paused ? audio.play().catch(() => {}) : audio.pause();
}

async function feedback(kind) {
  const t = state.current; if (!t) return;
  const on = !state.fb[kind].has(t.id);
  state.fb.love.delete(t.id); state.fb.hate.delete(t.id);
  if (on) state.fb[kind].add(t.id);
  if (state.djActive) { $('love').classList.toggle('on', state.fb.love.has(t.id)); $('hate').classList.toggle('on', state.fb.hate.has(t.id)); } else show(t);
  api('/api/feedback', { track: t, kind: on ? kind : 'none' }).catch(() => {});
  if (kind === 'hate' && on) playNext(true);
}

// Mobil: po zamknutí / návratu do aplikace může být AudioContext pozastavený → zvuk by oněměl
const resumeCtx = () => { if (ctx && ctx.state !== 'running' && !audio.paused) ctx.resume().catch(() => {}); };
document.addEventListener('visibilitychange', resumeCtx);
audio.addEventListener('playing', resumeCtx);

/* ---------- hlasitost ---------- */
const vol = $('volume');
function setVolume(v, save = true) {
  audio.volume = v; vol.value = v; vol.style.setProperty('--p', `${v * 100}%`);
  if (save) try { localStorage.setItem('volume', v); } catch {}
}
vol.addEventListener('input', () => setVolume(Number(vol.value)));
vol.addEventListener('wheel', (e) => { e.preventDefault(); setVolume(Math.min(1, Math.max(0, audio.volume - Math.sign(e.deltaY) * 0.05))); }, { passive: false });
audio.volume = 0.5;
if (audio.volume !== 0.5) document.body.classList.add('no-volume');   // iOS: hlasitost audio prvku nelze měnit
try { setVolume(Number(localStorage.getItem('volume') ?? 1), false); } catch { setVolume(1, false); }

/* ---------- texty písní ---------- */
const lyr = { data: null, open: false, idx: -1, lines: [] };
try { lyr.open = localStorage.getItem('lyrics') === '1'; } catch {}
function renderLyrics() {
  const box = $('lyricsBody'), has = !!(lyr.data && (lyr.data.synced?.length || lyr.data.plain));
  $('lyricsBtn').disabled = !has; $('lyricsBtn').textContent = has ? 'Text písně' : 'Text nenalezen';
  $('lyricsBtn').setAttribute('aria-pressed', has && lyr.open);
  $('lyrics').hidden = !(has && lyr.open);
  box.innerHTML = ''; lyr.idx = -1; lyr.lines = [];
  if (!has) return;
  $('lyrics').classList.toggle('plain', !lyr.data.synced?.length);
  $('lyrics').scrollTop = 0;
  if (lyr.data.synced?.length) {
    lyr.data.synced.forEach((l) => {
      const p = document.createElement('p'); p.className = l.text ? 'sync' : 'sync gap';
      const words = l.text.split(/\s+/).filter(Boolean), total = words.reduce((n, w) => n + w.length + 1, 0);
      let acc = 0; const spans = [];
      words.forEach((w, i) => {
        const sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w;
        sp.dataset.a = acc / total; acc += w.length + 1; sp.dataset.b = acc / total;
        spans.push(sp); p.append(sp); if (i < words.length - 1) p.append(' ');
      });
      p.onclick = () => { audio.currentTime = l.t; };
      box.append(p); lyr.lines.push({ el: p, spans });
    });
  } else {
    for (const line of lyr.data.plain.split('\n')) { const p = document.createElement('p'); p.textContent = line; if (!line.trim()) p.className = 'gap'; box.append(p); }
  }
}
async function loadLyrics(t) {
  lyr.data = null; renderLyrics();
  $('lyricsBtn').textContent = 'Hledám text…';
  try {
    await resolve(t).catch(() => {});
    const q = new URLSearchParams({ artist: t.artist, title: t.title, duration: t.duration || '' });
    const d = await api(`/api/lyrics?${q}`);
    if (state.current === t) { lyr.data = d; renderLyrics(); }
  } catch { if (state.current === t) renderLyrics(); }
}
// Karaoke efekt: aktuální řádek se zleva doprava vybarvuje po slovech podle odhadu, jak dlouho se řádek zpívá
function syncLyrics() {
  const L = lyr.data?.synced; if (state.djActive || !L?.length || $('lyrics').hidden) return;
  const now = audio.currentTime + 0.15;
  let i = -1; for (let k = 0; k < L.length && L[k].t <= now; k++) i = k;
  if (i !== lyr.idx) {
    lyr.lines.forEach((ln, k) => {
      ln.el.classList.toggle('active', k === i); ln.el.classList.toggle('past', k < i);
      if (k !== i) ln.spans.forEach((sp) => sp.style.removeProperty('--p'));
    });
    lyr.idx = i;
    const el = lyr.lines[i]?.el;
    if (el) { const box = $('lyrics'); box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2 - box.offsetTop; }
  }
  const ln = lyr.lines[i]; if (!ln || !L[i].text) return;
  const next = L[i + 1]?.t ?? L[i].t + 5;
  const chars = L[i].text.length;
  const dur = Math.max(0.8, Math.min(next - L[i].t - 0.15, chars * 0.075 + 0.5));   // zpívá se kratší dobu než do dalšího řádku
  const f = Math.min(1, Math.max(0, (now - L[i].t) / dur));
  for (const sp of ln.spans) {
    const a = Number(sp.dataset.a), b = Number(sp.dataset.b);
    sp.style.setProperty('--p', `${Math.min(1, Math.max(0, (f - a) / (b - a))) * 100}%`);
  }
}
let raf = 0;
function lyricsLoop() { syncLyrics(); raf = audio.paused ? 0 : requestAnimationFrame(lyricsLoop); }
function startLyricsLoop() { if (!raf) raf = requestAnimationFrame(lyricsLoop); }
audio.addEventListener('playing', startLyricsLoop);
audio.addEventListener('seeked', syncLyrics);
$('lyricsBtn').onclick = () => {
  lyr.open = !lyr.open; try { localStorage.setItem('lyrics', lyr.open ? '1' : '0'); } catch {}
  renderLyrics(); syncLyrics(); startLyricsLoop();
  if (lyr.open) $('lyrics').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

/* ---------- události audia ---------- */
audio.addEventListener('play', syncPlaying);
audio.addEventListener('playing', () => { syncPlaying(); setLoading(false); });
audio.addEventListener('pause', syncPlaying);
audio.addEventListener('emptied', syncPlaying);
audio.addEventListener('waiting', () => setLoading(true));
audio.addEventListener('canplay', () => setLoading(false));
audio.addEventListener('ended', () => (state.djActive ? endDj() : afterTrack()));
audio.addEventListener('error', () => { if (state.djActive) endDj(); else if (state.current && audio.src) playNext(true); });
audio.addEventListener('timeupdate', () => {
  const d = audio.duration || state.current?.duration || 0;
  $('cur').textContent = fmt(audio.currentTime); $('dur').textContent = fmt(d);
  $('bar').style.width = d ? `${(audio.currentTime / d) * 100}%` : '0';
  if (!state.djActive && !state.listenSent && d && (audio.currentTime > d / 2 || audio.currentTime > 240)) {
    state.listenSent = true;
    api('/api/listen', { track: state.current, listened_at: Math.floor(Date.now() / 1000 - audio.currentTime) }).catch(() => {});
  }
  if ('mediaSession' in navigator && d) try { navigator.mediaSession.setPositionState({ duration: d, position: audio.currentTime, playbackRate: 1 }); } catch {}
});
{
  // přetahování po liště postupu (myš i dotyk)
  const bar = $('progress');
  const seek = (e) => { const r = bar.getBoundingClientRect(); if (audio.duration) audio.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * audio.duration; };
  bar.addEventListener('pointerdown', (e) => { bar.setPointerCapture(e.pointerId); seek(e); bar.onpointermove = seek; });
  const stop = () => { bar.onpointermove = null; };
  bar.addEventListener('pointerup', stop); bar.addEventListener('pointercancel', stop);
}

/* ---------- ovládání ---------- */
$('play').onclick = toggle;
$('next').onclick = () => { initAudioGraph(); if (state.djActive) return endDj(); state.started ? playNext(true) : toggle(); };
$('love').onclick = () => feedback('love');
$('hate').onclick = () => feedback('hate');
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight' || e.key === 'n') $('next').click();
  else if (e.key === 'f') toggleFullscreen();
  else if (e.key === 'l') $('love').click();
  else if (e.key === 'd') $('hate').click();
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setVolume(Math.min(1, Math.max(0, audio.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)))); }
  else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 10);
});
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('nexttrack', () => (state.djActive ? endDj() : playNext(true)));
}

/* ---------- AI moderátor ---------- */
const DJ_CHANCE = { few: 0.15, sometimes: 0.25, normal: 0.45, more: 0.65, often: 0.85, always: 1 };
const DJ_GAP = { few: 2, sometimes: 2, normal: 1, more: 1, often: 1, always: 1 };   // minimálně tolik skladeb mezi vstupy
const djFreq = (c) => (c.freq === 'rare' ? 'few' : c.freq);
const djChance = (c) => DJ_CHANCE[djFreq(c)] ?? 0.45;
const djGap = (c) => DJ_GAP[djFreq(c)] ?? 1;
const KIND_LABEL = { chat: 'Moderátor', news: 'Zprávy', weather: 'Počasí' };
function pickKind(c) {
  const w = [['chat', 6]];
  if (c.news) w.push(['news', 2]);
  if (c.weather && c.city) w.push(['weather', 2]);
  let r = Math.random() * w.reduce((n, x) => n + x[1], 0);
  for (const [k, n] of w) if ((r -= n) < 0) return k;
  return 'chat';
}
// Předem se rozhodne, po kterých skladbách zazní vstup (aktuální + fronta), takže text i chování vždy sedí
function scheduleDj() {
  const c = state.dj.cfg;
  if (!c?.enabled || !c.hasKey) return;
  let since = state.current ? state.dj.since : state.dj.since + 1;
  for (const t of [state.current, ...state.queue].filter(Boolean)) {
    if (!t.dj) { t.dj = { yes: since >= djGap(c) && Math.random() < djChance(c), kind: pickKind(c) } }
    since = t.dj.yes ? 1 : since + 1;
  }
}
function clearDjDecisions() { state.queue.forEach((t) => delete t.dj); }

function planDj() {
  const c = state.dj.cfg, next = state.queue[0], cur = state.current;
  if (!c?.enabled || !c.hasKey || !next || !cur || state.djActive || !cur.dj?.yes || state.dj.plan?.forId === next.id) return updateDjInfo();
  const when = new Date().toLocaleString('cs-CZ', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const pick = (t) => ({ artist: t.artist, title: t.title, source: t.source });
  const plan = state.dj.plan = { forId: next.id, status: 'generating' };
  plan.clip = api('/api/dj', { prev: pick(cur), next: pick(next), when, kind: cur.dj.kind, mood: resolvedMood() ? moodLabel(resolvedMood()) : '' })
    .then(async (r) => {
      const url = URL.createObjectURL(await (await fetch(`/api/dj/audio/${r.id}.mp3`)).blob());
      plan.status = 'ready'; plan.kind = r.kind; updateDjInfo();
      return { text: r.text, url, kind: r.kind };
    })
    .catch(() => { plan.status = 'failed'; updateDjInfo(); return null; });
  updateDjInfo();
}

// Text „po které skladbě zazní další vstup moderátora“
function updateDjInfo() {
  const el = $('djInfo'), c = state.dj.cfg, cur = state.current, plan = state.dj.plan;
  if (!c?.enabled || !c.hasKey || !cur || !cur.dj) { el.hidden = true; return; }
  el.hidden = false;
  if (cur.dj.yes) {
    el.textContent = !plan || plan.forId !== state.queue[0]?.id || plan.status === 'generating' ? 'Po této skladbě zazní vstup moderátora (připravuje se).'
      : plan.status === 'ready' ? `Po této skladbě zazní: ${KIND_LABEL[plan.kind] || 'Moderátor'}.` : 'Vstup moderátora se nepodařilo připravit, další skladba naváže.';
    return;
  }
  const i = state.queue.findIndex((t) => t.dj?.yes);
  el.textContent = i >= 0 ? `Další vstup moderátora zazní po skladbě „${state.queue[i].title}“ – ${state.queue[i].artist}.`
    : `Dalších ${state.queue.length} skladeb bude bez vstupu moderátora.`;
}

async function afterTrack() {
  const plan = state.dj.plan; state.dj.plan = null;
  if (plan && plan.forId === state.queue[0]?.id) {
    const clip = await Promise.race([plan.clip, new Promise((r) => setTimeout(() => r(null), 8000))]);
    if (clip) return playDj(clip);
  }
  playNext();
}
function playDj(clip) {
  state.djActive = true; state.dj.since = 0; state.dj.url = clip.url; updateDjInfo();
  document.body.classList.add('dj');
  $('djText').textContent = clip.text; $('djText').hidden = false;
  const label = KIND_LABEL[clip.kind] || 'Moderátor';
  $('title').textContent = label; $('artist').textContent = 'Osobní rádio';
  document.title = `${label} · Osobní rádio`;
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: label, artist: 'Osobní rádio' });
  if (gain) gain.gain.value = 1;
  audio.src = clip.url;
  audio.play().catch(() => endDj());
}
function endDj() {
  if (!state.djActive) return;
  state.djActive = false; document.body.classList.remove('dj'); $('djText').hidden = true;
  if (state.dj.url) URL.revokeObjectURL(state.dj.url);
  playNext();
}

/* ---------- celá obrazovka ---------- */
const fsEl = document.documentElement;
const fsOn = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsRequest = fsEl.requestFullscreen || fsEl.webkitRequestFullscreen;
if (!fsRequest) document.body.classList.add('no-fs');
function toggleFullscreen() {
  if (!fsRequest) return;
  if (fsOn()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  else fsRequest.call(fsEl).catch?.(() => {});
}
let idleTimer;
function wake() {
  document.body.classList.remove('idle'); clearTimeout(idleTimer);
  if (fsOn()) idleTimer = setTimeout(() => document.body.classList.add('idle'), 3500);
}
function onFsChange() {
  document.body.classList.toggle('fs', !!fsOn()); wake();
  setTimeout(() => { lyr.idx = -1; syncLyrics(); }, 100);   // přecentruj aktuální řádek po změně rozložení
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);
['mousemove', 'mousedown', 'keydown', 'touchstart'].forEach((e) => document.addEventListener(e, wake, { passive: true }));
$('fsBtn').onclick = toggleFullscreen;
$('cover').ondblclick = toggleFullscreen;

/* ---------- nastavení ---------- */
const dlg = $('dlg');
async function openSettings() {
  const s = await api('/api/state');
  $('fUser').value = s.username; $('fToken').value = '';
  $('fToken').placeholder = s.hasToken ? 'uloženo (prázdné = beze změny)' : 'volitelné';
  $('ver').textContent = `Osobní rádio, verze ${s.version}`;
  const d = s.dj; state.dj.cfg = d;
  $('djOn').checked = d.enabled; $('djKey').value = '';
  $('djKey').placeholder = d.hasKey ? 'uloženo (prázdné = beze změny)' : 'sk-or-…';
  $('djLang').value = d.lang; $('djFreq').value = d.freq === 'rare' ? 'few' : d.freq;
  $('djNews').checked = d.news; $('djWeather').checked = d.weather; $('djCity').value = d.city || '';
  if (![...$('djVoice').options].some((o) => o.value === d.voice)) $('djVoice').add(new Option(d.voice, d.voice));
  $('djVoice').value = d.voice;
  dlg.showModal();
}
$('settingsBtn').onclick = openSettings;
$('cancel').onclick = () => dlg.close();
let testAudio;
$('djTest').onclick = async () => {
  const b = $('djTest'); b.textContent = '… generuji';
  try {
    // uloží aktuální volbu hlasu a jazyka, ať test odpovídá výběru
    await api('/api/settings', { dj: { lang: $('djLang').value, voice: $('djVoice').value } });
    const r = await api('/api/dj/test', {});
    testAudio?.pause(); testAudio = new Audio(`/api/dj/audio/${r.id}.mp3`); await testAudio.play();
    b.textContent = '▶ Vyzkoušet hlas';
  } catch (e) { b.textContent = `Chyba: ${e.message}`; setTimeout(() => (b.textContent = '▶ Vyzkoušet hlas'), 4000); }
};
$('form').addEventListener('submit', async () => {
  const prevUser = state.username;
  const saved = await api('/api/settings', {
    username: $('fUser').value, token: $('fToken').value, openrouterKey: $('djKey').value, city: $('djCity').value,
    dj: { enabled: $('djOn').checked, lang: $('djLang').value, freq: $('djFreq').value, voice: $('djVoice').value, news: $('djNews').checked, weather: $('djWeather').checked },
  });
  const st = await api('/api/state'); state.dj.cfg = st.dj; clearDjDecisions(); scheduleDj(); updateDjInfo();
  if (st.username === prevUser && state.started) { message(saved.cityError || ''); return; }   // změna jen nastavení moderátora → hudbu nepřerušuj
  state.queue = []; message(saved.cityError || '');
  if (state.started) playNext(true); else init();
});

/* ---------- nálada hudby ---------- */
function updateMoodBtn() {
  $('moodBtn').textContent = `Nálada: ${mood === 'auto' ? `${moodLabel(dayPart())} (auto)` : moodLabel(mood)}`;
  $('moodBtn').setAttribute('aria-pressed', mood !== 'all');
}
function renderMoodGrid() {
  $('moodGrid').innerHTML = '';
  for (const [id, label] of MOODS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = `chip${id === 'all' || id === 'auto' ? ' wide' : ''}`; b.textContent = label;
    b.setAttribute('aria-pressed', id === mood);
    b.onclick = () => setMood(id);
    $('moodGrid').append(b);
  }
}
function setMood(id) {
  $('moodDlg').close();
  if (id === mood) return;
  mood = id; try { localStorage.setItem('mood', id); } catch {}
  updateMoodBtn();
  moodGen++; fetching = null;
  state.queue = []; state.dj.plan = null; clearDjDecisions(); renderQueue(); updateDjInfo();
  initAudioGraph();
  if (state.started) { if (state.djActive) endDj(); else playNext(true); }   // nová nálada se projeví hned
  else refill();
}
$('moodBtn').onclick = () => { renderMoodGrid(); $('moodDlg').showModal(); };
$('moodClose').onclick = () => $('moodDlg').close();
$('moodDlg').addEventListener('click', (e) => { if (e.target === $('moodDlg')) $('moodDlg').close(); });
updateMoodBtn();

/* ---------- start ---------- */
async function init() {
  const s = await api('/api/state');
  if (!s.configured) { message('Nejdřív zadej své uživatelské jméno z ListenBrainz.', true); return openSettings(); }
  state.dj.cfg = s.dj; state.username = s.username; message('');
  try { const f = await api('/api/feedback'); state.fb.love = new Set(f.love); state.fb.hate = new Set(f.hate); } catch {}
  $('title').textContent = 'Připraveno'; $('artist').textContent = `Osobní rádio pro uživatele ${s.username}`;
  refill();
}
init();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
