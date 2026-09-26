'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const store = {
  get(k, d) { try { const v = localStorage.getItem('bw.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bw.' + k, JSON.stringify(v)); } catch {} },
};

function checkAuth(r) {
  if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  return r;
}

async function api(path, opts) {
  const r = checkAuth(await fetch(path, opts));
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ================================================================ settings */

const DEFAULTS = {
  font: 'sans', size: 46, sideSize: 16, readSize: 20, showPrev: true, theme: 'dark',
  rate: 1, volume: 1, gap: 250, paraGap: 450,
  engine: 'edge', lang: 'auto',
  zhVoice: 'zh-CN-XiaoxiaoNeural', enVoice: 'en-US-AvaNeural', bZh: '', bEn: '',
  sidebar: true, sideTab: 'context',
};
const settings = { ...DEFAULTS, ...store.get('settings', {}) };
if (!store.get('settings', null) && matchMedia('(max-width: 860px)').matches) settings.sidebar = false;
const FONTS = {
  sans: ['--font-sans', '--font-sans-en'], serif: ['--font-serif', '--font-serif-en'],
  kai: ['--font-kai', '--font-kai-en'], system: ['--font-system', '--font-system'],
};

// Settings that follow you across devices (kept on the server). Sidebar layout and the browser
// engine's voices stay per device: they depend on the screen and on what the device has installed.
const SYNCED = ['font', 'size', 'sideSize', 'readSize', 'showPrev', 'theme', 'rate', 'volume', 'gap', 'paraGap', 'engine', 'lang', 'zhVoice', 'enVoice'];
let syncTimer = null;

function saveSettings(local = false) {
  store.set('settings', settings);
  if (local) return;
  store.set('settingsUpdated', Date.now());
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushSettings, 1000);
}

function syncedSettings() {
  const out = { updated: store.get('settingsUpdated', Date.now()) };
  for (const k of SYNCED) out[k] = settings[k];
  return JSON.stringify(out);
}

function pushSettings(beacon = false) {
  clearTimeout(syncTimer);
  syncTimer = null;
  if (beacon) navigator.sendBeacon('/api/settings', new Blob([syncedSettings()], { type: 'application/json' }));
  else fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: syncedSettings() }).then(checkAuth).catch(() => {});
}

async function pullSettings() {
  if (syncTimer || !ME) return; // a local change is about to be pushed; it is the newest
  let remote;
  try { remote = await api('/api/settings'); } catch { return; }
  // Settings saved in this browser by a different account are not this user's: never push them.
  const sameUser = store.get('settingsUser', null) === ME.id;
  store.set('settingsUser', ME.id);
  const localUpdated = sameUser ? store.get('settingsUpdated', 0) : 0;
  const customised = sameUser && SYNCED.some(k => settings[k] !== DEFAULTS[k]);
  if (!remote.updated) { if (localUpdated || customised) pushSettings(); return; } // first device to sync seeds it
  if (remote.updated <= localUpdated) { if (remote.updated < localUpdated) pushSettings(); return; }
  const engineBefore = settings.engine;
  for (const k of SYNCED) if (k in remote) settings[k] = remote[k];
  store.set('settingsUpdated', remote.updated);
  saveSettings(true);
  applySettings();
  populateVoices();
  if (book) { renderStage(); buildTimeIndex(); updateProgress(); }
  if (playing && settings.engine !== engineBefore) jump(cur);
}

function applySettings() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  const [zhFont, enFont] = FONTS[settings.font] || FONTS.sans;
  root.style.setProperty('--font-sub', `var(${zhFont})`);
  root.style.setProperty('--font-sub-en', `var(${enFont})`);
  root.style.setProperty('--sub-size', settings.size + 'px');
  root.style.setProperty('--side-size', settings.sideSize + 'px');
  root.style.setProperty('--read-size', settings.readSize + 'px');
  if (settings.font === 'kai' && !$('#kai-font')) {
    const l = document.createElement('link');
    l.id = 'kai-font';
    l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.7.0/style.css';
    document.head.append(l);
  }
  document.body.classList.toggle('side-folded', !settings.sidebar);
  // browser/OS chrome (title bar, status bar) follows the theme
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) $('meta[name="theme-color"]').content = bg;

  $('#setFont').value = settings.font;
  $('#setSize').value = settings.size; $('#sizeVal').textContent = settings.size + 'px';
  $('#setSideSize').value = settings.sideSize; $('#sideSizeVal').textContent = settings.sideSize + 'px';
  $('#setReadSize').value = settings.readSize; $('#readSizeVal').textContent = settings.readSize + 'px';
  $('#setPrev').checked = settings.showPrev;
  $('#setTheme').value = settings.theme;
  for (const id of ['#setRate', '#rateQuick']) $(id).value = settings.rate;
  for (const id of ['#setVol', '#volQuick']) $(id).value = settings.volume;
  $('#rateVal').textContent = $('#rateLabel').textContent = settings.rate.toFixed(2) + '×';
  $('#volVal').textContent = Math.round(settings.volume * 100) + '%';
  $('#setGap').value = settings.gap; $('#gapVal').textContent = settings.gap + ' ms';
  $('#setParaGap').value = settings.paraGap; $('#paraGapVal').textContent = settings.paraGap + ' ms';
  $('#setEngine').value = settings.engine;
  $('#setLang').value = settings.lang;

  audio.playbackRate = settings.rate;
  audio.volume = settings.volume;
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings(!SYNCED.includes(key));
  applySettings();
  if (key === 'showPrev' && book) renderStage();
  if (book && ['rate', 'gap', 'paraGap', 'lang', 'engine'].includes(key)) {
    if (key === 'lang') buildTimeIndex();
    updateProgress();
  }
  if (key === 'engine') { populateVoices(); if (playing) jump(cur); }
}

/* ================================================================ voices */

let edgeVoices = null;
const isZhLocale = l => /^zh/i.test(l);

function voiceLabel(v) {
  const name = v.id.replace(/^[a-z]+-[A-Za-z]+-/, '').replace(/Neural$/, '');
  return `${name} · ${v.locale} · ${v.gender === 'Female' ? 'F' : 'M'}`;
}

