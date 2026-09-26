'use strict';
// Highlights and Reading stats pages. Loaded before app.js and only defines functions:
// it uses app.js's helpers ($, $$, api, esc, toast, copyText, isZh, store, showView) at call time.

const DATE_LOCALE = 'en-GB';
const fmtDate = (ms, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(ms).toLocaleDateString(DATE_LOCALE, opts);

function markMatch(text, q) {
  if (!q) return esc(text);
  const at = text.toLowerCase().indexOf(q);
  return at < 0 ? esc(text) : esc(text.slice(0, at)) + `<mark>${esc(text.slice(at, at + q.length))}</mark>` + esc(text.slice(at + q.length));
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name.replace(/[\\/:*?"<>|]/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Consecutive marked sentences (same chapter) read as one passage. Items are sorted by i;
// each passage keeps every sentence index (ids) so it can be unmarked as a whole.
const CJK_EDGE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
const joinSentences = (a, b) => (CJK_EDGE.test(a.slice(-1)) || CJK_EDGE.test(b[0] || '') ? a + b : `${a} ${b}`);
function mergeRuns(items) {
  const out = [];
  for (const m of items) {
    const last = out.at(-1);
    if (last && m.i === last.end + 1 && m.ch === last.ch) {
      last.t = m.p === last.p ? joinSentences(last.t, m.t) : `${last.t}\n${m.t}`; // new paragraph: new line
      last.end = m.i; last.p = m.p; last.ids.push(m.i);
      last.at = Math.max(last.at || 0, m.at || 0);
    } else {
      out.push({ ...m, end: m.i, ids: [m.i] });
    }
  }
  return out;
}
const quoteMd = t => `> ${t.replace(/\n/g, '\n>\n> ')}`;

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/* ================================================================ highlights */

let HL = []; // [{id, title, author, marks: [{i, t, at, ch}]}]

async function showHighlights() {
  document.title = 'Highlights · Book Watcher';
  showView('highlights');
  $('#hlList').innerHTML = '';
  try { HL = await api('/api/highlights'); } catch (e) { toast(e.message); HL = []; }
  for (const b of HL) b.marks = mergeRuns(b.marks);
  const sel = $('#hlBook'), prev = sel.value;
  sel.innerHTML = '<option value="">All books</option>' + HL.map(b => `<option value="${b.id}">${esc(b.title)}</option>`).join('');
  sel.value = HL.some(b => b.id === prev) ? prev : '';
  sel.hidden = HL.length < 2;
  renderHighlights();
}

function shownHighlights() {
  const q = $('#hlSearch').value.trim().toLowerCase(), only = $('#hlBook').value;
  return HL.filter(b => !only || b.id === only)
    .map(b => ({ ...b, marks: b.marks.filter(m => !q || m.t.toLowerCase().includes(q) || m.ch.toLowerCase().includes(q)) }))
    .filter(b => b.marks.length);
}

function hlCard(b, m, q, withBook) {
  const meta = [
    withBook ? `<span>${esc(b.title)}</span>` : '',
    withBook && m.ch ? `<span>${esc(m.ch)}</span>` : '',
    m.at ? `<span>${fmtDate(m.at)}</span>` : '',
    `<a href="#/book/${b.id}/${m.i}">Open in book ›</a>`,
  ].join('');
  return `<article class="hl" lang="${isZh(m.t) ? 'zh-CN' : 'en'}">
    <p class="t">${markMatch(m.t, q)}</p><div class="meta">${meta}</div>
    <button class="icon-btn sm del" data-book="${b.id}" data-ids="${m.ids.join(',')}" title="Remove highlight"><svg><use href="#i-x"/></svg></button>
  </article>`;
}

function renderHighlights() {
  const q = $('#hlSearch').value.trim().toLowerCase();
  const books = shownHighlights();
  const total = HL.reduce((n, b) => n + b.marks.length, 0);
  const shown = books.reduce((n, b) => n + b.marks.length, 0);
  $('#hlSummary').textContent = total
    ? `${plural(total, 'highlight')} in ${plural(HL.length, 'book')}${shown !== total ? ` · ${shown} shown` : ''}`
    : '';
  $$('#highlights .toolbar-end .chip').forEach(b => (b.disabled = !shown));
  const list = $('#hlList');
  if (!total) { list.innerHTML = '<p class="empty">No highlights yet. Press <kbd>M</kbd> while listening, or select sentences in the reader’s Context sidebar.</p>'; return; }
  if (!shown) { list.innerHTML = '<p class="empty">No highlights match.</p>'; return; }

  if ($('#hlSort').value === 'new') {
    const flat = books.flatMap(b => b.marks.map(m => ({ b, m }))).sort((x, y) => (y.m.at || 0) - (x.m.at || 0));
    list.innerHTML = flat.map(({ b, m }) => hlCard(b, m, q, true)).join('');
    return;
  }
  list.innerHTML = books.map(b => {
    let html = `<section class="hl-book"><h2>${esc(b.title)}</h2><div class="by">${esc(b.author || '')}${b.author ? ' · ' : ''}${plural(b.marks.length, 'highlight')}</div>`;
    let ch = null;
    for (const m of b.marks) {
      if (m.ch !== ch) { ch = m.ch; if (ch) html += `<h3 class="hl-ch">${esc(ch)}</h3>`; }
      html += hlCard(b, m, q, false);
    }
    return html + '</section>';
  }).join('');
}

function highlightsMarkdown(books) {
  let md = '# Highlights\n';
  for (const b of books) {
    md += `\n## ${b.title}${b.author ? ' — ' + b.author : ''}\n`;
    let ch = null;
    for (const m of b.marks) {
      if (m.ch !== ch) { ch = m.ch; if (ch) md += `\n### ${ch}\n`; }
      md += `\n${quoteMd(m.t)}\n`;
    }
  }
  return md;
}

function highlightsCsv(books) {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['book', 'author', 'chapter', 'sentence', 'marked_at', 'text']];
  for (const b of books) for (const m of b.marks) {
    rows.push([b.title, b.author, m.ch, m.end > m.i ? `${m.i}-${m.end}` : m.i, m.at ? new Date(m.at).toISOString() : '', m.t]);
  }
  return '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'); // BOM so Excel reads Chinese as UTF-8
}

function exportName(ext) {
  const books = shownHighlights();
  return (books.length === 1 ? `${books[0].title} - highlights` : 'highlights') + '.' + ext;
}

/* ================================================================ stats */

let ST = null;          // {days: {"YYYY-MM-DD": {s, n, b}}, books: [...]}
let stPeriod = 'week';
let stOffset = 0;       // 0 = current period, -1 = previous, …
const READ_DAY_SECONDS = 60; // a day "counts" (days read, streaks) after a minute of listening

const dayKey = d => localDay(d);
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const today0 = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };

function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 1) return sec > 0 ? '<1m' : '0m';
  const h = Math.floor(m / 60);
  return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}
