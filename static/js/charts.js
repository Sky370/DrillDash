// uPlot builders: vertical log tracks (time or depth running down), state painter, vertical overview.
import { css, withAlpha, stateColor, timeTicks, tzDate, compact } from './core.js';

const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

function axisStyle() {
  return {
    stroke: css('--text-muted'),
    font: FONT,
    grid: { stroke: css('--grid'), width: 1 },
    ticks: { stroke: css('--axis'), width: 1, size: 4 },
  };
}

/** Robust [lo, hi] of several arrays: 0.5/99.5 percentiles unless the full range is only modestly larger. */
export function robustRange(arrays) {
  const vals = [];
  for (const a of arrays) if (a) for (const v of a) if (v != null && isFinite(v)) vals.push(v);
  if (!vals.length) return [0, 1];
  vals.sort((a, b) => a - b);
  let lo = vals[Math.floor(vals.length * 0.005)], hi = vals[Math.max(0, Math.ceil(vals.length * 0.995) - 1)];
  const flo = vals[0], fhi = vals[vals.length - 1];
  if (fhi - flo <= 1.5 * (hi - lo)) { lo = flo; hi = fhi; }
  if (lo === hi) return [lo - 1, hi + 1];
  const p = (hi - lo) * 0.06;
  return [lo - p, hi + p];
}

/**
 * Paint rig-state segments ({x:[], s:[]} run-length).
 * vertical: fill across the plot (or the [band0, bandW] css-px strip); horizontal: strip of `inset` px at the bottom.
 */
export function paintStates(u, st, { vertical = true, x1 = null, inset = null, band = null } = {}) {
  if (!st || !st.x || !st.x.length) return;
  const ctx = u.ctx, dpr = devicePixelRatio;
  const { left, top, width, height } = u.bbox;
  const end = x1 ?? u.scales.x.max;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  for (let i = 0; i < st.x.length; i++) {
    const s = st.s[i];
    if (s <= 0) continue; // no data -> leave the surface showing
    const a = u.valToPos(st.x[i], 'x', true);
    const b = u.valToPos(i + 1 < st.x.length ? st.x[i + 1] : end, 'x', true);
    ctx.fillStyle = stateColor(s);
    if (vertical) {
      const x0 = band ? left + band[0] * dpr : left, w = band ? band[1] * dpr : width;
      ctx.fillRect(x0, Math.min(a, b), w, Math.max(1, Math.abs(b - a)));
    } else {
      const y = inset ? top + height - inset * dpr : top;
      const hh = inset ? inset * dpr : height;
      ctx.fillRect(Math.min(a, b), y, Math.max(1, Math.abs(b - a)), hh);
    }
  }
  ctx.restore();
}

/**
 * A vertical log track. Data layout: [x, (avg,min,max) per series...].
 * series: [{label, color, scale}] - several value scales are allowed; the first one uses the bottom
 *   axis, every extra scale is drawn as a small axis strip inside the plot (numbers in the curve colour),
 *   so the plot height - and the alignment with the other tracks - never changes.
 * rangeFor(scaleKey, u) -> [min, max]
 * onSelect({t:[a,b]?, v:{scaleKey:[a,b]}?}) - box zoom: vertical drag = index, horizontal = values, diagonal = both
 */
