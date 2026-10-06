// TrackPanel: a row of vertical log tracks sharing one index (time or depth) window.
import { api } from './api.js';
import { h, seriesColor, debounce, fmtDT, S } from './core.js';
import { makeTrack, robustRange } from './charts.js';
import { chanConv, chanLabel, fmt } from './units.js';

export const MAX_CURVES = 6;

/** Drag handle on the right edge of `el` to change its width. Double-click the handle to reset. */
export function attachResizer(el, { min = 70, onMove, onEnd, onReset }) {
  const grip = h('div', { class: 'rz', title: 'Drag to resize · double-click to reset width', 'aria-hidden': 'true' });
  el.append(grip);
  grip.addEventListener('dblclick', e => { e.stopPropagation(); onReset && onReset(); });
  grip.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const x0 = e.clientX, w0 = el.getBoundingClientRect().width;
    let raf = 0, w = w0;
    document.body.classList.add('resizing');
    const move = ev => {
      w = Math.max(min, Math.round(w0 + ev.clientX - x0));
      el.style.flex = `0 0 ${w}px`;
      el.style.minWidth = `${w}px`;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; onMove && onMove(w); });
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.body.classList.remove('resizing');
      onEnd && onEnd(w);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  });
  return grip;
}

/** Replace nulls with undefined (= draw through) inside gaps shorter than maxGap. */
function bridge(x, y, maxGap) {
  let prev = -1;
  for (let i = 0; i < y.length; i++) {
    if (y[i] == null) continue;
    if (prev >= 0 && i - prev > 1 && x[i] - x[prev] <= maxGap) for (let k = prev + 1; k < i; k++) y[k] = undefined;
    prev = i;
  }
  return y;
}

/**
 * cfg = {
 *   kind: 'time'|'depth', W, B, syncKey,
 *   tracks: [{title, ch:[[src, mnem], ...], scales?: {unitLabel: [min, max]}}],
 *   unitOf(src, mnem) -> SI unit string, descOf(src, mnem), srcName(src)
 *   lead: { width, header(el), draw(u, panel) }        // custom first column (rig state / lithology)
 *   xDisp(v) / xSrv(v): index units server <-> display
 *   onWindow(win, user), onLoaded(resp), onHoverX(x), onReset()
 *   onAddCurve(trackIndex), onTracksChanged(tracks), onLayout(headerHeight)
 *   withStates: request rig-state run-lengths from 'drilling'
 * }
 */
export class TrackPanel {
  constructor(root, cfg) {
    this.root = root;
    this.cfg = Object.assign({ xDisp: v => v, xSrv: v => v }, cfg);
    this.win = null;
    this.tracks = [];
    this.states = null;
    this.reqId = 0;
    this.hoverX = null;
    this.el = h('div', { class: 'tracks' });
    window.__panel = this; // handy for debugging from the console
    root.append(this.el);
    this.loadSoon = debounce(() => this.load(), 140);
    this.ro = new ResizeObserver(debounce(() => this.resize(), 80));
    this.ro.observe(this.el);
    this.el.addEventListener('wheel', e => this.onWheel(e), { passive: false });
    this.closePop = e => { if (!e.target.closest('.popover')) this.hidePopover(); };
    this.tip = h('div', { class: 'curve-tip', role: 'tooltip', hidden: true });
    document.body.append(this.tip);
    document.addEventListener('mousedown', this.closePop);
    this.build(cfg.tracks);
  }

