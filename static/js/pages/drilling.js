// Drilling (time-based) page: KPI tiles, overview strip, vertical time tracks, replay, activity feed.
import { api } from '../api.js';
import { S, save, h, css, STATES, stateColor, stateMode, fmtDT, fmtDate, fmtDur, tzOffsetMs, tzLabel, debounce } from '../core.js';
import { CANON, conv, chanConv, fmt } from '../units.js';
import { makeVOverview, paintStates } from '../charts.js';
import { TrackPanel, attachResizer } from '../tracks.js';
import { openTrackEditor } from '../trackEditor.js';
import { sidePanel } from '../side.js';
import { TIME_LAYOUTS, resolveLayout, openLayoutMenu } from '../layouts.js';

const HELP = `Zoom & pan
• Drag up/down on a track: zoom time
• Drag left/right: zoom that track’s values
• Drag diagonally: zoom both
• Scroll: pan · Ctrl+scroll: zoom time · Shift+scroll: zoom values
• Double-click a track: reset its values (again: reset window)
• Click a curve name: fixed scale or remove · “+ curve” adds a curve`;

export const DEFAULT_TRACKS = [
  { title: 'Depth', ch: [['drilling', 'hole_depth'], ['drilling', 'bit_depth']] },
  { title: 'Hookload', ch: [['drilling', 'hookload']] },
  { title: 'WOB', ch: [['drilling', 'wob']] },
  { title: 'RPM', ch: [['drilling', 'rpm']] },
  { title: 'Torque', ch: [['drilling', 'torque']] },
  { title: 'SPP', ch: [['drilling', 'spp']] },
  { title: 'Flow', ch: [['drilling', 'flow_in'], ['drilling', 'flow_out']] },
  { title: 'ROP', ch: [['drilling', 'rop']] },
];
const KPI = ['hole_depth', 'bit_depth', 'rop', 'wob', 'rpm', 'torque', 'spp', 'flow_in', 'hookload'];
const SPEEDS = [[1, '1×'], [10, '10×'], [60, '1 min/s'], [300, '5 min/s'], [1800, '30 min/s'], [7200, '2 h/s']];
const PRESETS = [[1, '1h'], [6, '6h'], [12, '12h'], [24, '24h'], [72, '3d'], [168, '7d']];