export function makeTrack(el, cfg) {
  const { kind = 'time', width, height, series = [], showAxis = false, syncKey = null,
    onSelect, onHover, onDblClick, draw, hideY = false, rangeFor } = cfg;
  const AX_H = 20;
  const ax = axisStyle();
  const sOpts = [{}];
  const bands = [];
  const scaleKeys = [...new Set(series.map(s => s.scale || 'y0'))];
  if (!scaleKeys.length) scaleKeys.push('y0');
  series.forEach((s, i) => {
    const base = 1 + i * 3, scale = s.scale || 'y0';
    const show = s.show !== false;
    sOpts.push({ label: s.label, scale, show, stroke: s.color, width: 1.5, spanGaps: false, points: { show: false } });
    sOpts.push({ label: s.label + ' min', scale, show, stroke: 'transparent', width: 0, points: { show: false } });
    sOpts.push({ label: s.label + ' max', scale, show, stroke: 'transparent', width: 0, points: { show: false } });
    bands.push({ series: [base + 2, base + 1], fill: withAlpha(s.color, 0.16) });
  });
  if (!series.length) sOpts.push({ label: '', scale: 'y0', stroke: 'transparent', points: { show: false } });

  const scales = { x: { time: kind === 'time', ori: 1, dir: -1, auto: false } };
  for (const k of scaleKeys) {
    scales[k] = { ori: 0, dir: 1, range: u => (rangeFor ? rangeFor(k, u) : [0, 1]) };
  }
  const opts = {
    width, height,
    ms: 1,
    tzDate: kind === 'time' ? tzDate : undefined,
    // the rig-state / lithology column has no value axis: pad it so its plot lines up with the others
    padding: [6, hideY ? 4 : 16, 6 + (hideY ? AX_H : 0), showAxis ? 0 : 16],
    legend: { show: false },
    scales,
    axes: [
      {
        scale: 'x', side: 3, show: showAxis, size: showAxis ? 58 : 0, space: 46, gap: 4,
        values: kind === 'time' ? timeTicks : (u, v) => v.map(x => x == null ? '' : compact(x)),
        ...ax,
      },
      { scale: scaleKeys[0], side: 2, show: !hideY, size: hideY ? 0 : AX_H, space: 44, gap: 2, values: (u, v) => v.map(compact), ...ax },
    ],
    series: sOpts,
    bands,
    cursor: {
      sync: syncKey ? { key: syncKey } : undefined,
      // uni: a drag must move >= 40 px across the values to also zoom values (keeps time drags clean)
      drag: { x: true, y: !hideY, uni: 40, setScale: false },
      points: { show: false },
      x: true, y: false,
      bind: onDblClick ? { dblclick: () => () => { onDblClick(); return null; } } : undefined,
    },
    select: { show: true },
    hooks: {
      setSelect: [u => {
        const s = u.select, W = u.over.clientWidth, H = u.over.clientHeight;
        const vert = u.scales.x.ori === 1;
        const tA = vert ? s.top : s.left, tL = vert ? s.height : s.width, tFull = vert ? H : W;
        const vA = vert ? s.left : s.top, vL = vert ? s.width : s.height, vFull = vert ? W : H;
        const res = {};
        if (tL > 4 && tL < tFull - 2) {
          const a = u.posToVal(tA, 'x'), b = u.posToVal(tA + tL, 'x');
          res.t = [Math.min(a, b), Math.max(a, b)];
        }
        if (!hideY && vL > 4 && vL < vFull - 2) {
          res.v = {};
          for (const k of scaleKeys) {
            const a = u.posToVal(vA, k), b = u.posToVal(vA + vL, k);
            res.v[k] = [Math.min(a, b), Math.max(a, b)];
          }
        }
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
        if ((res.t || res.v) && onSelect) onSelect(res);
      }],
      setCursor: onHover ? [u => onHover(u.cursor.idx, u)] : [],
      draw: [u => { if (!hideY) drawInnerAxes(u, scaleKeys.slice(1), series); draw && draw(u); }],
    },
  };
  const data = [[], ...series.flatMap(() => [[], [], []])];
  if (!series.length) data.push([]);
  const u = new uPlot(opts, data, el);
  u._scaleKeys = scaleKeys;
  return u;
}