async function populateVoices() {
  const zhSel = $('#setZhVoice'), enSel = $('#setEnVoice');
  let zh, en, zhKey, enKey;
  if (settings.engine === 'edge') {
    if (!edgeVoices) {
      try { edgeVoices = await api('/api/voices'); }
      catch { edgeVoices = []; toast('Could not load voice list (offline?)'); }
    }
    const order = (a, b) => a.locale.localeCompare(b.locale) || a.id.localeCompare(b.id);
    zh = edgeVoices.filter(v => isZhLocale(v.locale)).sort(order).map(v => [v.id, voiceLabel(v)]);
    en = edgeVoices.filter(v => !isZhLocale(v.locale)).sort(order).map(v => [v.id, voiceLabel(v)]);
    zhKey = 'zhVoice'; enKey = 'enVoice';
  } else {
    const vs = speechSynthesis.getVoices();
    zh = vs.filter(v => isZhLocale(v.lang)).map(v => [v.name, `${v.name} (${v.lang})`]);
    en = vs.filter(v => /^en/i.test(v.lang)).map(v => [v.name, `${v.name} (${v.lang})`]);
    zhKey = 'bZh'; enKey = 'bEn';
  }
  const fill = (sel, list, key) => {
    if (!list.length) list = [[settings[key], settings[key] || '(default)']];
    sel.innerHTML = list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    sel.value = settings[key];
    if (sel.value !== settings[key]) settings[key] = sel.value;
    sel.onchange = () => { settings[key] = sel.value; saveSettings(!SYNCED.includes(key)); if (book) updateProgress(); if (playing) jump(cur); };
  };
  fill(zhSel, zh, zhKey);
  fill(enSel, en, enKey);
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => settings.engine === 'browser' && populateVoices();

const HAN = /[㐀-鿿豈-﫿]/g;
function isZh(text) {
  const han = (text.match(HAN) || []).length;
  if (!han) return false;
  const words = (text.match(/[A-Za-z]+/g) || []).length;
  return han >= words * 0.5;
}
const zhFor = t => settings.lang === 'zh' || (settings.lang === 'auto' && isZh(t));
const speakable = t => /[\p{L}\p{N}]/u.test(t);

/* ================================================================ book data */

let book = null;       // server JSON
let S = [];            // sentences: {p, t}
let P = [];            // paragraphs: {start, end, h, ch}
let cur = 0;
let marks = {};        // sentence index -> {t, at}
const selected = new Set();
let anchor = null;

function buildIndex(b) {
  S = []; P = [];
  const chStart = new Map(b.chapters.map((c, i) => [c.p, i]));
  let ch = 0;
  b.paras.forEach((para, pi) => {
    if (chStart.has(pi)) ch = chStart.get(pi);
    const start = S.length;
    for (const t of para.s) S.push({ p: pi, t });
    P.push({ start, end: S.length - 1, h: !!para.h, ch });
  });
}
const chapterOf = i => P[S[i].p].ch;
const chapterStartSentence = c => P[book.chapters[c].p].start;

/* ================================================================ state persistence */

let saveTimer = null;
function statePayload() { return JSON.stringify({ pos: cur }); }
function saveSoon() {
  if (!book) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
function saveNow() {
  if (!book) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  fetch(`/api/books/${book.id}/state`, { method: 'PUT', body: statePayload() }).catch(() => {});
}
addEventListener('pagehide', () => {
  if (book && saveTimer) navigator.sendBeacon(`/api/books/${book.id}/state`, new Blob([statePayload()], { type: 'application/json' }));
  flushReading(true);
});

// Marks are sent as changes, never as the whole set, so two devices can't overwrite each other.
async function sendMarks(add, remove) {
  const id = book.id;
  try {
    const r = await api(`/api/books/${id}/marks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ add, remove }),
    });
    if (book?.id === id) applyServerMarks(r.marks);
  } catch (e) { toast(`Could not save marks: ${e.message}`); }
}

function applyServerMarks(serverMarks) {
  const changed = new Set([...Object.keys(marks), ...Object.keys(serverMarks)]);
  marks = serverMarks;
  changed.forEach(i => refreshSentence(+i));
  renderStage();
  renderMarks();
}

// Coming back to a tab: pick up marks made on other devices meanwhile.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { flushReading(true); if (syncTimer) pushSettings(true); return; }
  pullSettings();
  if (!book) return;
  const id = book.id;
  api(`/api/books/${id}/state`).then(st => { if (book?.id === id) applyServerMarks(st.marks || {}); }).catch(() => {});
});

/* ================================================================ reading time */

// Listening time accumulates while playing and is flushed to the server every 30 s,
// on pause, on leaving the book and when the page is hidden. The day is the local date.
let listenSince = null, listenAcc = 0, sentencesAcc = 0, finishedFlag = false;
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function trackListening(on) {
  if (on && listenSince == null) listenSince = performance.now();
  if (!on && listenSince != null) { listenAcc += (performance.now() - listenSince) / 1000; listenSince = null; }
}
function flushReading(beacon = false) {
  if (!book) return;
  if (listenSince != null) { trackListening(false); trackListening(true); }
  if (listenAcc < 1 && !sentencesAcc && !finishedFlag) return;
  const body = JSON.stringify({ book: book.id, day: localDay(), seconds: Math.round(listenAcc * 10) / 10, sentences: sentencesAcc, finished: finishedFlag });
  listenAcc = 0; sentencesAcc = 0; finishedFlag = false;
  if (beacon) navigator.sendBeacon('/api/read', new Blob([body], { type: 'application/json' }));
  else fetch('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(checkAuth).catch(() => {});
}
setInterval(() => { if (playing || mode === 'read') flushReading(); }, 30000);
setInterval(() => { if (playing && book && !scrubbing) updateProgress(); }, 1000); // count down smoothly

/* ================================================================ time left */

// Speech time is modelled per clip as  overhead + pace × weight(text), where the weight counts
// characters (Han characters for Chinese voices, letters/digits for English ones) plus a little for
// each comma-like pause. Defaults were fitted on Xiaoxiao / Ava clips (3% / 9% error per clip);
// every clip that plays then nudges the pace for its voice, so estimates track the voice you use.
const PACE_DEFAULT = { zh: 0.202, en: 0.077 };   // seconds per weight unit at 1×
const CLIP_OVERHEAD = { zh: 0.95, en: 0.1 };     // leading/trailing silence per clip
const HAN_RE = /[\u3400-\u9fff\uf900-\ufaff]/g, LAT_RE = /[A-Za-z0-9]/g, BREATH_RE = /[，,；;：:、—]/g;
const count = (t, re) => (t.match(re) || []).length;
function speechWeight(t, zh) {
  return zh ? count(t, HAN_RE) + 0.35 * count(t, LAT_RE) + 1.2 * count(t, BREATH_RE)
            : count(t, LAT_RE) + 4 * count(t, BREATH_RE);
}
const paces = store.get('paces', {});
const voiceKey = zh => (settings.engine === 'edge' ? (zh ? settings.zhVoice : settings.enVoice) : `browser-${zh ? 'zh' : 'en'}`);
const paceFor = zh => paces[voiceKey(zh)] ?? PACE_DEFAULT[zh ? 'zh' : 'en'];

function learnPace(i, zh, seconds) {
  const w = speechWeight(S[i].t, zh), lang = zh ? 'zh' : 'en';
  if (w < 8 || !isFinite(seconds)) return;
  const r = (seconds - CLIP_OVERHEAD[lang]) / w;
  if (r < PACE_DEFAULT[lang] * 0.3 || r > PACE_DEFAULT[lang] * 3) return; // an outlier, not a pace
  const key = voiceKey(zh);
  paces[key] = (paces[key] ?? PACE_DEFAULT[lang]) * 0.92 + r * 0.08;
  store.set('paces', paces);
}

// Prefix sums over sentences, so any range is O(1): weight and clip count per voice language,
// and paragraph breaks. Rebuilt when a book opens or the language setting changes.
let TI = null;
function buildTimeIndex() {
  const n = S.length, z = new Float64Array(n + 1), e = new Float64Array(n + 1);
  const zn = new Uint32Array(n + 1), en = new Uint32Array(n + 1), pb = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const zh = zhFor(S[i].t), w = speechWeight(S[i].t, zh);
    z[i + 1] = z[i] + (zh ? w : 0); e[i + 1] = e[i] + (zh ? 0 : w);
    zn[i + 1] = zn[i] + (zh ? 1 : 0); en[i + 1] = en[i] + (zh ? 0 : 1);
    pb[i + 1] = pb[i] + (i > 0 && S[i].p !== S[i - 1].p ? 1 : 0);
  }
  TI = { z, e, zn, en, pb };
}

// Seconds to play sentences [from, to) at the current speed, pauses included.
function estimate(from, to) {
  if (!TI || to <= from) return 0;
  const d = a => a[to] - a[from];
  const speech = d(TI.z) * paceFor(true) + d(TI.zn) * CLIP_OVERHEAD.zh
               + d(TI.e) * paceFor(false) + d(TI.en) * CLIP_OVERHEAD.en;
  const pauses = ((to - from) * settings.gap + (TI.pb[to] - TI.pb[from + 1 > to ? to : from + 1]) * settings.paraGap) / 1000;
  return (speech + pauses) / settings.rate;
}

function fmtLeft(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return '<1 min';
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/* ================================================================ playback */

const audio = new Audio();
audio.preload = 'auto';
let playing = false;
let runId = 0;
let settle = null;       // resolves the sentence currently being spoken
let midSentence = false; // edge engine: paused in the middle of an audio clip
let lastError = '';

const audioCache = new Map(); // "voice\ntext" -> Promise<objectURL|null>
function audioFor(i) {
  const t = S[i].t;
  const voice = zhFor(t) ? settings.zhVoice : settings.enVoice;
  const key = voice + '\n' + t;
  let pr = audioCache.get(key);
  if (pr) { audioCache.delete(key); audioCache.set(key, pr); return pr; }
  pr = fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, text: t }),
  }).then(checkAuth).then(async r => {
    if (r.status === 204) return null;
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return URL.createObjectURL(await r.blob());
  });
  pr.catch(() => audioCache.delete(key));
  audioCache.set(key, pr);
  while (audioCache.size > 80) {
    const [oldKey, oldPr] = audioCache.entries().next().value;
    audioCache.delete(oldKey);
    oldPr.then(u => { if (u && audio.src !== u) URL.revokeObjectURL(u); }, () => {});
  }
  return pr;
}

function prefetch(from) {
  if (settings.engine !== 'edge') return;
  for (let k = 1; k <= 4 && from + k < S.length; k++) {
    if (speakable(S[from + k].t)) audioFor(from + k).catch(() => {});
  }
}

function speakEdge(i, id) {
  return new Promise(async resolve => {
    let done = false;
    const finish = r => { if (done) return; done = true; if (settle === finish) settle = null; midSentence = false; setLoading(false); resolve(r); };
    settle = finish;
    const t = S[i].t;
    if (!speakable(t)) { await sleep(450 / settings.rate); return finish('end'); }
    let url;
    setLoading(true);
    try { url = await audioFor(i); }
    catch (e) { lastError = e.message; return finish('error'); }
    setLoading(false);
    if (done || id !== runId) return finish('abort');
    if (!url) { await sleep(400); return finish('end'); }
    audio.onended = () => finish('end');
    audio.onerror = () => { lastError = 'could not play audio'; finish('error'); };
    audio.onloadedmetadata = () => learnPace(i, zhFor(t), audio.duration);
    audio.src = url;
    audio.defaultPlaybackRate = audio.playbackRate = settings.rate;
    audio.volume = settings.volume;
    midSentence = true;
    audio.play().catch(e => {
      if (e.name === 'AbortError') return;
      lastError = e.message;
      finish('error');
    });
  });
}

function speakBrowser(i) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (done) return; done = true; if (settle === finish) settle = null; resolve(r); };
    settle = finish;
    const t = S[i].t;
    if (!speakable(t)) { sleep(450 / settings.rate).then(() => finish('end')); return; }
    const zh = zhFor(t);
    const u = new SpeechSynthesisUtterance(t);
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find(v => v.name === (zh ? settings.bZh : settings.bEn))
      || voices.find(v => (zh ? isZhLocale(v.lang) : /^en/i.test(v.lang))) || null;
    u.lang = u.voice?.lang || (zh ? 'zh-CN' : 'en-US');
    u.rate = settings.rate;
    u.volume = settings.volume;
    let t0 = 0;
    u.onstart = () => { t0 = performance.now(); };
    u.onend = () => { if (t0) learnPace(i, zh, (performance.now() - t0) / 1000 * u.rate); finish('end'); };
    u.onerror = e => finish(e.error === 'interrupted' || e.error === 'canceled' ? 'abort' : (lastError = e.error, 'error'));
    speakBrowser.keep = u; // Chrome drops events for garbage-collected utterances
    speechSynthesis.speak(u);
  });
}

async function loop(id) {
  while (id === runId && playing) {
    prefetch(cur);
    const r = settings.engine === 'edge' ? await speakEdge(cur, id) : await speakBrowser(cur);
    if (id !== runId || !playing) return;
    if (r === 'error') {
      setPlaying(false);
      toast(settings.engine === 'edge'
        ? `Speech failed: ${lastError}. Check your connection, or switch Engine to “Browser built-in” in settings.`
        : `Speech failed: ${lastError}`, 7000);
      return;
    }
    sentencesAcc++;
    if (cur >= S.length - 1) { finishedFlag = true; setPlaying(false); toast('End of book'); return; }
    const next = cur + 1;
    const newPara = S[next].p !== S[cur].p;
    const gap = settings.gap + (newPara ? settings.paraGap : 0);
    setCur(next);
    if (newPara && settings.paraGap > 0) setBlank(true);
    await sleep(gap / settings.rate);
    if (id !== runId || !playing) return;
    setBlank(false);
  }
}

const setBlank = on => $('.screen').classList.toggle('blank', on);

function halt() {
  setBlank(false);
  audio.onended = audio.onerror = null;
  audio.pause();
  midSentence = false;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  const s = settle;
  settle = null;
  s?.('abort');
  setLoading(false);
}

function setPlaying(v) {
  playing = v;
  trackListening(v);
  if (!v) flushReading();
  document.body.classList.toggle('paused', !v);
  $('#btnPlay use').setAttribute('href', v ? '#i-pause' : '#i-play');
  $('#btnPlay').title = v ? 'Pause (Space)' : 'Play (Space)';
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = v ? 'playing' : 'paused';
}
function setLoading(v) { $('#btnPlay').classList.toggle('loading', v && playing); }

function play() {
  if (!book || playing) return;
  setPlaying(true);
  if (midSentence && settings.engine === 'edge') { audio.play().catch(() => {}); return; }
  loop(++runId);
}
function pause() {
  if (!playing) return;
  setPlaying(false);
  if (midSentence && settings.engine === 'edge' && !audio.ended) { audio.pause(); return; }
  runId++;
  halt();
}
const toggle = () => (playing ? pause() : play());

/* ================================================================ full screen */

let idleTimer;
function setCinema(on) {
  if (on === document.body.classList.contains('cinema')) return;
  document.body.classList.toggle('cinema', on);
  if (on) {
    document.activeElement?.blur();
    const fs = document.documentElement.requestFullscreen?.();
    if (fs) fs.catch(() => document.body.classList.add('no-fs')); // the class alone still works if refused
    else document.body.classList.add('no-fs');
    pokeIdle();
  } else {
    clearTimeout(idleTimer);
    document.body.classList.remove('idle', 'no-fs');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    requestAnimationFrame(() => scrollToCurrent('instant'));
  }
}
function pokeIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 1500);
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setCinema(false); });
document.addEventListener('mousemove', () => document.body.classList.contains('cinema') && pokeIdle());
function stopAll() { pause(); runId++; halt(); }

function jump(i, autoplay = false) {
  if (!book) return;
  runId++;
  halt();
  setCur(clamp(i, 0, S.length - 1), { scroll: 'jump' });
  if (autoplay && !playing) setPlaying(true);
  if (playing) loop(runId);
}
function jumpPara(dir) {
  const p = S[cur].p;
  if (dir < 0) jump(cur > P[p].start ? P[p].start : P[Math.max(0, p - 1)].start);
  else jump(P[Math.min(P.length - 1, p + 1)].start);
}

/* ================================================================ rendering: stage */

function setCur(i, opts = {}) {
  cur = i;
  renderStage();
  if (mode === 'read' && opts.scroll !== 'read') renderRead(cur);
  updateContext(opts.scroll);
  updateOutline();
  updateProgress();
  saveSoon();
  if ('mediaSession' in navigator && book) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S[cur].t.slice(0, 80), artist: book.author, album: `${book.title} · ${book.chapters[chapterOf(cur)]?.title || ''}`,
    });
  }
}

function renderStage() {
  const s = S[cur];
  const sub = $('#subtitle');
  sub.textContent = s.t;
  sub.lang = isZh(s.t) ? 'zh-CN' : 'en';
  sub.classList.toggle('heading', P[s.p].h);
  sub.classList.toggle('marked', cur in marks);

  const prev = $('#prevLine');
  const showPrev = settings.showPrev && cur > 0 && chapterOf(cur - 1) === chapterOf(cur);
  prev.textContent = showPrev ? S[cur - 1].t : '';
  prev.lang = showPrev && isZh(S[cur - 1].t) ? 'zh-CN' : 'en';
  prev.hidden = !settings.showPrev;

  const ch = chapterOf(cur);
  if ($('#chapterSelect').value !== String(ch)) $('#chapterSelect').value = ch;
  const btn = $('#btnMarkCur');
  btn.classList.toggle('on', cur in marks);
  $('use', btn).setAttribute('href', cur in marks ? '#i-mark-on' : '#i-mark');
  $('span', btn).textContent = cur in marks ? 'Marked' : 'Mark';
  const cm = $('#cinemaMark');
  cm.classList.toggle('on', cur in marks);
  $('use', cm).setAttribute('href', cur in marks ? '#i-mark-on' : '#i-mark');
  cm.title = cur in marks ? 'Unmark (X)' : 'Mark (X)';
}

let scrubbing = false;
function updateProgress() {
  const bar = $('#progress');
  if (!scrubbing) bar.value = cur;
  showProgress(scrubbing ? +bar.value : cur);
}
function showProgress(i) {
  const ch = chapterOf(i);
  const c = book.chapters[ch];
  const cStart = P[c.p].start;
  const cEnd = ch + 1 < book.chapters.length ? chapterStartSentence(ch + 1) - 1 : S.length - 1;
  const pct = `${(100 * i / Math.max(1, S.length - 1)).toFixed(1)}%`;
  $('#progressLeft').textContent = scrubbing ? `→ ${c.title}: ${S[i].t}` : `${c.title} · ${i - cStart + 1} / ${cEnd - cStart + 1} · ${pct}`;
  // time left from sentence i, minus what has already played of it
  const played = !scrubbing && i === cur && (playing || midSentence) && isFinite(audio.currentTime) ? audio.currentTime / settings.rate : 0;
  const chLeft = Math.max(0, estimate(i, cEnd + 1) - played), bookLeft = Math.max(0, estimate(i, S.length) - played);
  $('#progressRight').textContent = `${fmtLeft(chLeft)} left in chapter · ${fmtLeft(bookLeft)} in book`;
  $('#progressRight').title = 'Estimated at your current speed, including pauses';
}

/* ================================================================ rendering: context sidebar */

const WINDOW = 25;   // paragraphs either side of the current one
let win = { lo: 0, hi: -1 };
let follow = true;
let programmaticScroll = 0;

function sentHtml(i) {
  const cls = ['sent'];
  if (i in marks) cls.push('marked');
  if (selected.has(i)) cls.push('sel');
  if (i === cur) cls.push('cur');
  return `<span class="${cls.join(' ')}" data-i="${i}">${esc(S[i].t)}</span>`;
}

function renderContext() {
  const chStarts = new Set(book.chapters.map(c => c.p));
  let html = win.lo > 0 ? '<button class="more" data-more="-1">Show earlier</button>' : '';
  for (let p = win.lo; p <= win.hi; p++) {
    if (chStarts.has(p) || p === win.lo) html += `<div class="ctx-chapter">${esc(book.chapters[P[p].ch].title)}</div>`;
    let inner = '';
    for (let i = P[p].start; i <= P[p].end; i++) {
      const prevT = i > P[p].start ? S[i - 1].t : '';
      const joinCjk = /[　-鿿＀-￯]$/.test(prevT) || /^[　-鿿＀-￯]/.test(S[i].t);
      inner += (prevT && !joinCjk ? ' ' : '') + sentHtml(i);
    }
    html += `<p class="${P[p].h ? 'h' : ''}" lang="${isZh(S[P[p].start].t) ? 'zh-CN' : 'en'}">${inner}</p>`;
  }
  if (win.hi < P.length - 1) html += '<button class="more" data-more="1">Show later</button>';
  $('#context').innerHTML = html;
}

function updateContext(scroll) {
  if (!book) return;
  const p = S[cur].p;
  const nearTop = p < win.lo + 3 && win.lo > 0;
  const nearBottom = p > win.hi - 3 && win.hi < P.length - 1;
  if (p < win.lo || p > win.hi || ((nearTop || nearBottom) && follow)) {
    win = { lo: Math.max(0, p - WINDOW), hi: Math.min(P.length - 1, p + WINDOW) };
    renderContext();
  } else {
    $('#context .sent.cur')?.classList.remove('cur');
    $(`#context [data-i="${cur}"]`)?.classList.add('cur');
  }
  if (scroll === 'jump') follow = true;
  if (follow) scrollToCurrent(scroll === 'jump' || scroll === 'instant' ? 'instant' : 'smooth');
  $('#btnFollow').hidden = follow;
}

function scrollToCurrent(behavior = 'smooth') {
  const el = $(`#context [data-i="${cur}"]`);
  const box = $('#context');
  if (!el || !settings.sidebar || box.offsetParent === null) return;
  const top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
  programmaticScroll = Date.now();
  box.scrollTo({ top, behavior });
}

function refreshSentence(i) {
  $(`#readText [data-i="${i}"]`)?.classList.toggle('marked', i in marks);
  const el = $(`#context [data-i="${i}"]`);
  if (!el) return;
  el.classList.toggle('marked', i in marks);
  el.classList.toggle('sel', selected.has(i));
}

function updateSelBar() {
  const n = selected.size;
  $('#selBar').hidden = n === 0;
  $('#selCount').textContent = `${n} selected`;
  const allMarked = n > 0 && [...selected].every(i => i in marks);
  $('#selMark').hidden = allMarked;
}

function clearSelection() {
  const old = [...selected];
  selected.clear();
  anchor = null;
  old.forEach(refreshSentence);
  updateSelBar();
}

function setMarks(indices, on) {
  const add = {}, remove = [];
  for (const i of indices) {
    if (on && !(i in marks)) add[i] = marks[i] = { t: S[i].t, at: Date.now() };
    else if (!on && i in marks) { delete marks[i]; remove.push(i); }
    refreshSentence(i);
  }
  renderStage();
  renderMarks();
  if (Object.keys(add).length || remove.length) sendMarks(add, remove);
}

/* ================================================================ outline pane */

let OL = [];               // {title, depth, s (first sentence), parent, kids}
let olCollapsed = new Set();
let olCur = -1;

function buildOutline(b) {
  const src = b.outline?.length ? b.outline : b.chapters.map(c => ({ title: c.title, depth: 0, p: c.p }));
  OL = [];
  const stack = []; // indices of open ancestors, compared by the TOC's own depth
  src.forEach(o => {
    while (stack.length && src[stack.at(-1)].depth >= o.depth) stack.pop();
    const parent = stack.length ? stack.at(-1) : -1;
    OL.push({ title: o.title, s: P[o.p].start, parent, kids: 0, depth: parent < 0 ? 0 : OL[parent].depth + 1 });
    if (parent >= 0) OL[parent].kids++;
    stack.push(OL.length - 1);
  });
  // Small outlines start fully open; big ones show parts and chapters, folding anything deeper.
  olCollapsed = new Set(OL.length > 80 ? OL.map((n, i) => (n.kids && n.depth >= 1 ? i : -1)).filter(i => i >= 0) : []);
  olCur = -1;
  $('#outlineExpand').hidden = !OL.some(n => n.kids);
}

function outlineAt(i) {
  let best = -1;
  OL.forEach((n, k) => { if (n.s <= i && (best < 0 || n.s >= OL[best].s)) best = k; });
  return best;
}

function renderOutline() {
  const q = $('#outlineFilter').value.trim().toLowerCase();
  let visible;
  if (q) {
    const show = new Set();
    OL.forEach((n, i) => { if (n.title.toLowerCase().includes(q)) for (let k = i; k >= 0; k = OL[k].parent) show.add(k); });
    visible = i => show.has(i);
  } else {
    visible = i => { for (let k = OL[i].parent; k >= 0; k = OL[k].parent) if (olCollapsed.has(k)) return false; return true; };
  }
  const curS = olCur >= 0 ? OL[olCur].s : -1;
  const hi = t => {
    if (!q) return esc(t);
    const at = t.toLowerCase().indexOf(q);
    return at < 0 ? esc(t) : esc(t.slice(0, at)) + `<mark>${esc(t.slice(at, at + q.length))}</mark>` + esc(t.slice(at + q.length));
  };
  let html = '';
  OL.forEach((n, i) => {
    if (!visible(i)) return;
    const cls = ['ol-row'];
    if (q && n.title.toLowerCase().includes(q)) cls.push('hit');
    if (i === olCur) cls.push('cur');
    else if (n.s < curS) cls.push('read');
    const open = q || !olCollapsed.has(i);
    html += `<div class="${cls.join(' ')}" role="treeitem" aria-level="${n.depth + 1}" ${n.kids ? `aria-expanded="${!!open}"` : ''} style="--d:${n.depth}" lang="${isZh(n.title) ? 'zh-CN' : 'en'}">`
      + (n.kids ? `<button class="ol-toggle" data-toggle="${i}" aria-label="${open ? 'Collapse' : 'Expand'}"><svg><use href="#i-next"/></svg></button>` : '<span class="ol-toggle"></span>')
      + `<button class="ol-title" data-go="${i}">${hi(n.title)}</button>`
      + `<span class="ol-pct num">${Math.round(100 * n.s / Math.max(1, S.length - 1))}%</span></div>`;
  });
  $('#outline').innerHTML = html || '<p class="empty">No matching sections.</p>';
  $('#outlineExpand').textContent = olCollapsed.size ? 'Expand all' : 'Collapse all';
}

function updateOutline() {
  const k = outlineAt(cur);
  if (k === olCur && $('#outline').childElementCount) return;
  olCur = k;
  for (let a = k >= 0 ? OL[k].parent : -1; a >= 0; a = OL[a].parent) olCollapsed.delete(a);
  renderOutline();
  scrollOutline();
}

function scrollOutline() {
  const row = $('#outline .ol-row.cur');
  if (row && !$('#pane-outline').hidden && settings.sidebar) row.scrollIntoView({ block: 'nearest' });
}

function showTab(name) {
  if (!['outline', 'context', 'marks'].includes(name)) name = 'context';
  $$('.tab').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name));
  for (const p of ['outline', 'context', 'marks']) $(`#pane-${p}`).hidden = p !== name;
  if (settings.sideTab !== name) { settings.sideTab = name; saveSettings(true); }
  requestAnimationFrame(() => {
    if (name === 'context' && follow) scrollToCurrent('instant');
    if (name === 'outline') { const r = $('#outline .ol-row.cur'); r?.scrollIntoView({ block: 'center' }); }
  });
}

/* ================================================================ marks pane */

// This book's marks as passages (consecutive sentences merged, see mergeRuns in pages.js).
function markPassages() {
  const idx = Object.keys(marks).map(Number).filter(i => i < S.length).sort((a, b) => a - b);
  return mergeRuns(idx.map(i => ({ i, t: S[i].t, ch: chapterOf(i), p: S[i].p, at: marks[i].at })));
}

function renderMarks() {
  const passages = markPassages();
  $('#markCount').textContent = passages.length || '';
  if (!passages.length) {
    $('#marksList').innerHTML = '<p class="empty">No marks yet. Press <kbd>X</kbd> while listening, or select sentences in Context.</p>';
    return;
  }
  let html = '', lastCh = -1;
  for (const m of passages) {
    if (m.ch !== lastCh) { html += `<h4>${esc(book.chapters[m.ch].title)}</h4>`; lastCh = m.ch; }
    html += `<div class="mark-item" role="button" tabindex="0" data-i="${m.i}" lang="${isZh(m.t) ? 'zh-CN' : 'en'}">
      <span class="t">${esc(m.t)}</span>
      <button class="icon-btn sm" data-unmark="${m.ids.join(',')}" title="Remove mark"><svg><use href="#i-x"/></svg></button></div>`;
  }
  $('#marksList').innerHTML = html;
}

function marksMarkdown() {
  let md = `# ${book.title}${book.author ? ' — ' + book.author : ''}\n`, lastCh = -1;
  for (const m of markPassages()) {
    if (m.ch !== lastCh) { md += `\n## ${book.chapters[m.ch].title}\n\n`; lastCh = m.ch; }
    md += `${quoteMd(m.t)}\n\n`;
  }
  return md;
}

async function copyText(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Copied ${what}`); }
  catch { toast('Clipboard not available'); }
}

/* ================================================================ read mode */

// True if the range covers part of el's text, not merely touches its edge.
function rangeCovers(range, el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  return range.compareBoundaryPoints(Range.START_TO_END, r) > 0 && range.compareBoundaryPoints(Range.END_TO_START, r) < 0;
}

// The same book as flowing text. Chapters are rendered on demand as you scroll; the sentence at
// the top of the screen is the reading position, shared with Watch mode.
let mode = store.get('mode', 'watch');
let readLo = -1, readHi = -1;  // chapters currently rendered
let readActive = 0;           // last scroll/touch/key in the reading view
const READ_TOP = 72;          // px from the top of the view where the reading position sits
let readQuietUntil = 0;       // programmatic scrolls don't move the reading position

function chapterEnd(ch) { return ch + 1 < book.chapters.length ? chapterStartSentence(ch + 1) - 1 : S.length - 1; }

function chapterHtml(ch) {
  const c = book.chapters[ch];
  const lastPara = ch + 1 < book.chapters.length ? book.chapters[ch + 1].p - 1 : P.length - 1;
  let html = `<section data-ch="${ch}">`;
  if (!P[c.p].h) html += `<h2 class="ch-title">${esc(c.title)}</h2>`; // books usually open a chapter with its own heading
  for (let p = c.p; p <= lastPara; p++) {
    let inner = '';
    for (let i = P[p].start; i <= P[p].end; i++) {
      const prevT = i > P[p].start ? S[i - 1].t : '';
      const joinCjk = /[\u3000-\u9fff\uff00-\uffef]$/.test(prevT) || /^[\u3000-\u9fff\uff00-\uffef]/.test(S[i].t);
      inner += (prevT && !joinCjk ? ' ' : '') + `<span class="s${i in marks ? ' marked' : ''}" data-i="${i}">${esc(S[i].t)}</span>`;
    }
    html += `<p class="${P[p].h ? 'h' : ''}" lang="${isZh(S[P[p].start].t) ? 'zh-CN' : 'en'}">${inner}</p>`;
  }
  return html + '</section>';
}

function renderRead(i) {
  const view = $('#readView'), text = $('#readText');
  const ch = chapterOf(i);
  readLo = readHi = ch;
  text.innerHTML = chapterHtml(ch);
  fillRead();
  const el = $(`#readText [data-i="${i}"]`);
  if (el) {
    readQuietUntil = Date.now() + 400;
    view.scrollTop += el.getBoundingClientRect().top - view.getBoundingClientRect().top - READ_TOP;
    // show where you are for a moment
    el.classList.add('here');
    setTimeout(() => el.classList.add('fade'), 900);
    setTimeout(() => el.classList.remove('here', 'fade'), 2400);
  }
  updateReadStatus();
}

// Keep a screenful of text beyond both edges; prepending keeps the view still.
function fillRead() {
  const view = $('#readView'), text = $('#readText');
  while (readHi < book.chapters.length - 1 && view.scrollHeight - view.scrollTop - view.clientHeight < 1500) {
    text.insertAdjacentHTML('beforeend', chapterHtml(++readHi));
  }
  while (readLo > 0 && view.scrollTop < 1200) {
    const before = view.scrollHeight;
    text.insertAdjacentHTML('afterbegin', chapterHtml(--readLo));
    view.scrollTop += view.scrollHeight - before;
  }
}

function sentenceAtTop() {
  const r = $('#readView').getBoundingClientRect();
  for (let y = r.top + READ_TOP + 6; y < r.top + READ_TOP + 200; y += 14) {
    for (const x of [r.left + r.width / 2, r.left + r.width * 0.3, r.left + r.width * 0.7]) {
      const s = document.elementFromPoint(x, y)?.closest?.('#readText .s');
      if (s) return +s.dataset.i;
    }
  }
  return null;
}

function updateReadStatus() {
  const c = book.chapters[chapterOf(cur)];
  $('#readStatus').textContent = `${c.title} · ${(100 * cur / Math.max(1, S.length - 1)).toFixed(1)}%`;
}

let readScrollTimer = null;
function onReadScroll() {
  readActive = Date.now();
  hideReadBar();
  if (readScrollTimer) return;
  readScrollTimer = setTimeout(() => {
    readScrollTimer = null;
    if (mode !== 'read' || !book) return;
    fillRead();
    if (Date.now() < readQuietUntil) return;
    const i = sentenceAtTop();
    if (i != null && i !== cur) { setCur(i, { scroll: 'read' }); updateReadStatus(); }
  }, 200);
}

function setMode(m) {
  mode = m === 'read' ? 'read' : 'watch';
  store.set('mode', mode);
  document.body.classList.toggle('mode-read', mode === 'read');
  $$('.mode-switch button').forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode));
  if (!book) return;
  if (mode === 'read') {
    stopAll();
    renderRead(cur);
    readActive = Date.now();
    $('#readView').focus({ preventScroll: true }); // so Space / arrows scroll the text
  } else {
    hideReadBar();
    renderStage();
    updateProgress();
  }
}