  // ------------------------------------------------------------------ layout
  build(tracks) {
    this.cfg.tracks = tracks;
    this.hidePopover();
    for (const t of this.tracks) t.u && t.u.destroy();
    this.el.innerHTML = '';
    this.tracks = [];
    const { lead } = this.cfg;
    if (lead) {
      const hd = h('div', { class: 'track-h' });
      const body = h('div', { class: 'track-b' });
      const lw = (this.cfg.leadWidth && this.cfg.leadWidth()) || lead.width;
      const el = h('div', { class: 'track state-track', style: lw ? { flex: `0 0 ${lw}px`, minWidth: lw + 'px' } : null }, hd, body);
      attachResizer(el, { min: 50, onMove: () => this.resize(),
        onEnd: w => this.cfg.onLeadWidth && this.cfg.onLeadWidth(w),
        onReset: () => { el.style.flex = `0 0 ${lead.width}px`; el.style.minWidth = lead.width + 'px'; this.cfg.onLeadWidth && this.cfg.onLeadWidth(null); this.resize(); } });
      this.el.append(el);
      const t = { lead: true, el, hd, body, ch: [], groups: [], locks: {} };
      el.__t = t;
      this.tracks.push(t);
      lead.header && lead.header(hd);
    }
    tracks.forEach((cfgT, ti) => (cfgT.hidden ? this.buildCollapsed(cfgT, ti) : this.tracks.push(this.buildTrack(cfgT, ti))));
    this.equalizeHeaders();
    requestAnimationFrame(() => this.createCharts());
  }

  /** A hidden track folds into a thin strip; clicking it shows the track again. */
  buildCollapsed(cfgT, ti) {
    this.el.append(h('button', { class: 'track-collapsed', title: `Show the ${cfgT.title} track`, 'aria-label': `Show ${cfgT.title} track`,
      onclick: () => { this.setTrackProp(ti, 'hidden', undefined); this.rebuild(); } },
      h('span', { class: 'eye', 'aria-hidden': 'true' }, '◉'), h('span', { class: 'lbl' }, cfgT.title)));
  }

  rebuild() {
    this.build(this.cfg.tracks);
  }

  toggleCurve(t, i) {
    const c = t.ch[i];
    c.off = !c.off;
    // set visibility directly: uPlot's setSeries() expects a legend, which these tracks don't use
    if (t.u) { for (let k = 1; k <= 3; k++) t.u.series[i * 3 + k].show = !c.off; t.u.redraw(true); }
    c.row.classList.toggle('off', c.off);
    const off = t.ch.filter(x => x.off).map(x => `${x.src}|${x.m}`);
    this.setTrackProp(t.ti, 'off', off.length ? off : undefined);
    this.refreshScales(t);
  }

