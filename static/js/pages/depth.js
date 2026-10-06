// Depth page: on-bottom drilling parameters binned by hole depth + lithology & casing column.
import { api } from '../api.js';
import { S, save, h, css } from '../core.js';
import { CANON, conv, fmt } from '../units.js';
import { TrackPanel } from '../tracks.js';
import { openTrackEditor } from '../trackEditor.js';
import { DEPTH_LAYOUTS, resolveLayout, openLayoutMenu } from '../layouts.js';

const HELP = `Zoom & pan
• Drag up/down on a track: zoom depth
• Drag left/right: zoom that track’s values
• Drag diagonally: zoom both
• Scroll: pan · Ctrl+scroll: zoom depth · Shift+scroll: zoom values
• Double-click a track: reset its values (again: reset window)
• Click a curve name: fixed scale or remove · “+ curve” adds a curve`;

export const DEFAULT_DEPTH_TRACKS = [
  { title: 'ROP', ch: [['depth_drilling', 'rop']] },
  { title: 'WOB', ch: [['depth_drilling', 'wob']] },
  { title: 'RPM', ch: [['depth_drilling', 'rpm']] },
  { title: 'Torque', ch: [['depth_drilling', 'torque']] },
  { title: 'SPP', ch: [['depth_drilling', 'spp']] },
  { title: 'Flow In', ch: [['depth_drilling', 'flow_in']] },
  { title: 'MSE', ch: [['depth_drilling', 'mse']] },
  { title: 'Slide', ch: [['depth_drilling', 'slide_frac']] },
];
const DD_CHANNELS = ['rop', 'rop_calc', 'wob', 'rpm', 'torque', 'spp', 'flow_in', 'hookload', 'mse', 'bit_rpm', 'mw_in', 'gas', 'slide_frac'];

// Lithology fills follow common mud-log convention (sand = yellow, limestone = blue ...)
const LITH = {
  sandstone: '#e3c35a', sand: '#e3c35a', claystone: '#8f9a6a', clay: '#8f9a6a', shale: '#6f7f5f', siltstone: '#b9a77c',
  limestone: '#4f8fd6', dolomite: '#9b7fd1', marl: '#6fb0a0', chalk: '#c8d8e8', coal: '#2b2b2b', tuff: '#d58fb2',
  anhydrite: '#c6a0dd', cement: '#9a9a9a', calcite: '#7fb6c9', conglomerate: '#d9a25f', halite: '#e7e7f7',
};
const lithColor = t => LITH[(t || '').toLowerCase()] || '#8a8a8a';