// Selecting text in the reading view offers Mark / Unmark / Copy / Listen from here.
let readSel = [];
function checkReadSelection() {
  const sel = getSelection();
  if (mode !== 'read' || !sel.rangeCount || sel.isCollapsed || !$('#readText').contains(sel.anchorNode)) { hideReadBar(); return; }
  const range = sel.getRangeAt(0);
  const hit = [];
  for (const sec of $$('#readText section')) {
    if (!range.intersectsNode(sec)) continue;
    for (const s of $$('.s', sec)) if (rangeCovers(range, s)) hit.push(+s.dataset.i);
  }
  if (!hit.length) { hideReadBar(); return; }
  readSel = hit;
  const bar = $('#readBar');
  bar.querySelector('[data-rb="mark"]').hidden = hit.every(i => i in marks);
  bar.querySelector('[data-rb="unmark"]').hidden = !hit.some(i => i in marks);
  bar.hidden = false;
  const rect = range.getBoundingClientRect(), bw = bar.offsetWidth, bh = bar.offsetHeight;
  const top = rect.top - bh - 10 > 64 ? rect.top - bh - 10 : rect.bottom + 10;
  bar.style.top = `${Math.min(top, innerHeight - bh - 8)}px`;
  bar.style.left = `${clamp(rect.left + rect.width / 2 - bw / 2, 8, innerWidth - bw - 8)}px`;
}
function hideReadBar() { $('#readBar').hidden = true; readSel = []; }