  buildTrack(cfgT, ti) {
    const hd = h('div', { class: 'track-h' });
    const body = h('div', { class: 'track-b' });
    const el = h('div', { class: 'track', style: cfgT.w ? { flex: `0 0 ${cfgT.w}px`, minWidth: `${cfgT.w}px` } : null }, hd, body);
    this.el.append(el);
    const t = { ti, el, hd, body, title: cfgT.title, ch: [], groups: [], locks: {} };
    attachResizer(el, {
      onMove: () => this.resize(),
      onEnd: w => this.setTrackProp(ti, 'w', w),
      onReset: () => { el.style.flex = ''; el.style.minWidth = ''; this.setTrackProp(ti, 'w', undefined); this.resize(); },
    });
    el.__t = t;
    const multi = cfgT.ch.length > 1;
    const offSet = new Set(cfgT.off || []);
    const sepSet = new Set(cfgT.sep || []); // curves with their own (independent) scale
    // track title when it adds information (several curves, or a single curve with a cryptic mnemonic)
    const showTitle = multi || (cfgT.ch[0] && cfgT.title && cfgT.title !== chanLabel(cfgT.ch[0][1], cfgT.ch[0][0]));
    if (showTitle) hd.append(h('div', { class: 'row' }, h('span', { class: 'n tt' }, cfgT.title)));
    cfgT.ch.forEach(([src, m], i) => {
      const cv = chanConv(m, this.cfg.unitOf(src, m), src);
      const missing = this.cfg.hasSrc && !this.cfg.hasSrc(src);
      // a curve whose log is absent here joins the first scale instead of adding an empty one
      // curves share a scale per unit, unless a curve is set to its own scale (e.g. block height next to depths)
      const sep = !missing && sepSet.has(`${src}|${m}`) && t.groups.length > 0;
      let g = missing && t.groups.length ? t.groups[0] : sep ? null : t.groups.find(x => x.label === cv.label && !x.sep);
      if (!g) {
        g = { key: `y${t.groups.length}`, label: cv.label, sid: sep ? `${cv.label}#${src}|${m}` : cv.label, sep, idx: [] };
        t.groups.push(g);
      }
      g.idx.push(i);
      const color = seriesColor(i);
      const valEl = h('span', { class: 'val', title: missing ? 'This log is not recorded in this wellbore' : null }, missing ? 'n/a' : '–');
      const desc = this.cfg.descOf ? this.cfg.descOf(src, m) : null;
      const srcN = this.cfg.srcName ? this.cfg.srcName(src) : src;
      const off = offSet.has(`${src}|${m}`);
      const nameEl = h('button', { class: 'n curve-btn', 'aria-pressed': String(!off),
        title: `${desc || m}\n${srcN} · ${m}\nClick: show / hide this curve · right-click or ⋯: scale, remove`,
        onclick: () => this.toggleCurve(t, i),
        oncontextmenu: e => { e.preventDefault(); this.showPopover(t, i, e.currentTarget); } },
        h('i', { style: { background: color } }), chanLabel(m, src, multi));
      const moreEl = h('button', { class: 'more', title: 'Scale / remove', 'aria-label': `${m} options`,
        onclick: e => this.showPopover(t, i, e.currentTarget) }, '⋯');
      const row = h('div', { class: `row${off ? ' off' : ''}` }, nameEl, h('span', { class: 'vwrap' }, valEl, moreEl));
      hd.append(row);
      t.ch.push({ src, m, cv, color, valEl, row, last: null, scale: g.key, missing, off, sep: sepSet.has(`${src}|${m}`) });
    });
    // extra scales (other units, or curves set to their own scale) get their own coloured bottom axis
    t.resetBtn = h('button', { class: 'tbtn', title: 'Reset value zoom (or double-click the track)', hidden: true, onclick: () => this.clearLocks(t) }, '⟲ scale');
    const addBtn = h('button', { class: 'tbtn', title: 'Add a curve to this track', disabled: cfgT.ch.length >= MAX_CURVES,
      onclick: () => this.cfg.onAddCurve && this.cfg.onAddCurve(ti) }, '+ curve');
    const hideBtn = h('button', { class: 'tbtn', title: 'Hide this track (click the strip to show it again)',
      onclick: () => { this.setTrackProp(ti, 'hidden', true); this.rebuild(); } }, 'Hide');
    hd.append(h('div', { class: 'tools' }, t.resetBtn, addBtn, hideBtn));
    return t;
  }

  setTrackProp(ti, key, val) {
    const tracks = this.cfg.tracks.map(x => ({ ...x }));
    if (val === undefined) delete tracks[ti][key]; else tracks[ti][key] = val;
    this.cfg.tracks = tracks;
    this.cfg.onTracksChanged && this.cfg.onTracksChanged(tracks);
  }

  equalizeHeaders() {
    for (const t of this.tracks) t.hd.style.height = '';
    const hh = Math.max(...this.tracks.map(t => t.hd.offsetHeight), 40);
    for (const t of this.tracks) t.hd.style.height = hh + 'px';
    this.headerH = hh;
    this.cfg.onLayout && this.cfg.onLayout(hh);
  }

  createCharts() {
    const { kind, syncKey, lead } = this.cfg;
    this.tracks.forEach((t, i) => {
      const w = Math.max(60, t.body.clientWidth), hh = Math.max(120, t.body.clientHeight);
      t.u = makeTrack(t.body, {
        kind, width: w, height: hh, syncKey,
        showAxis: i === 0, hideY: !!t.lead,
        series: t.ch.map(c => ({ label: c.m, color: c.color, scale: c.scale, show: !c.off })),
        rangeFor: (k, u) => this.rangeFor(t, k, u),
        onSelect: res => this.onBoxZoom(t, res),
        onDblClick: () => (Object.keys(t.locks).length ? this.clearLocks(t) : this.cfg.onReset && this.cfg.onReset()),
        onHover: (idx, u) => this.onHover(t, idx, u),
        draw: t.lead ? (u => lead.draw(u, this)) : (u => this.afterDraw(t, u)),
      });
      t.w = w; t.hh = hh;
      // remember where a drag starts: synced plots mirror the selection, but value zoom belongs to one track
      t.u.over.addEventListener('mousedown', () => { this.dragSrc = t; this.hideTip(); }, true);
      // hover tooltip follows the pointer in the track under the mouse
      t.u.over.addEventListener('mouseenter', () => { this.hoverTrack = t; });
      t.u.over.addEventListener('mouseleave', () => { if (this.hoverTrack === t) this.hoverTrack = null; this.hideTip(); });
    });
    if (this.win) { this.applyScale(); this.load(); }
  }