function heroDur(sec) {
  const m = Math.round(sec / 60), h = Math.floor(m / 60);
  return h ? `${h}<small>h</small>${m % 60}<small>m</small>` : `${m}<small>m</small>`;
}

function periodRange(period, offset) {
  const t = today0();
  if (period === 'week') {
    const start = addDays(t, -((t.getDay() + 6) % 7) + 7 * offset); // Monday
    const end = addDays(start, 7);
    const last = addDays(end, -1);
    const sameMonth = start.getMonth() === last.getMonth();
    const label = `${fmtDate(start, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${fmtDate(last)}`;
    const buckets = [...Array(7)].map((_, i) => {
      const d = addDays(start, i);
      return { start: d, end: addDays(d, 1), short: fmtDate(d, { weekday: 'short' }), long: fmtDate(d, { weekday: 'long', day: 'numeric', month: 'short' }) };
    });
    return { start, end, label, buckets, unit: 'week' };
  }
  if (period === 'month') {
    const start = new Date(t.getFullYear(), t.getMonth() + offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
    const n = Math.round((end - start) / 864e5);
    const buckets = [...Array(n)].map((_, i) => {
      const d = addDays(start, i);
      return { start: d, end: addDays(d, 1), short: String(i + 1), long: fmtDate(d, { weekday: 'short', day: 'numeric', month: 'short' }) };
    });
    return { start, end, label: fmtDate(start, { month: 'long', year: 'numeric' }), buckets, unit: 'month' };
  }
  if (period === 'year') {
    const start = new Date(t.getFullYear() + offset, 0, 1);
    const end = new Date(start.getFullYear() + 1, 0, 1);
    const buckets = [...Array(12)].map((_, i) => {
      const d = new Date(start.getFullYear(), i, 1);
      return { start: d, end: new Date(start.getFullYear(), i + 1, 1), short: fmtDate(d, { month: 'narrow' }), long: fmtDate(d, { month: 'long', year: 'numeric' }) };
    });
    return { start, end, label: String(start.getFullYear()), buckets, unit: 'year' };
  }
  // all time: by month (by year once it spans more than three years)
  const keys = Object.keys(ST.days).sort();
  const first = keys.length ? parseDay(keys[0]) : t;
  const end = addDays(t, 1);
  const byYear = (t.getFullYear() - first.getFullYear()) * 12 + t.getMonth() - first.getMonth() >= 36;
  const buckets = [];
  for (let d = new Date(first.getFullYear(), byYear ? 0 : first.getMonth(), 1); d < end;) {
    const next = byYear ? new Date(d.getFullYear() + 1, 0, 1) : new Date(d.getFullYear(), d.getMonth() + 1, 1);
    buckets.push({
      start: d, end: next,
      short: byYear ? String(d.getFullYear()) : fmtDate(d, d.getMonth() === 0 || !buckets.length ? { month: 'short', year: '2-digit' } : { month: 'short' }),
      long: byYear ? String(d.getFullYear()) : fmtDate(d, { month: 'long', year: 'numeric' }),
    });
    d = next;
  }
  return { start: first, end, label: keys.length ? `Since ${fmtDate(first)}` : 'All time', buckets, unit: 'all' };
}

function sumDays(start, end) {
  const out = { s: 0, n: 0, days: 0, books: {} };
  for (const [k, v] of Object.entries(ST.days)) {
    const d = parseDay(k);
    if (d < start || d >= end) continue;
    out.s += v.s; out.n += v.n;
    if (v.s >= READ_DAY_SECONDS) out.days++;
    for (const [id, s] of Object.entries(v.b || {})) out.books[id] = (out.books[id] || 0) + s;
  }
  return out;
}

function streaks() {
  const read = new Set(Object.entries(ST.days).filter(([, v]) => v.s >= READ_DAY_SECONDS).map(([k]) => k));
  let longest = 0, run = 0;
  for (const k of [...read].sort()) {
    run = read.has(dayKey(addDays(parseDay(k), -1))) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  // current streak survives until the end of today even if today has no listening yet
  let d = read.has(dayKey(today0())) ? today0() : addDays(today0(), -1), current = 0;
  while (read.has(dayKey(d))) { current++; d = addDays(d, -1); }
  return { current, longest };
}

async function showStats() {
  document.title = 'Reading stats · Book Watcher';
  showView('stats');
  stPeriod = store.get('statsPeriod', 'week');
  stOffset = 0;
  try { ST = await api('/api/stats'); } catch (e) { toast(e.message); ST = { days: {}, books: [] }; }
  renderStats();
}

function renderStats() {
  if (!ST || $('#stats').hidden) return;
  $$('.segmented button').forEach(b => b.setAttribute('aria-selected', b.dataset.period === stPeriod));
  const R = periodRange(stPeriod, stOffset);
  $('#stLabel').textContent = R.label;
  $('#stPrev').disabled = stPeriod === 'all';
  $('#stNext').disabled = stPeriod === 'all' || stOffset >= 0;

  const tot = sumDays(R.start, R.end);
  const elapsedEnd = Math.min(R.end, addDays(today0(), 1));
  const elapsedDays = Math.max(1, Math.round((elapsedEnd - R.start) / 864e5));
  $('#stTotal').innerHTML = heroDur(tot.s);
  const sub = [`Daily average ${fmtDur(tot.s / elapsedDays)}`];
  if (stPeriod !== 'all') {
    // An unfinished (current) period is compared with the same stretch of the previous one.
    const P = periodRange(stPeriod, stOffset - 1);
    const partial = elapsedEnd < R.end;
    const prevEnd = partial ? addDays(P.start, elapsedDays) : P.end;
    const prev = sumDays(P.start, prevEnd < P.end ? prevEnd : P.end).s;
    if (prev >= 60) {
      const pct = Math.round(100 * (tot.s - prev) / prev);
      const word = { week: 'week', month: 'month', year: 'year' }[stPeriod];
      const vs = partial ? `this point last ${word}` : stOffset ? `the ${word} before` : `last ${word}`;
      sub.push(`<span class="delta ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '↑' : '↓'} ${Math.abs(pct)}% vs ${vs}</span>`);
    }
  }
  $('#stSub').innerHTML = sub.join(' · ');

  const values = R.buckets.map(b => ({ ...b, ...sumDays(b.start, b.end) }));
  renderChart(values, R);
  $('#stTable').innerHTML = `<table><thead><tr><th>${R.unit === 'year' || R.unit === 'all' ? 'Month' : 'Day'}</th><th>Time</th><th>Sentences</th></tr></thead><tbody>${
    values.map(v => `<tr><td>${esc(v.long)}</td><td>${fmtDur(v.s)}</td><td>${v.n.toLocaleString()}</td></tr>`).join('')}</tbody></table>`;

  // tiles
  const booksById = Object.fromEntries(ST.books.map(b => [b.id, b]));
  const inRange = ms => ms && ms >= +R.start && ms < +R.end;
  const finished = ST.books.filter(b => inRange(b.finished)).length;
  const marksMade = ST.books.reduce((n, b) => n + (b.markTimes || []).filter(inRange).length, 0);
  const st = streaks();
  const tile = (label, value, unit, note) => `<div class="tile"><div class="label">${label}</div><div class="value">${value}${unit ? `<small>${unit}</small>` : ''}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
  $('#stTiles').innerHTML = [
    tile('Days read', tot.days, '', `of ${elapsedDays} day${elapsedDays === 1 ? '' : 's'}`),
    tile('Current streak', st.current, st.current === 1 ? 'day' : 'days', `Longest ${st.longest} day${st.longest === 1 ? '' : 's'}`),
    tile('Books read', Object.keys(tot.books).length, '', ''),
    tile('Books finished', finished, '', ''),
    tile('Highlights made', marksMade, '', ''),
    tile('Sentences heard', tot.n.toLocaleString(), '', ''),
  ].join('');

  // per-book time in this period
  const rows = Object.entries(tot.books).filter(([id]) => booksById[id]).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  $('#stBooks').innerHTML = rows.length ? rows.map(([id, s]) => {
    const b = booksById[id];
    const pct = Math.round(100 * b.pos / Math.max(1, b.sentences - 1));
    return `<a class="st-book" href="#/book/${id}">
      <span class="name" lang="${isZh(b.title) ? 'zh-CN' : 'en'}">${esc(b.title)}</span><span class="time">${fmtDur(s)}</span>
      <span class="meta">${esc(b.author || '')}${b.author ? ' · ' : ''}${b.finished ? 'Finished' : `${pct}% read`}</span><span></span>
      <span class="track"><i style="width:${(100 * s / max).toFixed(1)}%"></i></span>
    </a>`;
  }).join('') : '<p class="empty">No listening in this period.</p>';
}

function niceScale(maxSec) {
  // returns tick step and top in seconds, with 2–4 ticks, in minute or hour units
  const steps = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1200, 1800, 3600, 6000, 12000].map(m => m * 60);
  const target = Math.max(maxSec, 30 * 60 / 4);
  const step = steps.find(s => target / s <= 4) || steps.at(-1);
  return { step, top: Math.ceil(target / step) * step };
}
const tickLabel = sec => (sec < 3600 ? `${Math.round(sec / 60)}m` : `${+(sec / 3600).toFixed(1)}h`);

function renderChart(values, R) {
  const box = $('#stChart');
  const W = box.clientWidth || 600, H = box.clientHeight || 220;
  const m = { l: 40, r: 4, t: 8, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const { step, top } = niceScale(Math.max(...values.map(v => v.s), 0));
  const y = s => m.t + ph - (s / top) * ph;
  const band = pw / values.length;
  const bw = Math.max(2, Math.min(24, band * 0.7));
  const labelEvery = Math.max(1, Math.ceil(values.length / Math.max(1, Math.floor(pw / 30))));
  const todayK = dayKey(today0());
  const isTodayAt = v => (R.unit === 'week' || R.unit === 'month' ? dayKey(v.start) === todayK : v.start <= today0() && today0() < v.end);
  const todayIdx = values.findIndex(isTodayAt);
  // label every n-th column, plus today; drop regular labels that would crowd today's
  const labelled = i => i === todayIdx || (i % labelEvery === 0 && (todayIdx < 0 || Math.abs(i - todayIdx) >= labelEvery));
  let g = '<g class="grid axis">';
  for (let s = 0; s <= top; s += step) {
    g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(s)}" y2="${y(s)}"/><text x="${m.l - 8}" y="${y(s) + 4}" text-anchor="end">${tickLabel(s)}</text>`;
  }
  g += '</g>';
  values.forEach((v, i) => {
    const cx = m.l + band * i + band / 2;
    const isToday = i === todayIdx;
    const h = ph * v.s / top;
    let bar = '';
    if (h > 0.5) {
      const x = cx - bw / 2, yt = m.t + ph - h, r = Math.min(4, bw / 2, h), y0 = m.t + ph;
      bar = `<path class="bar" d="M${x},${y0}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${y0}Z"/>`;
    }
    const lbl = labelled(i) ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(v.short)}</text>` : '';
    g += `<g class="col axis${isToday ? ' today' : ''}" data-i="${i}">${bar}${lbl}
      <rect class="hit" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ph}" tabindex="0"
        aria-label="${esc(v.long)}: ${fmtDur(v.s)}"/></g>`;
  });
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Listening time per ${R.unit === 'year' || R.unit === 'all' ? 'month' : 'day'}">${g}</svg>`;

  const tip = $('#stTip');
  const show = el => {
    const col = el.closest('.col');
    const v = values[+col.dataset.i];
    $$('.col.on', box).forEach(c => c.classList.remove('on'));
    col.classList.add('on');
    tip.innerHTML = `<b>${esc(v.long)}</b><br>${fmtDur(v.s)}${v.n ? ` · ${v.n.toLocaleString()} sentences` : ''}`;
    const cx = m.l + band * +col.dataset.i + band / 2;
    const barTop = y(v.s);
    tip.style.left = `${box.offsetLeft + clamp(cx, 60, W - 60)}px`;
    tip.style.top = `${box.offsetTop + barTop}px`;
    tip.hidden = false;
  };
  const hide = () => { tip.hidden = true; $$('.col.on', box).forEach(c => c.classList.remove('on')); };
  $$('.hit', box).forEach(h => {
    h.addEventListener('pointerenter', () => show(h));
    h.addEventListener('focus', () => show(h));
    h.addEventListener('pointerleave', hide);
    h.addEventListener('blur', hide);
  });
}

/* ================================================================ account */

async function showAccount() {
  document.title = 'Account · Book Watcher';
  showView('account');
  if (!ME) ME = await api('/api/me').catch(() => null);
  if (!ME) return;
  $('#acSub').textContent = `Signed in as ${ME.name}${ME.admin ? ' (admin)' : ''}`;
  $('#adminSection').hidden = !ME.admin;
  $('#acNotice').hidden = true;
  if (ME.admin) renderUsers();
}

function acNotice(html, error = false) {
  const n = $('#acNotice');
  n.innerHTML = html;
  n.classList.toggle('error', error);
  n.hidden = false;
}

function passwordNotice(name, password, what) {
  acNotice(`${what} <b>${esc(name)}</b>’s password is <code>${esc(password)}</code>
    <button class="chip" data-copy="${esc(password)}">Copy</button><br>
    <span class="form-note">Share it with them privately. They can change it on their Account page. It won’t be shown again.</span>`);
}

async function renderUsers() {
  let rows;
  try { rows = await api('/api/admin/users'); } catch (e) { acNotice(esc(e.message), true); return; }
  const when = ms => (ms ? fmtDate(ms) : '—');
  $('#usersBody').innerHTML = rows.map(u => `<tr data-uid="${u.id}" data-name="${esc(u.name)}">
    <td>${esc(u.name)}${u.admin ? '<span class="badge">admin</span>' : ''}${u.id === ME.id ? '<span class="badge">you</span>' : ''}</td>
    <td class="num">${u.books}</td><td>${when(u.created)}</td><td>${when(u.seen)}</td>
    <td><div class="actions">
      <button class="chip" data-act="rename">Rename</button>
      <button class="chip" data-act="reset">Reset password</button>
      ${u.id === ME.id ? '' : '<button class="chip" data-act="delete">Delete</button>'}
    </div></td></tr>`).join('');
}

async function adminCall(path, method, body) {
  return api(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
}

/* ================================================================ wiring (called from app.js init) */

function initPages() {
  $('#hlSearch').addEventListener('input', renderHighlights);
  $('#hlBook').addEventListener('change', renderHighlights);
  $('#hlSort').addEventListener('change', renderHighlights);
  $('#hlExportMd').addEventListener('click', () => download(exportName('md'), highlightsMarkdown(shownHighlights()), 'text/markdown'));
  $('#hlExportCsv').addEventListener('click', () => download(exportName('csv'), highlightsCsv(shownHighlights()), 'text/csv'));
  $('#hlCopy').addEventListener('click', () => copyText(highlightsMarkdown(shownHighlights()), 'highlights'));
  $('#hlList').addEventListener('click', async e => {
    const del = e.target.closest('.del');
    if (!del) return;
    const ids = del.dataset.ids.split(',').map(Number);
    if (!confirm(ids.length > 1 ? `Remove this passage (${ids.length} sentences)?` : 'Remove this highlight?')) return;
    const id = del.dataset.book;
    try {
      await api(`/api/books/${id}/marks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remove: ids }) });
      const b = HL.find(x => x.id === id);
      b.marks = b.marks.filter(m => m.i !== ids[0]);
      HL = HL.filter(x => x.marks.length);
      renderHighlights();
    } catch (err) { toast(err.message); }
  });

  $('#pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    if (f.password.value !== f.repeat.value) { toast('The new passwords don’t match'); return; }
    try {
      await adminCall('/api/me/password', 'POST', { current: f.current.value, password: f.password.value });
      f.reset();
      toast('Password changed');
    } catch (err) { toast(err.message); }
  });
  $('#newUserForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      const u = await adminCall('/api/admin/users', 'POST', { name: f.name.value, password: f.password.value });
      f.reset();
      passwordNotice(u.name, u.password, 'Created.');
      renderUsers();
    } catch (err) { acNotice(esc(err.message), true); }
  });
  $('#account').addEventListener('click', async e => {
    const copy = e.target.closest('[data-copy]');
    if (copy) { copyText(copy.dataset.copy, 'password'); return; }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('tr'), uid = row.dataset.uid, name = row.dataset.name;
    try {
      if (btn.dataset.act === 'rename') {
        const next = prompt(`New username for ${name}:`, name);
        if (!next || next === name) return;
        const u = await adminCall(`/api/admin/users/${uid}`, 'PATCH', { name: next });
        if (uid === ME.id) { ME.name = u.name; $('#userName').textContent = u.name; showAccount(); }
        acNotice(`Renamed to <b>${esc(u.name)}</b>. They sign in with the new name from now on.`);
      } else if (btn.dataset.act === 'reset') {
        if (!confirm(`Reset ${name}’s password? They will be signed out everywhere.`)) return;
        const u = await adminCall(`/api/admin/users/${uid}`, 'PATCH', { reset_password: true });
        passwordNotice(u.name, u.password, 'Password reset.');
      } else if (btn.dataset.act === 'delete') {
        if (!confirm(`Delete ${name} and their whole library, marks and stats? This can’t be undone.`)) return;
        await adminCall(`/api/admin/users/${uid}`, 'DELETE');
        acNotice(`Deleted <b>${esc(name)}</b>.`);
      }
      renderUsers();
    } catch (err) { acNotice(esc(err.message), true); }
  });

  $$('.segmented button').forEach(b => b.addEventListener('click', () => {
    stPeriod = b.dataset.period;
    stOffset = 0;
    store.set('statsPeriod', stPeriod);
    renderStats();
  }));
  $('#stPrev').addEventListener('click', () => { stOffset--; renderStats(); });
  $('#stNext').addEventListener('click', () => { if (stOffset < 0) { stOffset++; renderStats(); } });
  let lastW = 0;
  new ResizeObserver(() => {
    const w = $('#stChart').clientWidth;
    if (w && w !== lastW) { lastW = w; renderStats(); }
  }).observe($('#stChart'));
}
