// Well info: metadata, casing schematic, BHA runs, remarks, and the inventory of every log & channel.
import { api } from '../api.js';
import { S, save, h, fmtDT, fmtDate, toast } from '../core.js';
import { conv, chanConv, fmt } from '../units.js';
import { DEFAULT_TRACKS } from './drilling.js';
import { DEFAULT_DEPTH_TRACKS } from './depth.js';

export async function mount(main, ctx) {
  const W = ctx.wid, B = ctx.wbId;
  const [logs, bha, geo, msgs] = await Promise.all([api.logs(W, B), api.obj(W, B, 'bha'), api.obj(W, B, 'geometry'), api.messages(W, B)]);
  const L = conv('m');
  const wi = ctx.well.info, bi = ctx.wb.info, rig = ctx.wb.rig, D = ctx.wb.drilling;

  main.append(h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, `${ctx.name}`),
    h('p', {}, `Source folder: ${ctx.well.folder} / wellbore ${B}`))));

  // ------------ metadata + schematic
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(p => p[1] != null && p[1] !== '').flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const meta = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Well & wellbore')), h('div', { class: 'card-b' }, kv([
    ['Well', wi.name], ['Wellbore', bi.name], ['Field', wi.field], ['Block', wi.block], ['Country', wi.country], ['Operator', wi.operator],
    ['Purpose', bi.purpose || wi.purpose], ['Status', bi.status], ['Shape', bi.shape], ['Type', bi.type],
    ['Spud', wi.spud ? wi.spud.slice(0, 10) : null], ['Kick-off', bi.kickoff ? bi.kickoff.slice(0, 10) : null],
    ['Water depth', wi.waterDepth != null ? `${fmt(L.f(wi.waterDepth), 1)} ${L.label}` : null],
    ['RT elevation', wi.rtElevation != null ? `${fmt(L.f(wi.rtElevation), 1)} ${L.label} above MSL` : null],
    ['Location', wi.lat != null ? `${wi.lat.toFixed(4)}° N, ${wi.lon.toFixed(4)}° E` : null], ['Time zone', wi.timeZone],
    ['Rig', rig ? `${rig.name}${rig.type ? ' (' + rig.type + ')' : ''}${rig.owner ? ' · ' + rig.owner : ''}` : null],
    ['Drilling data', D ? `${fmtDate(D.start)} → ${fmtDate(D.end)} · ${D.rows.toLocaleString()} rows` : 'none'],
    ['Logs', `${logs.filter(l => l.kind === 'time').length} time-indexed · ${logs.filter(l => l.kind === 'depth').length} depth-indexed`],
  ])));
  const schemCard = h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Casing & hole sections')), h('div', { class: 'card-b' }, schematic(geo, L)));
  main.append(h('div', { class: 'grid g2', style: { marginBottom: '12px' } }, meta, schemCard));

  // ------------ BHA runs
  if (bha && bha.runs && bha.runs.length) {
    const tb = h('tbody');
    bha.runs.forEach(r => {
      const tub = bha.tubulars[r.tubular];
      const comps = tub ? tub.components : [];
      const len = comps.reduce((a, c) => a + (c.len || 0), 0);
      const row = h('tr', { class: 'click' },
        h('td', { class: 'l' }, r.run != null ? `#${r.run}` : ''), h('td', { class: 'l' }, r.name || ''),
        h('td', { class: 'l' }, r.start ? fmtDT(r.start) : ''), h('td', { class: 'l' }, r.stop ? fmtDT(r.stop) : ''),
        h('td', {}, comps.length), h('td', {}, len ? fmt(L.f(len), 1) : ''),
        h('td', { class: 'l' }, comps.slice(0, 4).map(c => c.name).join(' · ') + (comps.length > 4 ? ' …' : '')));
      const detail = h('tr', { style: { display: 'none' } }, h('td', { colspan: 7, style: { background: 'var(--surface-2)' } }, compTable(comps, L)));
      row.onclick = () => { detail.style.display = detail.style.display === 'none' ? '' : 'none'; };
      tb.append(row, detail);
    });
    main.append(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { class: 'card-h' }, h('h2', {}, `BHA runs (${bha.runs.length})`), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'click a run for its components')),
      h('div', { class: 'card-b tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ['Run', 'Name', 'Start', 'Stop', 'Components', `Length (${L.label})`, 'Top components'].map((x, i) => h('th', { class: [0, 1, 2, 3, 6].includes(i) ? 'l' : '' }, x)))), tb))));
  }

  // ------------ remarks
  if (msgs.length) {
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search remarks…', 'aria-label': 'Search remarks', style: { width: '240px' } });
    const tb = h('tbody');
    const render = () => {
      tb.innerHTML = '';
      const s = q.value.trim().toLowerCase();
      const list = msgs.filter(m => !s || (m.text || '').toLowerCase().includes(s));
      list.slice(-800).reverse().forEach(m => tb.append(h('tr', { class: 'click', title: 'Open in Drilling view', onclick: () => {
        try { sessionStorage.setItem(`dd.win.${W}.${B}`, JSON.stringify([m.t - 3 * 3600e3, m.t + 3 * 3600e3])); } catch { /* ignore */ }
        window.__go(W, B, 'drilling');
      } }, h('td', { class: 'l num' }, fmtDT(m.t)), h('td', {}, m.md != null ? fmt(L.f(m.md), 0) : ''), h('td', { class: 'l', style: { whiteSpace: 'normal' } }, m.text || ''))));
      cnt.textContent = `${list.length} of ${msgs.length}`;
    };
    const cnt = h('span', { class: 'muted', style: { fontSize: '12px' } });
    q.oninput = render;
    main.append(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { class: 'card-h' }, h('h2', {}, "Driller's remarks"), h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, cnt, q)),
      h('div', { class: 'card-b tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Time'), h('th', {}, `MD (${L.label})`), h('th', { class: 'l' }, 'Remark'))), tb))));
    render();
  }

  // ------------ logs inventory
  const invQ = h('input', { class: 'input', type: 'search', placeholder: 'Find a channel (e.g. GR, ECD, TORQUE)…', 'aria-label': 'Find channel', style: { width: '280px' } });
  const inv = h('div');
  const renderInv = () => {
    inv.innerHTML = '';
    const s = invQ.value.trim().toLowerCase();
    for (const l of [...logs].sort((a, b) => a.kind.localeCompare(b.kind) || b.rows - a.rows)) {
      const chans = l.channels.filter(c => !s || `${c.mnem} ${c.desc || ''}`.toLowerCase().includes(s));
      if (s && !chans.length && !l.name.toLowerCase().includes(s)) continue;
      const range = l.kind === 'time' ? `${fmtDT(l.start)} → ${fmtDT(l.end)}` : `${fmt(L.f(l.start), 0)} → ${fmt(L.f(l.end), 0)} ${L.label}`;
      const tb = h('tbody');
      (s ? chans : l.channels).forEach(c => {
        const cv = chanConv(c.mnem, c.unit, l.gid);
        tb.append(h('tr', {},
          h('td', { class: 'l' }, c.mnem), h('td', { class: 'l', style: { whiteSpace: 'normal' } }, c.desc || ''),
          h('td', { class: 'l' }, cv.label || c.srcUnit || ''), h('td', {}, c.n.toLocaleString()),
          h('td', {}, c.min != null ? fmt(cv.f(c.min)) : ''), h('td', {}, c.max != null ? fmt(cv.f(c.max)) : ''),
          h('td', {}, h('button', { class: 'btn sm', onclick: () => plot(l, c) }, 'Plot'))));
      });
      inv.append(h('details', { class: 'card', style: { marginBottom: '8px' }, open: !!s },
        h('summary', { class: 'card-h', style: { listStyle: 'revert' } },
          h('span', {}, h('b', {}, l.name), ' ', h('span', { class: 'badge' }, l.kind), ' ', h('span', { class: 'muted', style: { fontSize: '12px' } }, `${l.rows.toLocaleString()} rows · ${l.channels.length} channels · ${range}${l.service ? ' · ' + l.service : ''}`))),
        h('div', { class: 'card-b tbl-wrap' }, h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ['Mnemonic', 'Description', 'Unit', 'Samples', 'Min', 'Max', ''].map((x, i) => h('th', { class: i < 3 ? 'l' : '' }, x)))), tb))));
    }
  };
  invQ.oninput = renderInv;
  main.append(h('div', { class: 'page-h', style: { marginTop: '8px' } }, h('div', {}, h('h2', {}, `All logs (${logs.length})`),
    h('p', { style: { fontSize: '12px' } }, 'Every log object in the WITSML export, converted to SI and shown in your unit system. “Plot” adds the channel as a new track.')), invQ), inv);
  renderInv();

  function plot(l, c) {
    if (l.kind === 'time') {
      const base = S.tracks && S.tracks.length ? S.tracks : DEFAULT_TRACKS;
      S.tracks = [...base, { title: c.mnem, ch: [[l.gid, c.mnem]] }];
      save();
      try { sessionStorage.setItem(`dd.win.${W}.${B}`, JSON.stringify([l.end - 6 * 3600e3, l.end])); } catch { /* ignore */ }
      toast(`${c.mnem} added to Drilling tracks`);
      window.__go(W, B, 'drilling');
    } else {
      const base = S.depthTracks && S.depthTracks.length ? S.depthTracks : DEFAULT_DEPTH_TRACKS;
      S.depthTracks = [...base, { title: c.mnem, ch: [[l.gid, c.mnem]] }];
      save();
      toast(`${c.mnem} added to Depth tracks`);
      window.__go(W, B, 'depth');
    }
  }
  return {};
}