  resize() {
    for (const t of this.tracks) {
      if (!t.u) continue;
      const w = Math.max(60, t.body.clientWidth), hh = Math.max(120, t.body.clientHeight);
      if (w !== t.w || hh !== t.hh) { t.u.setSize({ width: w, height: hh }); t.w = w; t.hh = hh; }
    }
    this.loadSoon();
  }

  // ------------------------------------------------------------------ scales
  rangeFor(t, key, u) {
    if (t.locks[key]) return t.locks[key];
    const g = t.groups.find(x => x.key === key);
    if (!g) return [0, 1];
    const manual = (this.cfg.tracks[t.ti] && this.cfg.tracks[t.ti].scales || {})[g.sid || g.label];
    const auto = () => robustRange(g.idx.filter(i => !t.ch[i].off).map(i => u.data[1 + i * 3]));
    if (manual) {
      const [mn, mx] = manual;
      if (mn != null && mx != null && mx > mn) return [mn, mx];
      const a = auto();
      return [mn != null ? mn : a[0], mx != null ? mx : a[1]];
    }
    return auto();
  }

  afterDraw(t, u) {
    // keep the header scale labels of secondary units current
    for (const g of t.groups.slice(1)) {
      const s = u.scales[g.key];
      if (g.el && s && s.min != null) g.el.textContent = `${fmt(s.min)} – ${fmt(s.max)}`;
    }
  }

  onBoxZoom(t, res) {
    if (res.v && t === this.dragSrc) {
      Object.assign(t.locks, res.v);
      this.refreshScales(t);
    }
    if (res.t) this.setWindow([this.cfg.xSrv(res.t[0]), this.cfg.xSrv(res.t[1])], true);
  }

  refreshScales(t) {
    if (!t.u) return;
    t.resetBtn.hidden = !Object.keys(t.locks).length;
    t.u.batch(() => {
      for (const g of t.groups) {
        const r = this.rangeFor(t, g.key, t.u);
        t.u.setScale(g.key, { min: r[0], max: r[1] });
      }
    });
  }

  clearLocks(t) {
    t.locks = {};
    this.refreshScales(t);
  }

  // ------------------------------------------------------------------ window & data
  setWindow(win, user = false) {
    let [a, b] = win;
    if (this.cfg.clamp) [a, b] = this.cfg.clamp(a, b);
    this.win = [a, b];
    this.cfg.onWindow && this.cfg.onWindow(this.win, user);
    this.applyScale();
    this.loadSoon();
  }

  applyScale() {
    if (!this.win) return;
    const a = this.cfg.xDisp(this.win[0]), b = this.cfg.xDisp(this.win[1]);
    for (const t of this.tracks) t.u && t.u.setScale('x', { min: a, max: b });
  }