function niceStep(span, n) {
  const raw = span / Math.max(1, n);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/** Axis strips inside the bottom of the plot for extra scales (one row each, coloured like the curve). */
function drawInnerAxes(u, keys, series) {
  if (!keys.length) return;
  const ctx = u.ctx, dpr = devicePixelRatio;
  const { left, top, width, height } = u.bbox;
  const rowH = 16 * dpr;
  const bg = withAlpha(css('--surface-1'), 0.82);
  ctx.save();
  ctx.font = `${11 * dpr}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textBaseline = 'middle';
  keys.forEach((k, j) => {
    const s = u.scales[k];
    if (!s || s.min == null || s.max == null || s.max === s.min) return;
    const col = (series.find(x => (x.scale || 'y0') === k) || {}).color || css('--text-muted');
    const y0 = top + height - (j + 1) * rowH;
    ctx.fillStyle = bg;
    ctx.fillRect(left, y0, width, rowH);
    ctx.strokeStyle = col;
    ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.moveTo(left, y0 + 0.5 * dpr); ctx.lineTo(left + width, y0 + 0.5 * dpr); ctx.stroke();
    const step = niceStep(s.max - s.min, Math.max(2, Math.floor(width / (52 * dpr))));
    ctx.fillStyle = col;
    for (let v = Math.ceil(s.min / step) * step; v <= s.max + step * 1e-9; v += step) {
      const x = u.valToPos(v, k, true);
      if (x < left || x > left + width) continue;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + 3 * dpr); ctx.stroke();
      const label = compact(Math.abs(v) < step * 1e-6 ? 0 : v);
      const tw = ctx.measureText(label).width;
      // keep labels inside the strip at the edges
      ctx.textAlign = 'left';
      ctx.fillText(label, Math.min(Math.max(x - tw / 2, left + 2 * dpr), left + width - tw - 2 * dpr), y0 + rowH / 2 + dpr);
    }
  });
  ctx.restore();
}

/**
 * Vertical overview of the whole wellbore (time runs down): hole/bit depth, rig-state ribbon, window band.
 * Drag the band to move it, drag elsewhere to draw a new window, wheel to widen/narrow, click to jump.
 */
export function makeVOverview(el, cfg) {
  const { width, height, getWindow, getStates, onWindow } = cfg;
  const ax = axisStyle();
  const c1 = css('--series-1'), c2 = css('--series-2');
  let rubber = null;
  const RIB = 7; // ribbon width, css px
  const u = new uPlot({
    width, height, ms: 1, tzDate,
    padding: [6, 10, 6, 0],
    legend: { show: false },
    scales: {
      x: { time: true, ori: 1, dir: -1 },
      y: { ori: 0, dir: 1, range: (u, mn, mx) => [0, (mx ?? 1) * 1.04] },
    },
    axes: [
      { ...ax, scale: 'x', side: 3, size: 46, space: 40, gap: 3, values: (u, s) => dateTicks(s) },
      { ...ax, scale: 'y', side: 2, size: 20, space: 40, gap: 2, values: (u, v) => v.map(compact) },
    ],
    series: [{}, { label: 'Hole depth', stroke: c1, width: 1.5 }, { label: 'Bit depth', stroke: c2, width: 1 }],
    cursor: { drag: { x: false, y: false }, points: { show: false }, x: true, y: false },
    hooks: {
      draw: [u => {
        paintStates(u, getStates(), { vertical: true, band: [0, RIB] });
        const ctx = u.ctx, dpr = devicePixelRatio;
        const { left, width, top, height } = u.bbox;
        const box = (w, fill, stroke) => {
          const a = u.valToPos(w[0], 'x', true), b = u.valToPos(w[1], 'x', true);
          const y = Math.max(top, Math.min(a, b)), y2 = Math.min(top + height, Math.max(a, b));
          const hh = Math.max(3 * dpr, y2 - y);
          ctx.fillStyle = fill; ctx.fillRect(left, y, width, hh);
          ctx.strokeStyle = stroke; ctx.lineWidth = dpr; ctx.strokeRect(left + dpr / 2, y, width - dpr, hh);
        };
        ctx.save();
        const w = getWindow();
        if (w) box(w, withAlpha(css('--text-primary'), 0.12), css('--text-primary'));
        if (rubber) box([Math.min(...rubber), Math.max(...rubber)], withAlpha(css('--accent'), 0.18), css('--accent'));
        ctx.restore();
      }],
    },
  }, [[], [], []], el);

  const tAt = e => u.posToVal(e.clientY - u.over.getBoundingClientRect().top, 'x');
  let mode = null, anchor = 0, offset = 0, y0 = 0;
  u.over.style.cursor = 'crosshair';
  u.over.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const t = tAt(e), w = getWindow();
    y0 = e.clientY;
    const tol = Math.abs(u.posToVal(6, 'x') - u.posToVal(0, 'x'));
    if (w && t >= w[0] - tol && t <= w[1] + tol) { mode = 'move'; offset = t - w[0]; }
    else { mode = 'select'; anchor = t; rubber = [t, t]; }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  });
  function onMove(e) {
    const t = tAt(e), w = getWindow();
    if (mode === 'move' && w) {
      const span = w[1] - w[0];
      onWindow(t - offset, t - offset + span, false);
    } else if (mode === 'select') {
      rubber = [anchor, t];
      u.redraw(false, false);
    }
  }
  function onUp(e) {
    document.removeEventListener('mousemove', onMove);
    const t = tAt(e), w = getWindow();
    if (mode === 'select') {
      rubber = null;
      if (Math.abs(e.clientY - y0) < 4) {
        const span = w ? w[1] - w[0] : 6 * 3600e3;
        onWindow(t - span / 2, t + span / 2, true);
      } else onWindow(Math.min(anchor, t), Math.max(anchor, t), true);
    } else if (mode === 'move' && w) onWindow(w[0], w[1], true);
    mode = null;
    u.redraw(false, false);
  }
  u.over.addEventListener('wheel', e => {
    e.preventDefault();
    const w = getWindow();
    if (!w) return;
    const k = e.deltaY > 0 ? 1.3 : 1 / 1.3;
    const c = (w[0] + w[1]) / 2, half = (w[1] - w[0]) * k / 2;
    onWindow(c - half, c + half, true);
  }, { passive: false });
  return u;
}

function dateTicks(splits) {
  let lastY = null;
  return splits.map(ms => {
    if (ms == null) return '';
    const d = tzDate(ms);
    const y = d.getFullYear();
    const s = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const out = y !== lastY ? `${y}\n${s}` : s;
    lastY = y;
    return out;
  });
}
