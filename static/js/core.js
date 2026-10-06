// Shared app state, DOM helpers, theme tokens and time formatting.
import { setSystem } from './units.js';

const LS = 'drilldash.v1';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();

export const S = Object.assign({
  units: 'metric',
  theme: 'dark',
  tz: 'utc',          // 'utc' | 'well'
  tracks: null,       // drilling track layout (null -> defaults)
  depthTracks: null,
  span: 6 * 3600e3,   // default time window
  speed: 60,
  stateSrc: 'rig',    // 'rig' = rig-reported code where available, 'calc' = DrillDash classifier
  tooltip: true,      // hover tooltip on tracks
  ovWidth: null,      // overview column width (px)
  leadWidth: null,    // rig-state column width (px)
}, saved);
setSystem(S.units);

export function save() {
  try {
    const { units, theme, tz, tracks, depthTracks, span, speed, side, stateSrc, tooltip, ovWidth, leadWidth, savedLayouts, activeLayout } = S;
    localStorage.setItem(LS, JSON.stringify({ units, theme, tz, tracks, depthTracks, span, speed, side, stateSrc, tooltip, ovWidth, leadWidth, savedLayouts, activeLayout }));
  } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------- DOM
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) {
    if (k == null || k === false) continue;
    e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return e;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------------------------------------------------------------- rig states
export const STATES = ['No data', 'Rotary Drilling', 'Slide Drilling', 'In Slips', 'Run In Hole',
  'Pull Out of Hole', 'Reaming', 'Circulating', 'Static'];
export const stateColor = i => css(`--state-${i}`);
/** Rig-state source for a wellbore: 'rig' (vendor code) when available and preferred, else 'calc'. */
export const stateMode = D => (S.stateSrc === 'rig' && D && D.rigCode ? 'rig' : 'calc');
export const stateHours = D => (stateMode(D) === 'rig' ? D.stateHoursRig : D.stateHours);
export const stateSrcLabel = D => (stateMode(D) === 'rig' ? 'rig-reported (Baker Hughes code)' : 'computed by DrillDash');
export const seriesColor = i => css(`--series-${(i % 8) + 1}`);

export function withAlpha(color, a) {
  const c = color.trim();
  if (c.startsWith('#')) {
    const n = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1);
    const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

// ---------------------------------------------------------------- time
let wellOffsetH = 0;
export function setWellTz(tzStr) {
  const m = /([+-])(\d{2}):?(\d{2})/.exec(tzStr || '');
  wellOffsetH = m ? (m[1] === '-' ? -1 : 1) * (+m[2] + +m[3] / 60) : 0;
}
export const tzOffsetMs = () => (S.tz === 'well' ? wellOffsetH * 3600e3 : 0);
export const tzLabel = () => (S.tz === 'well' ? `UTC${wellOffsetH >= 0 ? '+' : ''}${wellOffsetH}` : 'UTC');

const pad = n => String(n).padStart(2, '0');
function parts(ms) {
  const d = new Date(ms + tzOffsetMs());
  return { Y: d.getUTCFullYear(), M: pad(d.getUTCMonth() + 1), D: pad(d.getUTCDate()), h: pad(d.getUTCHours()), m: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()) };
}
export function fmtDT(ms, sec = false) {
  if (ms == null) return '–';
  const p = parts(ms);
  return `${p.Y}-${p.M}-${p.D} ${p.h}:${p.m}${sec ? ':' + p.s : ''}`;
}
export function fmtDate(ms) {
  if (ms == null) return '–';
  const p = parts(ms);
  return `${p.Y}-${p.M}-${p.D}`;
}
export function fmtHM(ms) { const p = parts(ms); return `${p.h}:${p.m}`; }
export function fmtDur(hours) {
  if (hours == null || !isFinite(hours)) return '–';
  if (hours >= 48) return `${(hours / 24).toFixed(1)} d`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(hours * 60)} min`;
}
/** uPlot tzDate: shift so local getters show the selected zone. */
export function tzDate(ms) {
  const t = ms + tzOffsetMs();
  return new Date(t + new Date(t).getTimezoneOffset() * 60e3);
}

/** Time-axis tick labels: date shown on the first tick and whenever the day changes. */
export function timeTicks(u, splits) {
  let lastDay = null;
  return splits.map(ms => {
    if (ms == null) return '';
    const p = parts(ms);
    const day = `${p.M}-${p.D}`;
    const hm = `${p.h}:${p.m}`;
    const out = day !== lastDay ? `${day}\n${hm}` : hm;
    lastDay = day;
    return out;
  });
}

export function compact(v) {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return v.toFixed(2).replace(/\.?0+$/, '');
  if (a === 0) return '0';
  return v.toPrecision(2);
}

// ---------------------------------------------------------------- misc
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
}

export function wellName(w, b) {
  return (b && b.info && b.info.name) || (w && w.info && w.info.name) || (w && w.id) || '';
}

/** Plotly layout defaults bound to the current theme tokens. */
export function plotlyBase(extra = {}) {
  const ink = css('--text-secondary'), grid = css('--grid'), axis = css('--axis');
  const ax = { gridcolor: grid, linecolor: axis, zerolinecolor: axis, tickfont: { color: ink, size: 11 }, title: { font: { color: ink, size: 12 } } };
  return Object.assign({
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', color: ink, size: 12 },
    margin: { l: 56, r: 16, t: 12, b: 44 },
    xaxis: { ...ax }, yaxis: { ...ax },
    hoverlabel: { bgcolor: css('--surface-2'), bordercolor: css('--border-strong'), font: { color: css('--text-primary') } },
    legend: { orientation: 'h', y: 1.12, x: 0, font: { color: ink } },
    showlegend: false,
  }, extra);
}
export const plotlyConfig = { displaylogo: false, responsive: true, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d'] };