  async load() {
    if (!this.win || !this.tracks.length || !this.tracks[this.tracks.length - 1].u) return;
    const id = ++this.reqId;
    const [x0, x1] = this.win;
    const n = Math.min(1500, Math.max(200, Math.round((this.tracks[0].hh || 600) * 1.2)));
    const bySrc = new Map();
    for (const t of this.tracks) for (const c of t.ch) {
      if (!bySrc.has(c.src)) bySrc.set(c.src, new Set());
      bySrc.get(c.src).add(c.m);
    }
    if (this.cfg.withStates && !bySrc.has('drilling')) bySrc.set('drilling', new Set());
    const res = {};
    try {
      await Promise.all([...bySrc.entries()].map(async ([src, set]) => {
        try {
          const st = this.cfg.withStates && src === 'drilling' ? (this.cfg.stateMode ? this.cfg.stateMode() : 'calc') : false;
          res[src] = await api.series(this.cfg.W, this.cfg.B, src, [...set], x0, x1, n, st);
        } catch (e) { console.warn(e); res[src] = null; } // one bad source must not blank the other tracks
      }));
    } catch (e) {
      console.error(e);
      return;
    }
    if (id !== this.reqId) return; // stale
    if (this.cfg.withStates) this.states = res.drilling && res.drilling.states;
    const xd = this.cfg.xDisp;
    // sparse curves: connect points closer than this (server index units); longer gaps stay visible
    const maxGap = Math.max((x1 - x0) * 0.02, this.cfg.kind === 'time' ? 10 * 60e3 : 3);
    for (const t of this.tracks) {
      if (t.lead) {
        t.u.setData([[xd(x0), xd(x1)], [null, null]], false);
        continue;
      }
      // join channels that come from different sources (different sample times)
      const parts = t.ch.map(c => {
        const r = res[c.src];
        const s = r && r.series[c.m];
        if (!s) return null;
        const f = c.cv.f;
        const cvt = arr => arr ? arr.map(v => v == null ? null : f(v)) : null;
        const avg = bridge(r.x, cvt(s.avg), maxGap);
        return { src: c.src, x: r.x, avg, min: cvt(s.min) || avg.map(() => null), max: cvt(s.max) || avg.map(() => null) };
      });
      let data;
      const valid = parts.filter(Boolean);
      const sameX = valid.length && valid.every(p => p.src === valid[0].src);
      if (!valid.length) data = [[xd(x0), xd(x1)], ...t.ch.flatMap(() => [[null, null], [null, null], [null, null]])];
      else if (sameX) {
        const nx = valid[0].x.length, nul = Array(nx).fill(null);
        data = [valid[0].x.map(xd), ...parts.flatMap(p => p ? [p.avg, p.min, p.max] : [nul, nul, nul])];
      } else {
        const tables = parts.map(p => p ? [p.x.map(xd), p.avg, p.min, p.max] : [[xd(x0)], [null], [null], [null]]);
        data = uPlot.join(tables);
      }
      t.u.setData(data, false);
      t.hasData = valid.some(p => p.avg.some(v => v != null));
      const empty = t.body.querySelector('.track-empty');
      if (!t.hasData && !empty) t.body.append(h('div', { class: 'track-empty' }, 'No data in this window'));
      if (t.hasData && empty) empty.remove();
      // "latest" value for the header when not hovering
      t.ch.forEach((c, i) => {
        const arr = data[1 + i * 3];
        let v = null;
        for (let k = arr.length - 1; k >= 0; k--) if (arr[k] != null) { v = arr[k]; break; }
        c.last = v;
      });
      if (this.hoverX == null) this.renderHeader(t, null);
    }
    this.applyScale();
    for (const t of this.tracks) t.u.redraw(false, true);
    this.cfg.onLoaded && this.cfg.onLoaded(res);
  }

  // ------------------------------------------------------------------ interaction
  onHover(t, idx, u) {
    const pos = u.scales.x.ori === 1 ? u.cursor.top : u.cursor.left;
    const active = pos != null && pos >= 0;
    const xv = active ? u.posToVal(pos, 'x') : null;
    if (t === this.tracks[0]) {
      this.hoverX = xv;
      this.cfg.onHoverX && this.cfg.onHoverX(xv == null ? null : this.cfg.xSrv(xv));
    }
    if (t === this.hoverTrack) {
      if (active && S.tooltip !== false && !(u.select && u.select.height > 0)) this.renderTip(t, idx, u, xv); else this.hideTip();
    }
    if (t.lead) return;
    this.renderHeader(t, active ? idx : null);
  }

  valueAt(t, i, idx) {
    const arr = t.u.data[1 + i * 3];
    let v = arr[idx];
    if (v === undefined) { // joined / bridged data: nearest real sample of this curve
      for (let d = 1; d < 50; d++) {
        if (arr[idx - d] != null) { v = arr[idx - d]; break; }
        if (arr[idx + d] != null) { v = arr[idx + d]; break; }
      }
    }
    return v;
  }