export async function mount(main, ctx) {
  const W = ctx.wid, B = ctx.wbId;
  const D = ctx.wb.drilling;
  const [logs, mud, geo] = await Promise.all([api.logs(W, B), api.obj(W, B, 'mudlog'), api.obj(W, B, 'geometry')]);
  const depthLogs = logs.filter(l => l.kind === 'depth' && l.rows > 1);
  const hasDD = D && D.hasDepthDrilling;
  if (!hasDD && !depthLogs.length) {
    main.append(h('div', { class: 'empty' }, 'No depth-based data for this wellbore.'));
    return {};
  }
  const dc = conv('m');
  const k = dc.f(1);
  const xDisp = v => v * k, xSrv = v => v / k;
  const unitOf = (src, m) => src === 'depth_drilling' ? (CANON[m] ? CANON[m].u : '') :
    (depthLogs.find(l => l.gid === src)?.channels.find(c => c.mnem === m)?.unit || '');
  const descOf = (src, m) => src === 'depth_drilling' ? CANON[m]?.label : depthLogs.find(l => l.gid === src)?.channels.find(c => c.mnem === m)?.desc;

  // depth extent
  let lo = Infinity, hi = -Infinity;
  if (hasDD) {
    const r = await api.series(W, B, 'depth_drilling', ['rop'], null, null, 100);
    if (r.x.length) { lo = r.x[0]; hi = r.x[r.x.length - 1]; }
  }
  if (!isFinite(lo)) depthLogs.forEach(l => { lo = Math.min(lo, l.start); hi = Math.max(hi, l.end); });
  const full = [Math.max(0, lo - 10), hi + 10];

  // casing shoes from the latest geometry report
  const shoes = [];
  const rep = geo && geo.length ? geo[geo.length - 1] : null;
  if (rep) rep.sections.filter(s => /casing|liner/.test(s.type || '') && s.mdBottom).forEach(s => shoes.push({ md: s.mdBottom, od: s.od, type: s.type }));
  const intervals = mud || [];

  // ---------------- DOM
  const tiles = h('div', { class: 'tiles', style: { padding: '10px 12px 0', marginBottom: 0 } });
  const legend = h('div', { class: 'lith-legend' });
  const lithTypes = [...new Set(intervals.flatMap(iv => iv.lith.map(l => (l.type || '').toLowerCase())))].filter(Boolean);
  lithTypes.forEach(t => legend.append(h('span', {}, h('i', { style: { background: lithColor(t) } }), t)));
  const toolbar = h('div', { class: 'toolbar' },
    h('h2', {}, 'Drilling parameters by depth'),
    h('span', { class: 'lbl' }, hasDD ? 'medians of on-bottom drilling, 1 m bins' : 'depth logs'),
    h('span', { class: 'sp' }),
    h('span', { class: 'hint help', tabindex: '0', title: HELP }, 'ⓘ zoom & pan'),
    legend,
    h('button', { class: 'btn', onclick: () => panel.setWindow(full) }, 'Full depth'),
    h('button', { class: 'btn', title: 'Export the visible curves in this depth window as CSV', onclick: () => exportCsv() }, '⤓ CSV'),
    h('button', { class: 'btn', title: 'Suggested layouts (performance, LWD formation evaluation, hydraulics, dynamics) and your saved layouts', onclick: e => layoutMenu(e.currentTarget) }, 'Layout ▾'),
    h('button', { class: 'btn', onclick: () => editTracks() }, 'Edit tracks'));
  const body = h('div', { class: 'drill-body' });
  main.append(h('div', { class: 'drill' }, tiles, toolbar, body));

  if (hasDD) {
    const r = await api.series(W, B, 'depth_drilling', ['rop', 'wob', 'rpm', 'slide_frac', 'drill_secs'], null, null, 100000);
    const s = r.series;
    const n = r.x.length;
    const secs = s.drill_secs.avg.reduce((a, v) => a + (v || 0), 0);
    const med = arr => { const a = arr.filter(v => v != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
    const slide = s.slide_frac.avg.reduce((a, v, i) => a + (v || 0) * (s.drill_secs.avg[i] || 0), 0) / (secs || 1);
    const rop = conv('m/s'), wob = conv('N'), rpm = conv('c/s');
    tiles.append(
      tile('Interval drilled', `${fmt(dc.f(r.x[n - 1] - r.x[0]), 0)}`, dc.label, `${fmt(dc.f(r.x[0]), 0)} → ${fmt(dc.f(r.x[n - 1]), 0)} ${dc.label}`),
      tile('On-bottom time', fmt(secs / 3600, 0), 'h', 'rotary + slide'),
      tile('Average ROP', fmt(rop.f((r.x[n - 1] - r.x[0]) / (secs || 1)), 1), rop.label, 'interval / on-bottom time'),
      tile('Median WOB', fmt(wob.f(med(s.wob.avg)), 1), wob.label, ''),
      tile('Median RPM', fmt(rpm.f(med(s.rpm.avg)), 0), rpm.label, ''),
      tile('Sliding', fmt(slide * 100, 1), '%', 'of on-bottom time'));
  }

  // ---------------- lead: lithology + casing
  let hoverMd = null;
  const leadHeader = el => el.append(h('div', { class: 'row' }, h('span', { class: 'n tt' }, intervals.length ? 'Lithology' : 'Casing')),
    h('div', { class: 'row' }, h('span', { class: 'muted', style: { fontSize: '11px' } }, `MD (${dc.label})`)));
  const leadDraw = u => {
    const c = u.ctx, { left, top, width, height } = u.bbox;
    c.save();
    c.beginPath(); c.rect(left, top, width, height); c.clip();
    const bandW = shoes.length ? width * 0.72 : width;
    for (const iv of intervals) {
      const a = u.valToPos(xDisp(iv.top), 'x', true), b = u.valToPos(xDisp(iv.bottom), 'x', true);
      const y = Math.min(a, b), hh = Math.max(1, Math.abs(b - a));
      if (y > top + height || y + hh < top) continue;
      const tot = iv.lith.reduce((s, l) => s + (l.pc || 0), 0) || 1;
      let x = left;
      for (const l of iv.lith) {
        const w = bandW * (l.pc || tot / iv.lith.length) / tot;
        c.fillStyle = lithColor(l.type);
        c.fillRect(x, y, w, hh);
        x += w;
      }
    }
    // casing shoes: line + triangle + size label
    c.strokeStyle = css('--text-secondary');
    c.fillStyle = css('--text-primary');
    c.lineWidth = devicePixelRatio;
    c.font = `${10 * devicePixelRatio}px system-ui, sans-serif`;
    for (const s of shoes) {
      const y = u.valToPos(xDisp(s.md), 'x', true);
      if (y < top || y > top + height) continue;
      const xr = left + width;
      c.beginPath(); c.moveTo(left, y); c.lineTo(xr, y); c.stroke();
      c.beginPath(); c.moveTo(xr, y); c.lineTo(xr - 9 * devicePixelRatio, y); c.lineTo(xr, y - 9 * devicePixelRatio); c.closePath(); c.fill();
      if (s.od) { c.textAlign = 'right'; c.fillText(inch(s.od), xr - 2 * devicePixelRatio, y + 11 * devicePixelRatio); }
    }
    c.restore();
  };
  const lithAt = md => intervals.find(iv => md >= iv.top && md < iv.bottom);

  const stdSrc = hasDD ? { id: 'depth_drilling', channels: new Set([...(D.available || []), 'slide_frac', 'rop_calc']) } : null;
  const resolveL = L => resolveLayout(L, stdSrc, depthLogs);
  const activeL = DEPTH_LAYOUTS.find(L => L.id === (S.activeLayout || {}).depth);
  const tracks = activeL && resolveL(activeL).tracks.length ? resolveL(activeL).tracks : S.depthTracks && S.depthTracks.length ? S.depthTracks :
    hasDD ? DEFAULT_DEPTH_TRACKS : defaultFromLogs(depthLogs);
  const customised = () => { S.activeLayout = { ...(S.activeLayout || {}), depth: null }; };
  function layoutMenu(anchor) {
    openLayoutMenu(anchor, { kind: 'depth', layouts: DEPTH_LAYOUTS, resolve: resolveL, current: () => panel.cfg.tracks,
      onApply: (t, id) => { S.depthTracks = t; S.activeLayout = { ...(S.activeLayout || {}), depth: id }; save(); panel.build(t); } });
  }
  const panel = new TrackPanel(body, {
    kind: 'depth', W, B, syncKey: 'dd-depth', tracks, unitOf, descOf, xDisp, xSrv,
    srcName: src => (src === 'depth_drilling' ? 'Drilling by depth (standard)' : depthLogs.find(l => l.gid === src)?.name || src),
    hasSrc: src => (src === 'depth_drilling' ? !!hasDD : depthLogs.some(l => l.gid === src)),
    onAddCurve: ti => editTracks(ti),
    onTracksChanged: t => { S.depthTracks = t; customised(); save(); },
    xLabel: dc.label,
    tipExtra: md => {
      const iv = lithAt(md);
      return iv ? h('div', { class: 'tip-row' }, h('i', { style: { background: lithColor(iv.lith[0] && iv.lith[0].type), height: '8px' } }),
        h('span', { class: 'tip-n' }, iv.lith.map(l => `${l.type}${l.pc ? ' ' + Math.round(l.pc) + '%' : ''}`).join(', '))) : null;
    },
    lead: { width: 116, header: leadHeader, draw: leadDraw },
    onHoverX: md => {
      hoverMd = md;
      const el = document.getElementById('lithHover');
      if (!el) return;
      if (md == null) { el.textContent = ''; return; }
      const iv = lithAt(md);
      el.textContent = `${fmt(dc.f(md), 1)} ${dc.label}${iv ? ' · ' + iv.lith.map(l => `${l.type}${l.pc ? ' ' + Math.round(l.pc) + '%' : ''}`).join(', ') : ''}`;
    },
    onReset: () => panel.setWindow(full),
  });
  panel.setWindow(full);

  function exportCsv() {
    const pairs = panel.curves().map(([src, m]) => `${src}:${m}`);
    const q = new URLSearchParams({ pairs: pairs.join(','), x0: String(panel.win[0]), x1: String(panel.win[1]), units: S.units });
    window.location.href = `/api/wb/${W}/${B}/export?${q}`;
  }

  function editTracks(target = null) {
    const sources = [];
    if (hasDD) sources.push({ id: 'depth_drilling', name: 'Drilling by depth (standard)', channels: DD_CHANNELS.map(c => ({ mnem: c, unit: CANON[c]?.u, desc: CANON[c]?.label })) });
    depthLogs.sort((a, b) => a.name.localeCompare(b.name)).forEach(l => sources.push({ id: l.gid, name: l.name, channels: l.channels }));
    openTrackEditor({
      title: 'Edit depth tracks', sources, tracks: panel.cfg.tracks,
      defaults: hasDD ? DEFAULT_DEPTH_TRACKS : defaultFromLogs(depthLogs), unitOf, target,
      onSave: t => { S.depthTracks = t; customised(); save(); panel.build(t); },
    });
  }

  return { unmount() { panel.destroy(); } };
}

function defaultFromLogs(depthLogs) {
  // pick a few well-populated channels from the largest depth log
  const l = [...depthLogs].sort((a, b) => b.rows - a.rows)[0];
  if (!l) return [];
  return [...l.channels].sort((a, b) => b.n - a.n).slice(0, 6).map(c => ({ title: c.mnem, ch: [[l.gid, c.mnem]] }));
}

function inch(m) {
  const v = m / 0.0254;
  const whole = Math.floor(v + 1e-6), frac = v - whole;
  const eighths = Math.round(frac * 8);
  const map = { 0: '', 1: '⅛', 2: '¼', 3: '⅜', 4: '½', 5: '⅝', 6: '¾', 7: '⅞', 8: '' };
  return `${eighths === 8 ? whole + 1 : whole}${map[eighths]}″`;
}

function tile(k, v, unit, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, h('small', {}, unit)), h('div', { class: 's' }, sub || ''));
}