function compTable(comps, L) {
  const I = conv('m');
  const inch = m => m == null ? '' : `${(m / 0.0254).toFixed(3).replace(/\.?0+$/, '')}″`;
  return h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, ['#', 'Component', 'Type', 'OD', 'ID', `Length (${L.label})`, 'Vendor'].map((x, i) => h('th', { class: [1, 2, 6].includes(i) ? 'l' : '' }, x)))),
    h('tbody', {}, comps.map(c => h('tr', {}, h('td', {}, c.seq ?? ''), h('td', { class: 'l' }, c.name || ''), h('td', { class: 'l' }, c.type || ''),
      h('td', {}, inch(c.od)), h('td', {}, inch(c.id)), h('td', {}, c.len != null ? fmt(I.f(c.len), 2) : ''), h('td', { class: 'l' }, c.vendor || '')))));
}

function schematic(geo, L) {
  if (!geo || !geo.length) return h('div', { class: 'muted' }, 'No wellbore geometry reported.');
  const rep = geo[geo.length - 1];
  const secs = rep.sections.filter(s => s.mdBottom != null && (s.od || s.id));
  if (!secs.length) return h('div', { class: 'muted' }, 'No sections.');
  const maxMd = Math.max(...secs.map(s => s.mdBottom));
  const maxOd = Math.max(...secs.map(s => s.od || s.id || 0));
  const Wd = 200, Ht = 320, cx = 100, top = 8, scaleY = (Ht - 16) / maxMd, scaleX = 80 / maxOd;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
  svg.setAttribute('width', Wd);
  svg.setAttribute('height', Ht);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Casing and hole section schematic, depth to scale');
  const el = (n, a) => { const e = document.createElementNS(ns, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.append(e); return e; };
  const colors = { casing: 'var(--text-secondary)', liner: 'var(--series-1)', riser: 'var(--text-muted)', 'open hole': 'var(--series-4)', conductor: 'var(--text-muted)' };
  const sorted = [...secs].sort((a, b) => (a.mdTop || 0) - (b.mdTop || 0) || (b.od || b.id) - (a.od || a.id));
  [...secs].sort((a, b) => (b.od || b.id) - (a.od || a.id)).forEach(s => {
    const r = (s.od || s.id) * scaleX;
    const y0 = top + (s.mdTop || 0) * scaleY, y1 = top + s.mdBottom * scaleY;
    const col = colors[s.type] || 'var(--text-secondary)';
    const dash = s.type === 'open hole' ? '4 3' : '';
    el('line', { x1: cx - r, y1: y0, x2: cx - r, y2: y1, stroke: col, 'stroke-width': 2.5, 'stroke-dasharray': dash });
    el('line', { x1: cx + r, y1: y0, x2: cx + r, y2: y1, stroke: col, 'stroke-width': 2.5, 'stroke-dasharray': dash });
    if (s.type !== 'open hole') el('path', { d: `M${cx - r} ${y1} l-6 0 l6 -6 z M${cx + r} ${y1} l6 0 l-6 -6 z`, fill: col });
  });
  const size = s => s.od ? `${(s.od / 0.0254).toFixed(3).replace(/\.?0+$/, '')}″` : `${(s.id / 0.0254).toFixed(2).replace(/\.?0+$/, '')}″`;
  const tbl = h('table', { class: 'tbl' },
    h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Section'), h('th', {}, 'Size'), h('th', {}, `Top (${L.label})`), h('th', {}, `Bottom (${L.label})`))),
    h('tbody', {}, sorted.map(s => h('tr', {},
      h('td', { class: 'l' }, h('span', { class: 'state-chip' }, h('i', { style: { background: colors[s.type] || 'var(--text-secondary)' } }), s.type || '')),
      h('td', {}, size(s)), h('td', {}, fmt(L.f(s.mdTop || 0), 0)), h('td', {}, fmt(L.f(s.mdBottom), 0))))));
  return h('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' } }, svg,
    h('div', { style: { flex: '1', minWidth: '240px' } }, tbl,
      h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '8px' } }, `Report ${rep.t ? new Date(rep.t).toISOString().slice(0, 10) : ''}${geo.length > 1 ? ` (latest of ${geo.length})` : ''} · drawing depth to scale (MD), width by OD`)));
}