  renderTip(t, idx, u, xv) {
    const tip = this.tip;
    const xs = this.cfg.xSrv(xv);
    tip.innerHTML = '';
    tip.append(h('div', { class: 'tip-x num' }, this.cfg.kind === 'time' ? fmtDT(xs, true) : `MD ${fmt(xv, 1)} ${this.cfg.xLabel || ''}`));
    const extra = this.cfg.tipExtra && this.cfg.tipExtra(xs);
    if (extra) tip.append(extra);
    if (!t.lead) {
      if (t.ch.length > 1) tip.append(h('div', { class: 'tip-t' }, t.title));
      t.ch.forEach((c, i) => {
        if (c.off) return;
        const v = c.missing || idx == null ? null : this.valueAt(t, i, idx);
        tip.append(h('div', { class: 'tip-row' }, h('i', { style: { background: c.color } }),
          h('span', { class: 'tip-n' }, chanLabel(c.m, c.src)),
          h('b', { class: 'num' }, c.missing ? 'n/a' : v == null ? '–' : fmt(v)), h('small', {}, c.missing ? '' : c.cv.label)));
      });
    }
    tip.hidden = false;
    const r = u.over.getBoundingClientRect();
    const px = r.left + (u.cursor.left || 0), py = r.top + (u.cursor.top || 0);
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = px + 16, y = py + 12;
    if (x + tw > window.innerWidth - 6) x = px - tw - 16;
    if (y + th > window.innerHeight - 6) y = py - th - 12;
    tip.style.transform = `translate(${Math.max(4, x)}px, ${Math.max(4, y)}px)`;
  }

  hideTip() { this.tip.hidden = true; }

  renderHeader(t, idx) {
    t.ch.forEach((c, i) => {
      if (c.missing) return;
      let v = c.last;
      if (idx != null && t.u) v = this.valueAt(t, i, idx);
      c.valEl.innerHTML = '';
      c.valEl.append(v == null ? '–' : fmt(v), h('small', {}, c.cv.label));
    });
  }

  onWheel(e) {
    if (!this.win) return;
    this.hideTip();
    e.preventDefault();
    const dy = e.deltaY || e.deltaX;
    const t = e.target.closest('.track')?.__t;
    if (e.shiftKey && t && !t.lead && t.u) {
      // value zoom around the pointer
      const k = dy > 0 ? 1.25 : 0.8;
      const rect = t.u.over.getBoundingClientRect();
      const px = e.clientX - rect.left;
      for (const g of t.groups) {
        const s = t.u.scales[g.key];
        if (s.min == null) continue;
        const c = t.u.posToVal(px, g.key);
        t.locks[g.key] = [c - (c - s.min) * k, c + (s.max - c) * k];
      }
      this.refreshScales(t);
      return;
    }
    const [a, b] = this.win;
    const span = b - a;
    if (e.ctrlKey || e.metaKey) {
      const k = dy > 0 ? 1.25 : 0.8;
      const c = this.hoverX != null ? this.cfg.xSrv(this.hoverX) : (a + b) / 2;
      this.setWindow([c - (c - a) * k, c + (b - c) * k], true);
    } else {
      const d = Math.sign(dy) * span * 0.12;
      this.setWindow([a + d, b + d], true);
    }
  }