function readBarAction(act) {
  if (!readSel.length) return;
  const ids = [...readSel];
  if (act === 'mark') setMarks(ids, true);
  if (act === 'unmark') setMarks(ids, false);
  if (act === 'copy') copyText(ids.map(i => S[i].t).join(' '), 'selection');
  getSelection().removeAllRanges();
  hideReadBar();
  if (act === 'listen') { setMode('watch'); jump(ids[0], true); }
}

// Active reading counts as reading time: page visible and touched/scrolled within the last minute.
setInterval(() => {
  if (mode === 'read' && book && !$('#reader').hidden && document.visibilityState === 'visible' && Date.now() - readActive < 60000) {
    listenAcc += 5;
  }
}, 5000);

/* ================================================================ library */

function showView(name) {
  for (const v of ['library', 'reader', 'highlights', 'stats', 'account']) $('#' + v).hidden = v !== name;
}

function leaveBook() {
  if (!book) return;
  stopAll();
  saveNow();
  flushReading();
  book = null;
}

async function showLibrary() {
  setCinema(false);
  leaveBook();
  document.title = 'Book Watcher';
  showView('library');
  $('#settings').hidden = true;
  let books = [];
  try { books = await api('/api/books'); } catch (e) { toast(e.message); }
  $('#bookList').innerHTML = books.length ? books.map(b => {
    const pct = b.sentences ? Math.round(100 * b.pos / Math.max(1, b.sentences - 1)) : 0;
    return `<a class="book" href="#/book/${b.id}">
      <h3>${esc(b.title)}</h3>
      ${b.author ? `<div class="by">${esc(b.author)}</div>` : ''}
      <div class="meta">${pct}% read · ${b.sentences.toLocaleString()} sentences${b.marks ? ` · ${b.marks} marked` : ''}</div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <button class="icon-btn sm del" data-del="${b.id}" title="Remove from library"><svg><use href="#i-x"/></svg></button>
    </a>`;
  }).join('') : '<p class="empty">Your library is empty.</p>';
}

