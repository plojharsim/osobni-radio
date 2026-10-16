// Debug menu – nezávislý modul. Čte stav jen přes window.radio (viz konec app.js) a /api/debug.
(() => {
  const R = window.radio;
  if (!R) return;
  const { state, audio, dbgLog } = R;
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (x) => String(x ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clock = (t) => new Date(t).toLocaleTimeString('cs-CZ');
  const mmss = (s) => (isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '–');
  const row = (k, v, cls = '') => `<div class="dbgx-row"><span>${k}</span><span class="${cls}">${esc(v)}</span></div>`;
  const KIND = { chat: 'hláška', news: 'zprávy', weather: 'počasí' };

  /* ---------- zachytávání chyb a událostí audia do logu ---------- */
  window.addEventListener('error', (e) => R.log(`CHYBA: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => R.log(`CHYBA (promise): ${e.reason?.message || e.reason}`));
  for (const ev of ['stalled', 'waiting', 'error', 'ended', 'seeked']) {
    audio.addEventListener(ev, () => R.log(`audio: ${ev}${ev === 'error' && audio.error ? ` (kód ${audio.error.code})` : ''}`));
  }

  /* ---------- DOM ---------- */
  const btn = document.createElement('button');
  btn.className = 'icon dbgx-btn'; btn.title = 'Debug (`)'; btn.setAttribute('aria-label', 'Debug'); btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7l4 4-4 4M11 17h9"/></svg>';
  $('.hdr-actions')?.prepend(btn);

  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'debug.css'; document.head.append(css);
  const box = document.createElement('div');
  box.className = 'dbgx'; box.hidden = true;
  box.innerHTML = `<div class="dbgx-top"><div class="dbgx-title">Debug<small id="dbgx-sub"></small></div><button class="dbgx-x" aria-label="Zavřít">✕</button></div>
    <div class="dbgx-tabs"></div><div class="dbgx-body"></div>`;
  document.body.append(box);
  const body = $('.dbgx-body', box), tabsEl = $('.dbgx-tabs', box);

  const TABS = [['over', 'Přehled'], ['dj', 'Moderátor'], ['queue', 'Fronta'], ['server', 'Server'], ['log', 'Log']];
  let tab = 'over', logFilter = 'all', server = null, serverAt = 0, serverErr = null, ping = null, timer = null;
  try { tab = localStorage.getItem('dbgx-tab') || tab; } catch {}

  /* ---------- záložky ---------- */
  function viewOver() {
    const t = state.current, g = R.gain, a = audio;
    const buffered = a.buffered.length ? a.buffered.end(a.buffered.length - 1) - a.currentTime : 0;
    const dur = a.duration || t?.duration || 0;
    let h = '<h5>Právě hraje</h5>';
    h += t ? `<div class="dbgx-card accent"><b>${esc(t.title)}</b><div class="dim">${esc(t.artist)}</div>
      <div class="dbgx-bar"><div style="width:${dur ? Math.min(100, a.currentTime / dur * 100) : 0}%"></div></div>
      <div class="dim" style="margin-top:4px">${mmss(a.currentTime)} / ${mmss(dur)} · ${a.paused ? 'pauza' : 'hraje'}${state.djActive ? ' · MLUVÍ MODERÁTOR' : ''}</div></div>`
      : '<div class="dbgx-card dim">Nic nehraje.</div>';
    if (t) h += row('Zdroj výběru', t.source) + row('MusicBrainz ID', t.mbid) + row('YouTube video', t.videoId ? `${t.videoId}` : 'zatím nenalezeno') + row('Hledání trvalo', t.resolveMs != null ? `${t.resolveMs} ms` : '–') +
      row('Hlasitost skladby', t.lufs != null ? `${t.lufs} LUFS` : 'neměřeno') + row('Gain normalizace', g ? `${(20 * Math.log10(g.gain.value)).toFixed(1)} dB` : 'audio graf ještě není', g ? '' : 'dim');
    h += '<h5>Přehrávač</h5>';
    h += row('Buffer dopředu', `${buffered.toFixed(1)} s`, buffered < 3 && !a.paused ? 'warn' : '') + row('readyState', ['nic', 'metadata', 'aktuální data', 'budoucí data', 'dost dat'][a.readyState] || a.readyState) +
      row('networkState', ['prázdný', 'nečinný', 'stahuje', 'bez zdroje'][a.networkState] || a.networkState) + row('Hlasitost slideru', `${Math.round(a.volume * 100)} %`) +
      row('AudioContext', g?.context?.state || '–') + row('Chyba audia', a.error ? `kód ${a.error.code}` : 'žádná', a.error ? 'bad' : 'ok');
    h += '<h5>Prostředí</h5>';
    h += row('Okno', `${innerWidth}×${innerHeight} @${devicePixelRatio}×`) + row('Fullscreen', document.fullscreenElement ? 'ano' : 'ne') + row('Prohlížeč', navigator.userAgent.replace(/^Mozilla\/5.0 /, '').slice(0, 90)) +
      row('Ping serveru', ping == null ? '–' : `${ping} ms`) + `<div class="dbgx-acts"><button data-a="ping">Změřit ping</button><button data-a="end">Skočit na konec skladby</button></div>`;
    return h;
  }

  function viewDj() {
    const c = state.dj.cfg || {}, t = state.current, plan = state.dj.plan;
    const chain = [t, ...state.queue].filter(Boolean);
    let h = '<h5>Co uvidí uživatel</h5>';
    const info = $('#djInfo');
    h += `<div class="dbgx-card accent">${esc(!info || info.hidden ? '(text je skrytý – moderátor vypnutý, bez klíče nebo nic nehraje)' : info.textContent)}</div>`;
    h += '<h5>Naplánované vstupy</h5><div class="dbgx-chain">' + (chain.length ? chain.map((x, i) =>
      `<div class="${x.dj?.yes ? 'yes' : ''} ${i === 0 ? 'cur' : ''}"><em>${x.dj ? (x.dj.yes ? KIND[x.dj.kind] || x.dj.kind : 'bez vstupu') : '?'}</em><span>${i === 0 ? '▶ ' : ''}${esc(x.title)} – ${esc(x.artist)}</span></div>`).join('') : '<div class="dim">prázdné</div>') + '</div>';
    h += row('Vstup po aktuální', t?.dj?.yes ? (plan ? `${plan.status}${plan.ms ? ` (${plan.ms} ms)` : ''}${plan.error ? ` – ${plan.error}` : ''}` : 'čeká na generování') : 'žádný');
    h += row('Text vstupu', plan?.text || '–');
    h += '<h5>Akce</h5><div class="dbgx-acts">' +
      Object.entries(KIND).map(([k, n]) => `<button data-a="force:${k}">Po této skladbě: ${n}</button>`).join('') +
      '<button data-a="cancel">Zrušit vstup po této</button><button data-a="resched">Přepočítat plán</button></div>';
    h += '<h5>Nastavení</h5>';
    h += row('Moderátor', c.enabled ? 'zapnutý' : 'vypnutý', c.enabled ? 'ok' : 'warn') + row('API klíč', c.hasKey ? 'ano' : 'chybí', c.hasKey ? 'ok' : 'bad') +
      row('Četnost', c.enabled ? `${R.dj.freq(c)} = ${Math.round(R.dj.chance(c) * 100)} %, min. ${R.dj.gap(c)} skladba mezi vstupy` : '–') + row('Skladeb od vstupu', state.dj.since) +
      row('Model', c.model) + row('Hlas / jazyk', `${c.voice} / ${c.lang}`) + row('Zprávy', c.news ? 'ano' : 'ne') + row('Počasí', c.weather ? `ano (${c.city || 'bez města'})` : 'ne');
    if (server) {
      const cd = (s) => (s > 0 ? `za ${mmss(s)}` : 'volné');
      h += row('Odstup zprávy', cd(server.dj.newsCooldownLeftSec)) + row('Odstup počasí', cd(server.dj.weatherCooldownLeftSec)) + row('Přečtené zprávy', server.dj.usedNews);
      h += '<h5>Poslední vygenerované vstupy</h5>' + (server.djLog.length ? [...server.djLog].reverse().map((l) =>
        `<div class="dbgx-line">${esc(l.text)}<small>${clock(l.at)} · ${esc(KIND[l.kind] || l.kind)}${l.kind !== l.asked ? ` (chtěno ${esc(KIND[l.asked] || l.asked)})` : ''} · před ${esc(l.next)} · LLM ${l.llmMs} ms, celkem ${l.totalMs} ms</small></div>`).join('') : '<div class="dim">zatím žádné</div>');
    }
    return h;
  }

  function viewQueue() {
    const q = state.queue;
    let h = `<h5>Fronta (${q.length})</h5>`;
    if (!q.length) return h + '<div class="dim">prázdná</div>';
    h += q.map((x, i) => `<div class="dbgx-card"><b>${i + 1}. ${esc(x.title)}</b> <span class="dim">${esc(x.artist)}</span>
      <div class="dim">zdroj: ${esc(x.source)} · YouTube: ${x.videoId ? `${esc(x.videoId)} (${mmss(x.duration || 0)})` : 'nenalezeno zatím'} · ${x.lufs != null ? `${x.lufs} LUFS` : 'hlasitost neměřena'}
      · po ní: ${x.dj ? (x.dj.yes ? `vstup (${KIND[x.dj.kind] || x.dj.kind})` : 'bez vstupu') : '?'}</div></div>`).join('');
    return h;
  }

  function viewServer() {
    if (!server) return `<h5>Server</h5><div class="${serverErr ? 'bad' : 'dim'}">${esc(serverErr || 'načítám…')}</div>`;
    const s = server;
    let h = '<h5>Proces</h5>' + row('Běží', `${Math.floor(s.uptimeSec / 60)} min`) + row('Node', s.node) + row('yt-dlp', s.ytdlp) + row('yt-dlp úlohy', `běží ${s.ytdlpRunning}, čeká ${s.ytdlpWaiting}`, s.ytdlpWaiting ? 'warn' : '') + row('TTS binárka', s.ttsBin);
    h += '<h5>Cache</h5>' + Object.entries(s.caches).map(([k, v]) => row(k, v)).join('') + row('TTS soubory na disku', s.ttsFiles);
    h += '<h5>Data</h5>' + row('Historie přehrání', s.historySize) + row('Oblíbené ♥', s.loved) + row('Odmítnuté ✕', s.hated);
    return h + `<div class="dim" style="margin-top:10px">aktualizováno ${clock(serverAt)}</div>`;
  }

  const CATS = { dj: /vstup|rozhodnutí|moderátor|generuj/i, play: /▶|resolve|hlasitost|audio:/i, err: /chyba|selhal|nelze|error/i };
  function viewLog() {
    const items = [...dbgLog].reverse().filter((l) => logFilter === 'all' || CATS[logFilter].test(l.msg));
    const f = (k, n) => `<button data-a="filter:${k}" class="${logFilter === k ? 'on' : ''}">${n}</button>`;
    return `<div class="dbgx-filter">${f('all', 'Vše')}${f('dj', 'Moderátor')}${f('play', 'Přehrávání')}${f('err', 'Chyby')}<button data-a="copylog">Kopírovat</button><button data-a="clearlog">Vymazat</button></div>
      <div class="dbgx-log">${items.map((l) => `<div><i>${clock(l.at)}</i>${esc(l.msg)}</div>`).join('') || '<div class="dim">prázdný</div>'}</div>`;
  }

  const VIEWS = { over: viewOver, dj: viewDj, queue: viewQueue, server: viewServer, log: viewLog };

  /* ---------- vykreslení ---------- */
  function render() {
    tabsEl.innerHTML = TABS.map(([id, name]) => `<button class="dbgx-tab ${tab === id ? 'on' : ''}" data-tab="${id}">${name}${id === 'queue' ? `<i>${state.queue.length}</i>` : ''}</button>`).join('');
    const y = body.scrollTop;
    body.innerHTML = (VIEWS[tab] || viewOver)();
    body.scrollTop = y;
    $('#dbgx-sub', box).textContent = state.current ? `${state.current.title}` : 'nic nehraje';
  }

  async function poll() {
    try { server = await R.api('/api/debug'); serverAt = Date.now(); serverErr = null; } catch (e) { serverErr = `Server neodpovídá: ${e.message}`; }
  }

  function open(on) {
    box.hidden = !on; btn.setAttribute('aria-pressed', on);
    clearInterval(timer);
    try { localStorage.setItem('dbgx-open', on ? '1' : '0'); } catch {}
    if (!on) return;
    poll().then(render); render();
    timer = setInterval(() => { if (Date.now() - serverAt > 3000) poll(); render(); }, 1000);
  }

  /* ---------- akce ---------- */
  box.addEventListener('click', async (e) => {
    const x = e.target.closest('.dbgx-x'), tb = e.target.closest('[data-tab]'), ac = e.target.closest('[data-a]')?.dataset.a;
    if (x) return open(false);
    if (tb) { tab = tb.dataset.tab; try { localStorage.setItem('dbgx-tab', tab); } catch {} return render(); }
    if (!ac) return;
    const t = state.current, c = state.dj.cfg;
    if (ac === 'ping') { const t0 = performance.now(); try { await fetch('/api/health'); ping = Math.round(performance.now() - t0); } catch { ping = null; } return render(); }
    if (ac === 'end') { if (audio.duration) audio.currentTime = Math.max(0, audio.duration - 4); return; }
    if (ac.startsWith('filter:')) { logFilter = ac.slice(7); return render(); }
    if (ac === 'clearlog') { dbgLog.length = 0; return render(); }
    if (ac === 'copylog') { try { await navigator.clipboard.writeText([...dbgLog].map((l) => `${clock(l.at)} ${l.msg}`).join('\n')); R.log('log zkopírován do schránky'); } catch {} return render(); }
    if (ac === 'resched') { R.dj.clear(); if (t) delete t.dj; R.dj.schedule(); state.dj.plan = null; R.dj.plan(); R.log('plán vstupů přepočítán'); return render(); }
    if (!t) return;
    if (!c?.enabled || !c.hasKey) return R.log('akce nelze: moderátor je vypnutý nebo chybí klíč');
    if (ac === 'cancel') { t.dj = { yes: false }; state.dj.plan = null; R.log('vstup po aktuální skladbě zrušen'); }
    else if (ac.startsWith('force:')) {
      t.dj = { yes: true, kind: ac.slice(6), force: true }; state.dj.plan = null;
      R.log(`vynucen vstup po aktuální skladbě (${t.dj.kind})`);
      R.dj.clear(); R.dj.schedule(); R.dj.plan();
    }
    R.dj.info(); render();
  });
  btn.addEventListener('click', () => open(box.hidden));
  document.addEventListener('keydown', (e) => {
    if (e.key === '`' && !e.target.closest('input, textarea, select') && !e.metaKey && !e.ctrlKey) { e.preventDefault(); open(box.hidden); }
    else if (e.key === 'Escape' && !box.hidden && !document.fullscreenElement) open(false);
  });
  try { if (localStorage.getItem('dbgx-open') === '1') open(true); } catch {}
})();