export async function mount(main, ctx) {
  const D = ctx.wb.drilling;
  if (!D) {
    main.append(h('div', { class: 'empty' }, 'This wellbore has no time-based drilling data. ',
      h('a', { href: `#/w/${ctx.wid}/${ctx.wbId}/info` }, 'See well info and logs →')));
    return {};
  }
  const W = ctx.wid, B = ctx.wbId;
  const [logs, msgs, daily] = await Promise.all([api.logs(W, B), api.messages(W, B), api.obj(W, B, 'daily')]);
  const timeLogs = logs.filter(l => l.kind === 'time');
  const unitOf = (src, m) => src === 'drilling' ? (CANON[m] ? CANON[m].u : '') :
    (timeLogs.find(l => l.gid === src)?.channels.find(c => c.mnem === m)?.unit || '');
  const descOf = (src, m) => src === 'drilling' ? (CANON[m]?.label) : timeLogs.find(l => l.gid === src)?.channels.find(c => c.mnem === m)?.desc;

  // ------------------------------------------------ state
  const winKey = `dd.win.${W}.${B}`;
  let win = null;
  try { win = JSON.parse(sessionStorage.getItem(winKey)); } catch { /* ignore */ }
  if (!win) {
    // open on the day with the most drilling, else on the end of the data
    let best = null;
    (daily || []).forEach(d => { const dh = d.hours[1] + d.hours[2]; if (!best || dh > best.dh) best = { dh, day: d.day }; });
    const c = best && best.dh > 0 ? best.day + 12 * 3600e3 : D.end - S.span / 2;
    win = [c - S.span / 2, c + S.span / 2];
  }
  let playing = false, timer = null, head = null, hoverT = null, kpiReq = 0;

  // ------------------------------------------------ DOM
  const kpiEl = h('div', { class: 'kpis' });
  const stateTile = { v: h('div', { class: 'v', style: { fontSize: '15px', paddingTop: '4px' } }), s: h('div', { class: 's' }) };
  kpiEl.append(h('div', { class: 'tile', style: { gridColumn: 'span 2' } }, h('div', { class: 'k' }, 'Rig state'), stateTile.v, stateTile.s));
  const kpiTiles = {};
  for (const k of KPI) {
    const v = h('div', { class: 'v' }), s = h('div', { class: 's' });
    kpiTiles[k] = { v, s };
    kpiEl.append(h('div', { class: 'tile' }, h('div', { class: 'k' }, CANON[k].label), v, s));
  }

  const liveBadge = h('span', { class: 'badge', title: 'Replay of historical data as if it were streaming' }, 'Historical');
  const playBtn = h('button', { class: 'btn primary', onclick: () => (playing ? stop() : play()), 'aria-label': 'Play replay' });
  const speedSel = h('select', { class: 'select', 'aria-label': 'Replay speed', onchange: e => { S.speed = +e.target.value; save(); } },
    SPEEDS.map(([v, l]) => h('option', { value: v, selected: v === S.speed }, l)));
  const presetBtns = PRESETS.map(([hrs, l]) => h('button', { class: 'btn', 'aria-pressed': 'false', onclick: () => setSpan(hrs * 3600e3) }, l));
  const cursorEl = h('span', { class: 'cursor-time num' });
  const jump = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'Jump to time', title: 'Jump to time', style: { width: '170px' } });
  jump.onchange = () => {
    if (!jump.value) return;
    const t = Date.parse(jump.value + 'Z') - tzOffsetMs();
    const span = win[1] - win[0];
    panel.setWindow([t - span / 2, t + span / 2], true);
  };
  const stateSel = h('select', { class: 'select', 'aria-label': 'Rig state source',
    title: D.rigCode ? 'Rig-reported: Baker Hughes RigActivityCode recorded on the rig.\nComputed: DrillDash rules from hookload, depths, RPM and flow.'
      : 'This wellbore has no rig activity code (SLB / Geoservices data) - states are computed by DrillDash.',
    onchange: e => { S.stateSrc = e.target.value; save(); refreshStates(); } },
    h('option', { value: 'rig', selected: stateMode(D) === 'rig', disabled: !D.rigCode }, 'Rig code'),
    h('option', { value: 'calc', selected: stateMode(D) === 'calc' }, 'Computed'));
  const tipBtn = h('button', { class: 'btn', 'aria-pressed': String(S.tooltip !== false), title: 'Show a value tooltip next to the pointer',
    onclick: () => { S.tooltip = S.tooltip === false; save(); tipBtn.setAttribute('aria-pressed', String(S.tooltip)); } }, 'Tooltip');
  const toolbar = h('div', { class: 'toolbar' },
    playBtn, speedSel, liveBadge,
    h('span', { class: 'lbl' }, 'Window'), h('span', { class: 'chips range-presets' }, presetBtns),
    h('button', { class: 'btn', 'aria-label': 'Previous window', title: 'Previous window', onclick: () => step(-1) }, '◀'),
    h('button', { class: 'btn', 'aria-label': 'Next window', title: 'Next window', onclick: () => step(1) }, '▶'),
    h('button', { class: 'btn', title: 'Jump to end of data', onclick: () => { const s = win[1] - win[0]; panel.setWindow([D.end - s, D.end], true); } }, 'End'),
    h('span', { class: 'sp' }),
    h('span', { class: 'lbl' }, 'States'), stateSel,
    tipBtn,
    h('span', { class: 'hint help', tabindex: '0', title: HELP, 'aria-label': 'Zoom and pan help' }, 'ⓘ'),
    cursorEl,
    jump,
    h('button', { class: 'btn', title: 'Export the visible curves in this window as CSV (full resolution)', onclick: exportCsv }, '⤓ CSV'),
    h('button', { class: 'btn', title: 'Suggested layouts for drilling, hydraulics, tripping, well control … and your saved layouts', onclick: e => layoutMenu(e.currentTarget) }, 'Layout ▾'),
    h('button', { class: 'btn', onclick: () => editTracks() }, 'Edit tracks'));

  const body = h('div', { class: 'drill-body' });
  const sumEl = h('div', { class: 'card-b', style: { paddingTop: '4px' } });
  const feedEl = h('div', { class: 'feed' });
  const feedCount = h('span', { class: 'muted', style: { fontSize: '12px' } });
  const side = sidePanel('drill', [
    { key: 'summary', title: 'Window summary', body: sumEl },
    { key: 'remarks', title: "Driller's remarks", extra: feedCount, body: feedEl, grow: true },
  ]);

  // ------------------------------------------------ overview column (whole wellbore, time runs down)
  const dc = conv('m');
  const ovStates = { v: null, data: null };
  const ovHead = h('div', { class: 'track-h' },
    h('div', { class: 'row' }, h('span', { class: 'n tt' }, 'Overview')),
    h('div', { class: 'row' }, h('span', { class: 'muted', style: { fontSize: '11px' }, title: `Hole / bit depth in ${dc.label}` }, `${fmtDate(D.start)} → ${fmtDate(D.end)}`)));
  const ovBody = h('div', { class: 'track-b' });
  const ovCol = h('div', { class: 'track ov-track', style: S.ovWidth ? { flex: `0 0 ${S.ovWidth}px`, minWidth: `${S.ovWidth}px` } : null,
    title: 'Drag the highlighted band to move the window, drag elsewhere to draw a new one, scroll to widen / narrow, click to jump' }, ovHead, ovBody);
  body.append(ovCol);
  attachResizer(ovCol, { min: 90, onEnd: w => { S.ovWidth = w; save(); },
    onReset: () => { ovCol.style.flex = ''; ovCol.style.minWidth = ''; S.ovWidth = null; save(); } });
  let overview = null;
  const ovRo = new ResizeObserver(debounce(() => {
    const w = ovBody.clientWidth, hh = ovBody.clientHeight;
    if (w < 20 || hh < 50) return;
    if (!overview) {
      overview = makeVOverview(ovBody, {
        width: w, height: hh, getWindow: () => win, getStates: () => ovStates.v,
        onWindow: (a, b) => panel.setWindow([a, b], true),
      });
      if (ovStates.data) overview.setData(ovStates.data);
    } else overview.setSize({ width: w, height: hh });
  }, 60));
  ovRo.observe(ovBody);
  function loadOverview() {
    return api.series(W, B, 'drilling', ['hole_depth', 'bit_depth'], D.start, D.end, 2000, stateMode(D)).then(r => {
      ovStates.v = r.states;
      const f = v => (v == null ? null : dc.f(v));
      ovStates.data = [r.x, r.series.hole_depth.avg.map(f), r.series.bit_depth.avg.map(f)];
      if (overview) overview.setData(ovStates.data);
    });
  }
  loadOverview();

  const page = h('div', { class: 'drill' }, kpiEl, toolbar, body);
  main.append(page);

  // ------------------------------------------------ tracks
  const stateHeader = el => {
    el.append(h('div', { class: 'row' }, h('span', { class: 'n tt' }, 'Rig state')),
      h('div', { class: 'row' }, h('span', { class: 'muted', id: 'stateSrcLbl', style: { fontSize: '11px' } }, stateMode(D) === 'rig' ? 'rig code' : 'computed'),
        h('span', { class: 'muted', style: { fontSize: '11px' } }, tzLabel())));
  };
  const leadDraw = (u, p) => {
    paintStates(u, p.states, { vertical: true, x1: win[1] });
    // driller's remark ticks
    const ctx2 = u.ctx, { left, width, top, height } = u.bbox;
    ctx2.save();
    ctx2.fillStyle = css('--text-primary');
    for (const m of msgs) {
      if (m.t < win[0] || m.t > win[1]) continue;
      const y = u.valToPos(m.t, 'x', true);
      if (y < top || y > top + height) continue;
      ctx2.fillRect(left + width - 6 * devicePixelRatio, y - devicePixelRatio, 6 * devicePixelRatio, 2 * devicePixelRatio);
    }
    if (playing && head != null) {
      const y = u.valToPos(head, 'x', true);
      ctx2.fillStyle = css('--critical');
      ctx2.fillRect(left, y - devicePixelRatio, width, 2 * devicePixelRatio);
    }
    ctx2.restore();
  };

  // suggested layouts adapt to the logs of each wellbore; a customised layout is kept as-is
  const stdSrc = { id: 'drilling', channels: new Set(D.available) };
  const resolveL = L => resolveLayout(L, stdSrc, timeLogs.filter(l => l.rows > 1));
  const activeL = TIME_LAYOUTS.find(L => L.id === (S.activeLayout || {}).time);
  const tracks = activeL ? resolveL(activeL).tracks : S.tracks && S.tracks.length ? S.tracks : DEFAULT_TRACKS;
  const customised = () => { S.activeLayout = { ...(S.activeLayout || {}), time: null }; };
  function layoutMenu(anchor) {
    openLayoutMenu(anchor, { kind: 'time', layouts: TIME_LAYOUTS, resolve: resolveL, current: () => panel.cfg.tracks,
      onApply: (t, id) => { S.tracks = t; S.activeLayout = { ...(S.activeLayout || {}), time: id }; save(); panel.build(t); } });
  }
  const panel = new TrackPanel(body, {
    kind: 'time', W, B, syncKey: 'dd-time', tracks, unitOf, descOf, withStates: true,
    srcName: src => (src === 'drilling' ? 'Drilling (standard)' : timeLogs.find(l => l.gid === src)?.name || src),
    hasSrc: src => src === 'drilling' || timeLogs.some(l => l.gid === src),
    onAddCurve: ti => editTracks(ti),
    onTracksChanged: t => { S.tracks = t; customised(); save(); },
    onLayout: hh => { ovHead.style.height = hh + 'px'; },
    lead: { width: 92, header: stateHeader, draw: leadDraw },
    leadWidth: () => S.leadWidth,
    onLeadWidth: w => { S.leadWidth = w; save(); },
    stateMode: () => stateMode(D),
    tipExtra: t => {
      const s = stateAt(t);
      return s > 0 ? h('div', { class: 'tip-row' }, h('i', { style: { background: stateColor(s), height: '8px' } }), h('span', { class: 'tip-n' }, STATES[s]),
        h('small', {}, stateMode(D) === 'rig' ? 'rig code' : 'computed')) : null;
    },
    clamp: (a, b) => {
      const span = Math.max(60e3, b - a);
      const lo = D.start - span * 0.5, hi = D.end + span * 0.5;
      if (a < lo) { a = lo; b = a + span; }
      if (b > hi) { b = hi; a = b - span; }
      return [a, b];
    },
    onWindow: (w, user) => {
      win = w;
      try { sessionStorage.setItem(winKey, JSON.stringify(w)); } catch { /* ignore */ }
      if (user && playing) stop();
      overview && overview.redraw(false, false);
      markPreset();
      if (!playing) updateKpis(w[1]);
    },
    onLoaded: () => { renderSummary(); renderFeed(); },
    onHoverX: t => { hoverT = t; renderCursor(); },
    onReset: () => setSpan(S.span),
  });
  body.append(side);
  panel.setWindow(win);

  // ------------------------------------------------ behaviours
  function setSpan(ms) {
    S.span = ms; save();
    const end = playing ? head : win[1];
    panel.setWindow([end - ms, end]);
  }
  function step(dir) { const s = win[1] - win[0]; panel.setWindow([win[0] + dir * s, win[1] + dir * s], true); }
  function markPreset() {
    const s = win[1] - win[0];
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Math.abs(PRESETS[i][0] * 3600e3 - s) < 1000)));
  }

  function stateAt(t) {
    const st = panel.states;
    let s = -1;
    if (st) for (let i = 0; i < st.x.length && st.x[i] <= t; i++) s = st.s[i];
    return s;
  }

  function refreshStates() {
    const lbl = document.getElementById('stateSrcLbl');
    if (lbl) lbl.textContent = stateMode(D) === 'rig' ? 'rig code' : 'computed';
    loadOverview();
    panel.load();
    updateKpis(playing ? head : win[1]);
  }

  function renderCursor() {
    const hs = document.getElementById('hoverState');
    if (hoverT == null) { cursorEl.textContent = playing ? `▶ ${fmtDT(head, true)}` : `${fmtDT(win[0])} → ${fmtDT(win[1])}`; if (hs) hs.textContent = ''; return; }
    cursorEl.textContent = `${fmtDT(hoverT, true)} ${tzLabel()}`;
    if (hs && panel.states) {
      const s = stateAt(hoverT);
      hs.innerHTML = '';
      if (s >= 0) hs.append(h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(s) } }), STATES[s]));
    }
  }


  async function updateKpis(t) {
    const id = ++kpiReq;
    let snap;
    try { snap = await api.snapshot(W, B, t); } catch { return; }
    if (id !== kpiReq || !snap) return;
    for (const k of KPI) {
      const c = conv(CANON[k].u);
      const v = snap.values[k];
      kpiTiles[k].v.innerHTML = '';
      kpiTiles[k].v.append(v == null ? '–' : fmt(c.f(v), k === 'rpm' || k === 'spp' || k === 'flow_in' ? 0 : 1), h('small', {}, c.label));
    }
    const hd = snap.values.hole_depth, bd = snap.values.bit_depth;
    kpiTiles.bit_depth.s.textContent = hd != null && bd != null ? `${fmt(dc.f(hd - bd), 1)} ${dc.label} off bottom` : '';
    kpiTiles.hole_depth.s.textContent = snap.progress1h != null ? `+${fmt(dc.f(snap.progress1h), 1)} ${dc.label} last hour` : '';
    stateTile.v.innerHTML = '';
    const s = (stateMode(D) === 'rig' ? snap.stateRig : snap.state) ?? 0;
    stateTile.v.append(h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(s), width: '12px', height: '12px' } }), STATES[s]));
    stateTile.s.textContent = `at ${fmtDT(snap.t, true)} ${tzLabel()} · ${stateMode(D) === 'rig' ? 'rig code' : 'computed'}`;
  }

  function renderSummary() {
    sumEl.innerHTML = '';
    const st = panel.states;
    const hours = Array(9).fill(0);
    if (st && st.x.length) {
      for (let i = 0; i < st.x.length; i++) {
        const a = Math.max(st.x[i], win[0]);
        const b = Math.min(i + 1 < st.x.length ? st.x[i + 1] : win[1], win[1], D.end);
        if (b > a && st.s[i] >= 0) hours[st.s[i]] += (b - a) / 3600e3;
      }
    }
    const tot = hours.slice(1).reduce((a, b) => a + b, 0);
    sumEl.append(h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '6px' } }, `${fmtDur((win[1] - win[0]) / 3600e3)} window · ${fmtDur(tot)} with data`));
    if (!tot) { sumEl.append(h('div', { class: 'muted' }, 'No data in this window.')); return; }
    const bar = h('div', { class: 'statebar', style: { marginBottom: '8px', height: '10px' } });
    for (let i = 1; i < 9; i++) if (hours[i] / tot > 0.005) bar.append(h('span', { style: { width: `${hours[i] / tot * 100}%`, background: stateColor(i) }, title: STATES[i] }));
    sumEl.append(bar);
    for (let i = 1; i < 9; i++) {
      if (hours[i] <= 0) continue;
      sumEl.append(h('div', { class: 'sum-row' },
        h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(i) } }), STATES[i]),
        h('span', { class: 'num' }, fmtDur(hours[i])),
        h('span', { class: 'p num' }, `${(hours[i] / tot * 100).toFixed(0)}%`)));
    }
  }

  function renderFeed() {
    const list = msgs.filter(m => m.t >= win[0] - 1 && m.t <= win[1] + 1);
    feedCount.textContent = msgs.length ? `${list.length} in window · ${msgs.length} total` : '';
    feedEl.innerHTML = '';
    if (!msgs.length) { feedEl.append(h('div', { class: 'muted', style: { padding: '8px' } }, 'No remarks recorded for this wellbore.')); return; }
    if (!list.length) {
      // nearest remarks to help navigation
      const c = (win[0] + win[1]) / 2;
      const near = [...msgs].sort((a, b) => Math.abs(a.t - c) - Math.abs(b.t - c)).slice(0, 5).sort((a, b) => a.t - b.t);
      feedEl.append(h('div', { class: 'muted', style: { padding: '4px 8px', fontSize: '12px' } }, 'None in window - nearest:'));
      near.forEach(m => feedEl.append(msgBtn(m)));
      return;
    }
    [...list].reverse().forEach(m => feedEl.append(msgBtn(m)));
  }
  function msgBtn(m) {
    const future = playing && head != null && m.t > head;
    return h('button', { class: `msg ${future ? 'future' : ''}`, onclick: () => { const s = win[1] - win[0]; panel.setWindow([m.t - s / 2, m.t + s / 2], true); } },
      h('div', { class: 'when num' }, `${fmtDT(m.t)}${m.md != null ? ` · ${fmt(dc.f(m.md), 0)} ${dc.label}` : ''}`),
      h('div', { class: 'txt' }, m.text || ''));
  }

  // ------------------------------------------------ replay
  function play() {
    playing = true;
    head = head != null && head > win[0] && head <= win[1] ? head : win[1];
    if (head >= D.end) head = D.start + (win[1] - win[0]);
    liveBadge.className = 'badge live';
    liveBadge.textContent = 'Replay';
    playBtn.textContent = '❚❚ Pause';
    playBtn.setAttribute('aria-label', 'Pause replay');
    const tick = () => {
      head += S.speed * 1000;
      if (head >= D.end) { head = D.end; stop(); }
      const span = win[1] - win[0];
      panel.setWindow([head - span, head]);
      updateKpis(head);
      renderCursor();
    };
    tick();
    timer = setInterval(tick, 1000);
  }
  function stop() {
    playing = false;
    clearInterval(timer);
    liveBadge.className = 'badge';
    liveBadge.textContent = 'Historical';
    playBtn.textContent = '▶ Play';
    playBtn.setAttribute('aria-label', 'Play replay');
    panel.redrawLead();
  }
  stop();

  function exportCsv() {
    const pairs = panel.curves().map(([src, m]) => `${src}:${m}`);
    if (!pairs.includes('drilling:rig_state')) pairs.push('drilling:rig_state');
    const q = new URLSearchParams({ pairs: pairs.join(','), x0: String(Math.round(win[0])), x1: String(Math.round(win[1])), units: S.units });
    window.location.href = `/api/wb/${W}/${B}/export?${q}`;
  }

  function editTracks(target = null) {
    const sources = [{ id: 'drilling', name: 'Drilling (standard)', channels: D.available.map(c => ({ mnem: c, unit: CANON[c]?.u, desc: CANON[c]?.label })) },
      ...timeLogs.filter(l => l.rows > 1).sort((a, b) => a.name.localeCompare(b.name)).map(l => ({ id: l.gid, name: l.name, channels: l.channels }))];
    openTrackEditor({
      sources, tracks: panel.cfg.tracks, defaults: DEFAULT_TRACKS, unitOf, target,
      onSave: t => { S.tracks = t; customised(); save(); panel.build(t); },
    });
  }

  const keys = e => {
    if (e.target.closest('input,select,textarea')) return;
    if (e.key === ' ') { e.preventDefault(); playing ? stop() : play(); }
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  };
  document.addEventListener('keydown', keys);
  renderCursor();

  return {
    unmount() {
      stop();
      ovRo.disconnect();
      document.removeEventListener('keydown', keys);
      panel.destroy();
      overview && overview.destroy();
    },
  };
}