async function uploadFiles(files) {
  files = [...files].filter(f => /\.epub$/i.test(f.name) || f.type === 'application/epub+zip');
  if (!files.length) { toast('Please choose an .epub file'); return; }
  const dz = $('#dropzone');
  dz.classList.add('busy');
  let lastId = null;
  for (const f of files) {
    $('strong', dz).textContent = `Reading ${f.name}…`;
    try {
      const r = await api('/api/books', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(f.name) }, body: f });
      lastId = r.id;
    } catch (e) { toast(e.message, 6000); }
  }
  dz.classList.remove('busy');
  $('strong', dz).textContent = 'Drop an EPUB here';
  if (lastId && files.length === 1) location.hash = `#/book/${lastId}`;
  else showLibrary();
}

/* ================================================================ reader */

async function openBook(id, at) {
  let b, st;
  try { [b, st] = await Promise.all([api(`/api/books/${id}`), api(`/api/books/${id}/state`)]); }
  catch (e) { toast(e.message); location.hash = '#/'; return; }
  book = b;
  buildIndex(b);
  marks = st.marks || {};
  selected.clear();
  anchor = null;
  follow = true;
  win = { lo: 0, hi: -1 };
  document.title = `${b.title} · Book Watcher`;
  $('#bookTitle').textContent = b.title;
  $('#chapterSelect').innerHTML = b.chapters.map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('');
  $('#progress').max = S.length - 1;
  buildOutline(b);
  buildTimeIndex();
  $('#outlineFilter').value = '';
  showView('reader');
  setCur(clamp(at ?? st.pos ?? 0, 0, S.length - 1), { scroll: 'instant' });
  setMode(mode);
  renderMarks();
  updateSelBar();
  saveNow();
}