  showPopover(t, i, anchor) {
    this.hidePopover();
    const cfgT = this.cfg.tracks[t.ti];
    const c = t.ch[i];
    const g = t.groups.find(x => x.key === c.scale);
    const sid = g.sid || g.label;
    const cur = (cfgT.scales || {})[sid] || [];
    const key = `${c.src}|${c.m}`;
    const ownBox = h('input', { type: 'checkbox', checked: !!c.sep, disabled: t.ch.length < 2 });
    ownBox.onchange = () => {
      const sep = new Set(cfgT.sep || []);
      if (ownBox.checked) sep.add(key); else sep.delete(key);
      this.setTrackProp(t.ti, 'sep', sep.size ? [...sep] : undefined);
      this.rebuild();
    };
    const mn = h('input', { class: 'input', type: 'number', step: 'any', value: cur[0] ?? '', placeholder: 'auto', 'aria-label': 'Scale minimum' });
    const mx = h('input', { class: 'input', type: 'number', step: 'any', value: cur[1] ?? '', placeholder: 'auto', 'aria-label': 'Scale maximum' });
    const commit = scales => {
      const tracks = this.cfg.tracks.map(x => ({ ...x }));
      tracks[t.ti] = { ...cfgT, scales };
      this.cfg.tracks = tracks;
      this.cfg.onTracksChanged && this.cfg.onTracksChanged(tracks);
      delete t.locks[g.key];
      this.refreshScales(t);
      this.hidePopover();
    };
    const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': `${c.m} options` },
      h('div', { class: 'pop-h' }, h('i', { style: { background: c.color } }), h('b', {}, chanLabel(c.m, c.src)),
        h('span', { class: 'muted' }, ` · ${this.cfg.srcName ? this.cfg.srcName(c.src) : c.src}`)),
      h('label', { class: 'own-scale', title: 'Give this curve an independent scale that fills the track width, e.g. block height next to hole/bit depth. Its range is listed in the legend.' },
        ownBox, h('span', {}, h('b', {}, 'Own scale'), h('span', { class: 'muted' }, t.ch.length < 2 ? ' - only one curve in this track' : ' - fit this curve to the track width'))),
      h('div', { class: 'muted', style: { fontSize: '12px' } }, g.sep ? 'Fixed min / max for this curve' : `Fixed scale (${g.label || 'no unit'}) - shared by curves with this unit in the track`),
      h('div', { class: 'pop-row' }, h('label', {}, 'Min', mn), h('label', {}, 'Max', mx)),
      h('div', { class: 'pop-row' },
        h('button', { class: 'btn sm primary', onclick: () => {
          const a = mn.value === '' ? null : +mn.value, b = mx.value === '' ? null : +mx.value;
          commit({ ...(cfgT.scales || {}), [sid]: [a, b] });
        } }, 'Apply'),
        h('button', { class: 'btn sm', onclick: () => { const s = { ...(cfgT.scales || {}) }; delete s[sid]; commit(s); } }, 'Auto'),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm ghost danger', onclick: () => {
          const tracks = this.cfg.tracks.map(x => ({ ...x, ch: [...x.ch] }));
          tracks[t.ti].ch.splice(i, 1);
          if (!tracks[t.ti].ch.length) tracks.splice(t.ti, 1);
          this.cfg.onTracksChanged && this.cfg.onTracksChanged(tracks);
          this.build(tracks);
          if (this.win) this.applyScale();
        } }, 'Remove curve')));
    document.body.append(pop);
    // keep the popover inside the viewport: below the curve name if it fits, otherwise above it
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 280, ph = pop.offsetHeight;
    const below = r.bottom + 6, above = r.top - ph - 6;
    const top = below + ph <= window.innerHeight - 8 ? below : Math.max(8, above);
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left)) + 'px';
    pop.style.top = Math.min(top, Math.max(8, window.innerHeight - ph - 8)) + 'px';
    this.pop = pop;
    mn.focus();
  }

  hidePopover() { if (this.pop) { this.pop.remove(); this.pop = null; } }

  redrawLead() { const t = this.tracks[0]; if (t && t.lead && t.u) t.u.redraw(false, false); }

  /** Visible curves (hidden tracks and switched-off curves are left out, e.g. for CSV export). */
  curves() {
    return this.cfg.tracks.filter(t => !t.hidden).flatMap(t => t.ch.filter(([s, m]) => !(t.off || []).includes(`${s}|${m}`)));
  }

  destroy() {
    this.ro.disconnect();
    document.removeEventListener('mousedown', this.closePop);
    this.hidePopover();
    this.tip.remove();
    for (const t of this.tracks) t.u && t.u.destroy();
    this.el.remove();
  }
}