function route() {
  // #/book/<id> opens a book; #/book/<id>/<n> opens it at sentence n (links from Highlights)
  const m = location.hash.match(/^#\/book\/([0-9a-f]{12})(?:\/(\d+))?/);
  if (m) {
    const at = m[2] != null ? +m[2] : undefined;
    if (book?.id !== m[1]) { leaveBook(); setCinema(false); openBook(m[1], at); }
    else if (at != null) jump(at);
    if (at != null) history.replaceState(null, '', `#/book/${m[1]}`);
    return;
  }
  if (location.hash === '#/highlights') { setCinema(false); leaveBook(); showHighlights(); return; }
  if (location.hash === '#/stats') { setCinema(false); leaveBook(); showStats(); return; }
  if (location.hash === '#/account') { setCinema(false); leaveBook(); showAccount(); return; }
  showLibrary();
}

/* ================================================================ events */

function bindRange(sel, key, parse = Number) {
  $(sel).addEventListener('input', e => setSetting(key, parse(e.target.value)));
}

// Installable app: register the service worker; offer "Install app" where the browser allows it.
let installPrompt = null;
function initPwa() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('#btnInstall').hidden = false; });
  addEventListener('appinstalled', () => { installPrompt = null; $('#btnInstall').hidden = true; });
  $('#btnInstall').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('#btnInstall').hidden = true;
  });
}

let ME = null; // {id, name, admin, accounts}

function init() {
  applySettings();
  initPages();
  initPwa();
  api('/api/me').then(me => {
    ME = me;
    $('#userBar').hidden = !me.accounts;
    $('#userName').textContent = me.name;
    pullSettings();
  }).catch(() => {});
  populateVoices();

  // library
  $('#fileInput').addEventListener('change', e => { uploadFiles(e.target.files); e.target.value = ''; });
  const dz = $('#dropzone');
  addEventListener('dragover', e => { e.preventDefault(); if (!$('#library').hidden) dz.classList.add('over'); });
  addEventListener('dragleave', e => { if (!e.relatedTarget) dz.classList.remove('over'); });
  addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    if (e.dataTransfer?.files.length) uploadFiles(e.dataTransfer.files);
  });
  $('#bookList').addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    e.preventDefault();
    const title = $('h3', del.closest('.book')).textContent;
    if (!confirm(`Remove “${title}” and its marks from the library?`)) return;
    await api(`/api/books/${del.dataset.del}`, { method: 'DELETE' }).catch(err => toast(err.message));
    showLibrary();
  });

  // transport
  $('#btnPlay').addEventListener('click', toggle);
  $('#btnPrev').addEventListener('click', () => jump(cur - 1));
  $('#btnNext').addEventListener('click', () => jump(cur + 1));
  $('#btnPrevPara').addEventListener('click', () => jumpPara(-1));
  $('#btnNextPara').addEventListener('click', () => jumpPara(1));
  $('#btnMarkCur').addEventListener('click', () => setMarks([cur], !(cur in marks)));
  $('#btnLibrary').addEventListener('click', () => (location.hash = '#/'));
  $('#btnFull').addEventListener('click', () => setCinema(true));
  $$('.mode-switch button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  const rv = $('#readView');
  rv.addEventListener('scroll', onReadScroll, { passive: true });
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) rv.addEventListener(ev, () => { readActive = Date.now(); }, { passive: true });
  document.addEventListener('selectionchange', () => { clearTimeout(checkReadSelection.t); checkReadSelection.t = setTimeout(checkReadSelection, 250); });
  $('#readBar').addEventListener('pointerdown', e => e.preventDefault()); // keep the text selection while clicking
  $('#readBar').addEventListener('click', e => { const b = e.target.closest('[data-rb]'); if (b) readBarAction(b.dataset.rb); });
  setMode(mode);
  // in full screen: click anywhere to play/pause, double-click to leave
  $('.screen').addEventListener('click', e => {
    if (!document.body.classList.contains('cinema') || e.target.closest('.corner-btn')) return;
    const x = e.clientX / window.innerWidth;
    if (x < 1 / 3) jump(cur - 1);
    else if (x > 2 / 3) jump(cur + 1);
    else toggle();
  });
  $('#cinemaMark').addEventListener('click', e => { e.currentTarget.blur(); setMarks([cur], !(cur in marks)); });
  $('#cinemaExit').addEventListener('click', () => setCinema(false));
  $('#chapterSelect').addEventListener('change', e => jump(chapterStartSentence(+e.target.value)));

  const bar = $('#progress');
  bar.addEventListener('input', () => { scrubbing = true; showProgress(+bar.value); });
  bar.addEventListener('change', () => { scrubbing = false; jump(+bar.value); });

  // quick controls + settings
  $('#rateQuick').addEventListener('input', e => setSetting('rate', +e.target.value));
  $('#volQuick').addEventListener('input', e => setSetting('volume', +e.target.value));
  bindRange('#setRate', 'rate');
  bindRange('#setVol', 'volume');
  bindRange('#setSize', 'size');
  bindRange('#setSideSize', 'sideSize');
  bindRange('#setReadSize', 'readSize');
  bindRange('#setGap', 'gap');
  bindRange('#setParaGap', 'paraGap');
  $('#setFont').addEventListener('change', e => setSetting('font', e.target.value));
  $('#setTheme').addEventListener('change', e => setSetting('theme', e.target.value));
  $('#setPrev').addEventListener('change', e => setSetting('showPrev', e.target.checked));
  $('#setEngine').addEventListener('change', e => setSetting('engine', e.target.value));
  $('#setLang').addEventListener('change', e => { setSetting('lang', e.target.value); if (playing) jump(cur); });
  $('#btnSettings').addEventListener('click', () => ($('#settings').hidden = !$('#settings').hidden));
  $('#closeSettings').addEventListener('click', () => ($('#settings').hidden = true));
  document.addEventListener('pointerdown', e => {
    const s = $('#settings');
    if (!s.hidden && !s.contains(e.target) && !e.target.closest('#btnSettings')) s.hidden = true;
  });
  $('#testVoice').addEventListener('click', async () => {
    const wasPlaying = playing;
    pause();
    const saved = { S, cur };
    S = [{ p: 0, t: '你好，这是中文语音。' }, { p: 0, t: 'And this is the English voice.' }];
    try {
      for (let i = 0; i < S.length; i++) {
        const r = settings.engine === 'edge' ? await testEdge(i) : await speakBrowser(i);
        if (r === 'error') { toast(`Speech failed: ${lastError}`); break; }
      }
    } finally {
      S = saved.S; cur = saved.cur;
      if (wasPlaying) play();
    }
  });

  // sidebar
  const toggleSidebar = () => {
    setSetting('sidebar', !settings.sidebar);
    if (settings.sidebar) requestAnimationFrame(() => { scrollToCurrent('instant'); scrollOutline(); });
  };
  $('#btnSidebar').addEventListener('click', toggleSidebar);
  $('#btnFold').addEventListener('click', toggleSidebar);
  $$('.tab').forEach(tab => tab.addEventListener('click', () => showTab(tab.dataset.tab)));
  showTab(settings.sideTab);

  // outline
  $('#outline').addEventListener('click', e => {
    const t = e.target.closest('[data-toggle]');
    if (t) {
      const i = +t.dataset.toggle;
      olCollapsed.has(i) ? olCollapsed.delete(i) : olCollapsed.add(i);
      renderOutline();
      return;
    }
    const go = e.target.closest('[data-go]');
    if (go) jump(OL[+go.dataset.go].s);
  });
  $('#outlineFilter').addEventListener('input', renderOutline);
  $('#outlineFilter').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#outline .hit [data-go]')?.click();
    if (e.key === 'Escape') { e.target.value = ''; renderOutline(); e.target.blur(); }
  });
  $('#outlineExpand').addEventListener('click', () => {
    const parents = OL.map((n, i) => (n.kids ? i : -1)).filter(i => i >= 0);
    olCollapsed = olCollapsed.size ? new Set() : new Set(parents);
    renderOutline();
  });

  const ctx = $('#context');
  let suppressClick = false;
  ctx.addEventListener('scroll', () => {
    if (Date.now() - programmaticScroll < 900) return;
    follow = false;
    $('#btnFollow').hidden = false;
  }, { passive: true });
  $('#btnFollow').addEventListener('click', () => {
    follow = true;
    $('#btnFollow').hidden = true;
    updateContext('jump');
  });
  ctx.addEventListener('mouseup', e => {
    if (e.detail > 1) return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const hit = $$('.sent', ctx).filter(s => rangeCovers(range, s)).map(s => +s.dataset.i);
    if (!hit.length) return;
    hit.forEach(i => selected.add(i));
    hit.forEach(refreshSentence);
    anchor = hit[hit.length - 1];
    sel.removeAllRanges();
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    updateSelBar();
  });
  ctx.addEventListener('click', e => {
    const more = e.target.closest('[data-more]');
    if (more) {
      const d = +more.dataset.more;
      const keep = ctx.scrollHeight - ctx.scrollTop;
      if (d < 0) win.lo = Math.max(0, win.lo - WINDOW); else win.hi = Math.min(P.length - 1, win.hi + WINDOW);
      follow = false;
      renderContext();
      if (d < 0) ctx.scrollTop = ctx.scrollHeight - keep;
      $('#btnFollow').hidden = false;
      return;
    }
    const s = e.target.closest('.sent');
    if (!s || suppressClick || e.detail > 1) return;
    const i = +s.dataset.i;
    if (e.shiftKey && anchor != null) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = a; k <= b; k++) { selected.add(k); refreshSentence(k); }
    } else {
      selected.has(i) ? selected.delete(i) : selected.add(i);
      refreshSentence(i);
      anchor = i;
    }
    updateSelBar();
  });
  ctx.addEventListener('dblclick', e => {
    const s = e.target.closest('.sent');
    if (!s) return;
    getSelection().removeAllRanges();
    const i = +s.dataset.i;
    // undo the toggle from the first click of the double-click
    selected.has(i) ? selected.delete(i) : selected.add(i);
    refreshSentence(i);
    updateSelBar();
    jump(i, true);
  });

  $('#selMark').addEventListener('click', () => { setMarks([...selected], true); clearSelection(); });
  $('#selUnmark').addEventListener('click', () => { setMarks([...selected], false); clearSelection(); });
  $('#selPlay').addEventListener('click', () => { const i = Math.min(...selected); clearSelection(); jump(i, true); });
  $('#selCopy').addEventListener('click', () => {
    copyText([...selected].sort((a, b) => a - b).map(i => S[i].t).join(' '), 'selection');
  });
  $('#selClear').addEventListener('click', clearSelection);

  $('#marksList').addEventListener('click', e => {
    const un = e.target.closest('[data-unmark]');
    if (un) { setMarks(un.dataset.unmark.split(',').map(Number), false); return; }
    const item = e.target.closest('.mark-item');
    if (item) jump(+item.dataset.i);
  });
  $('#marksList').addEventListener('keydown', e => {
    const item = e.target.closest('.mark-item');
    if (item && e.key === 'Enter') jump(+item.dataset.i);
  });
  $('#exportMd').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([marksMarkdown()], { type: 'text/markdown' }));
    a.download = `${book.title.replace(/[\\/:*?"<>|]/g, '_')} - marks.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('#copyMarks').addEventListener('click', () => copyText(marksMarkdown(), 'all marks'));

  // keyboard
  addEventListener('keydown', e => {
    if (!book || $('#reader').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    const k = e.key;
    if (k.toLowerCase() === 'r' && !e.shiftKey) { e.preventDefault(); setMode(mode === 'read' ? 'watch' : 'read'); return; }
    if (mode === 'read') {
      // Space, arrows, Page Up/Down scroll the text natively; only a few app keys apply here.
      const rk = {
        'x': () => readBarAction('mark'),
        'f': () => setCinema(!document.body.classList.contains('cinema')),
        'b': () => $('#btnSidebar').click(),
        'o': () => { if (!settings.sidebar) setSetting('sidebar', true); showTab('outline'); },
        ',': () => $('#btnSettings').click(),
        '=': () => setSetting('readSize', clamp(settings.readSize + 1, 14, 34)),
        '+': () => setSetting('readSize', clamp(settings.readSize + 1, 14, 34)),
        '-': () => setSetting('readSize', clamp(settings.readSize - 1, 14, 34)),
        'Escape': () => { hideReadBar(); if (document.body.classList.contains('cinema')) setCinema(false); else $('#settings').hidden = true; },
      }[k.length === 1 ? k.toLowerCase() : k];
      if (rk) { e.preventDefault(); rk(); }
      return;
    }
    const handled = {
      ' ': toggle,
      'k': toggle,
      'ArrowLeft': () => jump(cur - 1),
      'ArrowRight': () => jump(cur + 1),
      'ArrowUp': () => jumpPara(-1),
      'ArrowDown': () => jumpPara(1),
      // WASD mirror the arrow keys
      'a': () => jump(cur - 1),
      'd': () => jump(cur + 1),
      'w': () => jumpPara(-1),
      's': () => jumpPara(1),
      'x': () => setMarks([cur], !(cur in marks)),
      'm': () => setMarks([cur], !(cur in marks)),
      'b': () => $('#btnSidebar').click(),
      'f': () => setCinema(!document.body.classList.contains('cinema')),
      'o': () => { if (!settings.sidebar) setSetting('sidebar', true); showTab('outline'); },
      ',': () => $('#btnSettings').click(),
      '[': () => setSetting('rate', clamp(+(settings.rate - 0.1).toFixed(2), 0.5, 4)),
      ']': () => setSetting('rate', clamp(+(settings.rate + 0.1).toFixed(2), 0.5, 4)),
      '=': () => setSetting('size', clamp(settings.size + 4, 22, 110)),
      '+': () => setSetting('size', clamp(settings.size + 4, 22, 110)),
      '-': () => setSetting('size', clamp(settings.size - 4, 22, 110)),
      'Escape': () => {
        if (document.body.classList.contains('cinema')) setCinema(false);
        else if (!$('#settings').hidden) $('#settings').hidden = true;
        else clearSelection();
      },
    }[k.length === 1 ? k.toLowerCase() : k];
    if (!handled) return;
    if (e.target.matches('input[type=range]') && k.startsWith('Arrow')) return;
    e.preventDefault();
    if (e.target.matches('button') && (k === ' ')) e.target.blur();
    handled();
  });

  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', play);
    ms.setActionHandler('pause', pause);
    ms.setActionHandler('previoustrack', () => jump(cur - 1));
    ms.setActionHandler('nexttrack', () => jump(cur + 1));
  }

  addEventListener('hashchange', route);
  route();
}

// Plays one test sentence through the edge engine without touching the reading loop.
function testEdge(i) {
  runId++;
  const id = runId;
  playing = true;
  return speakEdge(i, id).finally(() => { playing = false; });
}

init();
