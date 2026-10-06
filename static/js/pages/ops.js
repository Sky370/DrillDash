// Operations: days vs depth, daily activity breakdown, footage & ROP per day, daily table.
import { api } from '../api.js';
import { S, save, h, css, STATES, stateColor, stateMode, fmtDate, fmtDur, plotlyBase, plotlyConfig, tzDate, timeTicks, compact, debounce } from '../core.js';
import { conv, fmt } from '../units.js';
import { paintStates } from '../charts.js';
import { stateLegend } from './home.js';

export async function mount(main, ctx) {
  const D = ctx.wb.drilling;
  if (!D) {
    main.append(h('div', { class: 'empty' }, 'No time-based drilling data for this wellbore.'));
    return {};
  }
  const W = ctx.wid, B = ctx.wbId;
  const [daily0, conns0] = await Promise.all([api.obj(W, B, 'daily'), api.obj(W, B, 'connections')]);
  const daily = daily0 || [], conns = conns0 || [];
  const dc = conv('m'), rc = conv('m/s');
  const mode = stateMode(D);
  const HK = mode === 'rig' ? 'hoursRig' : 'hours', RK = mode === 'rig' ? 'ropRig' : 'rop';
  const hrs = mode === 'rig' ? D.stateHoursRig : D.stateHours;
  const stateSel = h('select', { class: 'select', 'aria-label': 'Rig state source',
    title: D.rigCode ? 'Rig code = Baker Hughes RigActivityCode recorded on the rig; computed = DrillDash rules' : 'No rig activity code in this wellbore',
    onchange: e => { S.stateSrc = e.target.value; save(); window.dispatchEvent(new HashChangeEvent('hashchange')); } },
    h('option', { value: 'rig', selected: mode === 'rig', disabled: !D.rigCode }, 'States: rig code'),
    h('option', { value: 'calc', selected: mode === 'calc' }, 'States: computed'));
  const tot = hrs.slice(1).reduce((a, b) => a + b, 0);
  const drillH = hrs[1] + hrs[2];
  const footage = daily.reduce((a, d) => a + (d.footage || 0), 0);
  const tripH = hrs[4] + hrs[5];

  main.append(
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, `${ctx.name} · operations`),
      h('p', {}, `${fmtDate(D.start)} → ${fmtDate(D.end)} · ${mode === 'rig'
        ? 'rig states from the Baker Hughes rig activity code (no slide/rotate split - all drilling is reported as rotating)'
        : 'rig states computed by DrillDash from surface sensors (hookload, bit/hole depth, RPM, flow, WOB)'}`)), stateSel),
    h('div', { class: 'tiles' },
      tile('Data span', fmt((D.end - D.start) / 86400e3, 1), 'days', `${fmt(tot, 0)} h with data`),
      tile('Hole drilled', fmt(dc.f(footage), 0), dc.label, `to ${fmt(dc.f(D.maxHoleDepth || 0), 0)} ${dc.label} MD`),
      tile('Drilling time', fmt(drillH, 0), 'h', `${(100 * drillH / tot).toFixed(1)}% of rig time`),
      tile('On-bottom ROP', drillH > 0.2 ? fmt(rc.f(footage / (drillH * 3600)), 1) : '–', rc.label, 'footage / drilling hours'),
      tile('Sliding', drillH > 0 ? (100 * hrs[2] / drillH).toFixed(1) : '–', '%', 'of drilling time'),
      tile('Tripping', fmt(tripH, 0), 'h', `in slips ${fmt(hrs[3], 0)} h`)),
  );

  // days vs depth
  const dvd = h('div');
  main.append(h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { class: 'card-h' }, h('h2', {}, 'Days vs depth'),
      h('div', { class: 'legend' },
        h('span', { class: 'state-chip' }, h('i', { style: { background: css('--series-1'), height: '3px' } }), 'Hole depth'),
        h('span', { class: 'state-chip' }, h('i', { style: { background: css('--series-2'), height: '3px' } }), 'Bit depth'),
        h('span', { class: 'muted' }, '· ribbon = rig state'))),
    h('div', { class: 'card-b' }, dvd)));

  const actEl = h('div', { class: 'plot', style: { height: '320px' } });
  const pieEl = h('div', { class: 'plot', style: { height: '320px' } });
  main.append(h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', marginBottom: '12px' } },
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Daily rig activity (hours)')), h('div', { class: 'card-b' }, stateLegend(), actEl)),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Time by rig state')), h('div', { class: 'card-b' }, pieEl))));

  const footEl = h('div', { class: 'plot', style: { height: '260px' } });
  const ropEl = h('div', { class: 'plot', style: { height: '260px' } });
  main.append(h('div', { class: 'grid g2', style: { marginBottom: '12px' } },
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, `Footage per day (${dc.label})`)), h('div', { class: 'card-b' }, footEl)),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, `On-bottom ROP per day (${rc.label})`)), h('div', { class: 'card-b' }, ropEl))));

  // computed vs rig-reported states
  if (D.agreement) {
    const A = D.agreement, idx = [1, 2, 3, 4, 5, 6, 7, 8];
    const total = idx.reduce((a, i) => a + idx.reduce((b, j) => b + A[i][j], 0), 0);
    const diag = idx.reduce((a, i) => a + A[i][i], 0);
    const rowSum = i => idx.reduce((b, j) => b + A[i][j], 0);
    const tblA = h('table', { class: 'tbl agree' },
      h('thead', {}, h('tr', {}, h('th', { class: 'l' }, 'Computed ↓ · Rig code →'), idx.map(j => h('th', {}, h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(j) } }), STATES[j]))), h('th', {}, 'Total h'), h('th', {}, 'Match'))),
      h('tbody', {}, idx.map(i => h('tr', {},
        h('td', { class: 'l' }, h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(i) } }), STATES[i])),
        idx.map(j => {
          const v = A[i][j], share = rowSum(i) ? v / rowSum(i) : 0;
          return h('td', { class: i === j ? 'diag' : '', style: v ? { background: `color-mix(in srgb, var(--accent) ${Math.round(share * 55)}%, transparent)` } : null,
            title: `${STATES[i]} (computed) vs ${STATES[j]} (rig code): ${v.toFixed(1)} h, ${(share * 100).toFixed(0)}% of the row` }, v >= 0.05 ? v.toFixed(1) : '');
        }),
        h('td', {}, rowSum(i).toFixed(0)),
        h('td', {}, rowSum(i) ? `${(100 * A[i][i] / rowSum(i)).toFixed(0)}%` : '')))));
    main.append(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { class: 'card-h' }, h('h2', {}, 'Computed vs rig-reported states'),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, `same state for ${(100 * diag / total).toFixed(0)}% of ${fmt(total, 0)} h · hours, shading = share of the row`)),
      h('div', { class: 'card-b tbl-wrap' }, tblA)));
  }

  // connections (weight-to-weight)
  const connEl = h('div', { class: 'plot', style: { height: '300px' } });
  if (conns.length) {
    const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; };
    const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(b.length * p))]; };
    const w2w = conns.map(c => c.w2w);
    main.append(h('div', { class: 'card', style: { marginBottom: '12px' } },
      h('div', { class: 'card-h' }, h('h2', {}, 'Connections · weight to weight'),
        h('span', { class: 'muted', style: { fontSize: '12px' } }, 'in-slips periods between on-bottom drilling · click a bar to open it')),
      h('div', { class: 'card-b' },
        h('div', { class: 'tiles' },
          tile('Connections', String(conns.length), '', `${fmt(dc.f(conns[0].md), 0)} → ${fmt(dc.f(conns[conns.length - 1].md), 0)} ${dc.label}`),
          tile('Weight to weight', fmt(med(w2w) / 60, 1), 'min', `median · best quartile ${fmt(q(w2w, 0.25) / 60, 1)} min`),
          tile('Slip to slip', fmt(med(conns.map(c => c.s2s)) / 60, 1), 'min', 'median time in slips'),
          tile('Pre-slips', fmt(med(conns.map(c => c.pre)) / 60, 1), 'min', 'off bottom → slips (ream, pick up)'),
          tile('Post-slips', fmt(med(conns.map(c => c.post)) / 60, 1), 'min', 'out of slips → back drilling'),
          tile('Total connection time', fmt(w2w.reduce((a, b) => a + b, 0) / 3600, 1), 'h', '')),
        connEl)));
  }

  // table
  const tbl = h('table', { class: 'tbl' });
  tbl.append(h('thead', {}, h('tr', {}, ['Day (UTC)', `Max depth (${dc.label})`, `Footage (${dc.label})`, 'Rotary h', 'Slide h', 'In slips h', 'Tripping h', 'Circ. h', 'Static h', `ROP (${rc.label})`].map((t, i) => h('th', { class: i ? '' : 'l' }, t)))));
  const tb = h('tbody');
  [...daily].reverse().forEach(d => {
    tb.append(h('tr', { class: 'click', title: 'Open this day in the Drilling view', onclick: () => {
      try { sessionStorage.setItem(`dd.win.${W}.${B}`, JSON.stringify([d.day, d.day + 86400e3])); } catch { /* ignore */ }
      window.__go(W, B, 'drilling');
    } },
      h('td', { class: 'l' }, fmtDateUTC(d.day)),
      h('td', {}, d.maxDepth != null ? fmt(dc.f(d.maxDepth), 0) : '–'),
      h('td', {}, fmt(dc.f(d.footage || 0), 0)),
      ...[1, 2, 3].map(i => h('td', {}, d[HK][i] ? d[HK][i].toFixed(1) : '')),
      h('td', {}, (d[HK][4] + d[HK][5]) ? (d[HK][4] + d[HK][5]).toFixed(1) : ''),
      h('td', {}, d[HK][7] ? d[HK][7].toFixed(1) : ''),
      h('td', {}, d[HK][8] ? d[HK][8].toFixed(1) : ''),
      h('td', {}, d.rop != null ? fmt(rc.f(d.rop / 3600), 1) : '')));
  });
  tbl.append(tb);
  main.append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Daily report'), h('span', { class: 'muted', style: { fontSize: '12px' } }, 'click a row to open that day')), h('div', { class: 'card-b tbl-wrap' }, tbl)));

  // ---- charts
  const days = daily.map(d => new Date(d.day).toISOString().slice(0, 10));
  const base = plotlyBase({ barmode: 'stack', bargap: 0.2, margin: { l: 44, r: 10, t: 8, b: 40 } });
  const surface = css('--surface-1');
  Plotly.newPlot(actEl, [1, 2, 3, 4, 5, 6, 7, 8].map(i => ({
    type: 'bar', name: STATES[i], x: days, y: daily.map(d => d[HK][i]), marker: { color: stateColor(i), line: { color: surface, width: 0.5 } },
    hovertemplate: `%{x}<br>${STATES[i]}: %{y:.1f} h<extra></extra>`,
  })), { ...base, yaxis: { ...base.yaxis, range: [0, 24.5], dtick: 6 } }, plotlyConfig);

  const idx = [1, 2, 3, 4, 5, 6, 7, 8];
  Plotly.newPlot(pieEl, [{
    type: 'bar', orientation: 'h', y: idx.map(i => STATES[i]), x: idx.map(i => hrs[i]), marker: { color: idx.map(stateColor) },
    text: idx.map(i => `${(100 * hrs[i] / tot).toFixed(1)}%`), textposition: 'outside', cliponaxis: false, textfont: { color: css('--text-secondary'), size: 11 },
    hovertemplate: '%{y}: %{x:.1f} h<extra></extra>',
  }], plotlyBase({ margin: { l: 112, r: 48, t: 8, b: 36 }, bargap: 0.3, yaxis: { ...plotlyBase().yaxis, autorange: 'reversed' } }), plotlyConfig);

  const blue = css('--series-1');
  Plotly.newPlot(footEl, [{ type: 'bar', x: days, y: daily.map(d => dc.f(d.footage || 0)), marker: { color: blue }, hovertemplate: `%{x}: %{y:.0f} ${dc.label}<extra></extra>` }],
    plotlyBase({ bargap: 0.25, margin: { l: 50, r: 10, t: 8, b: 40 } }), plotlyConfig);
  Plotly.newPlot(ropEl, [{ type: 'bar', x: days, y: daily.map(d => d[RK] != null ? rc.f(d[RK] / 3600) : null), marker: { color: blue }, hovertemplate: `%{x}: %{y:.1f} ${rc.label}<extra></extra>` }],
    plotlyBase({ bargap: 0.25, margin: { l: 50, r: 10, t: 8, b: 40 } }), plotlyConfig);

  if (conns.length) {
    const idx2 = conns.map((c, i) => i + 1);
    const cd = conns.map(c => [fmt(dc.f(c.md), 0), new Date(c.t).toISOString().slice(0, 16).replace('T', ' '), (c.w2w / 60).toFixed(1)]);
    const parts = [['pre', 'Off bottom → slips', 5], ['s2s', 'In slips', 3], ['post', 'Slips → on bottom', 4]];
    const cb = plotlyBase({ barmode: 'stack', bargap: 0.15, showlegend: true, margin: { l: 44, r: 10, t: 28, b: 40 },
      legend: { orientation: 'h', x: 0, y: 1.14, traceorder: 'normal', font: { color: css('--text-secondary') } } });
    Plotly.newPlot(connEl, parts.map(([k, name, si]) => ({
      type: 'bar', name, x: idx2, y: conns.map(c => c[k] / 60), customdata: cd,
      marker: { color: stateColor(si), line: { color: css('--surface-1'), width: conns.length > 150 ? 0 : 0.5 } },
      hovertemplate: `#%{x} · %{customdata[0]} ${dc.label} · %{customdata[1]} UTC<br>${name}: %{y:.1f} min<br>weight to weight %{customdata[2]} min<extra></extra>`,
    })), { ...cb, xaxis: { ...cb.xaxis, title: { text: 'Connection # (in drilling order)' } }, yaxis: { ...cb.yaxis, title: { text: 'minutes' } } }, plotlyConfig);
    connEl.on('plotly_click', ev => {
      const c = conns[ev.points[0].x - 1];
      if (!c) return;
      try { sessionStorage.setItem(`dd.win.${W}.${B}`, JSON.stringify([c.t - 40 * 60e3, c.t + 40 * 60e3])); } catch { /* ignore */ }
      window.__go(W, B, 'drilling');
    });
  }

  // days vs depth (uPlot, depth down)
  const r = await api.series(W, B, 'drilling', ['hole_depth', 'bit_depth'], D.start, D.end, 2000, mode);
  const tip = h('div', { class: 'muted num', style: { fontSize: '12px', marginTop: '4px', minHeight: '18px' } });
  dvd.after(tip);
  const ax = { stroke: css('--text-muted'), grid: { stroke: css('--grid'), width: 1 }, ticks: { stroke: css('--axis'), width: 1, size: 4 }, font: '11px system-ui, sans-serif' };
  const u = new uPlot({
    width: dvd.clientWidth, height: 340, ms: 1, tzDate,
    legend: { show: false }, padding: [8, 12, 0, 4],
    scales: { x: { time: true }, y: { dir: -1, range: (u, mn, mx) => [0, (mx ?? 1) * 1.05] } },
    axes: [{ ...ax, space: 90, size: 30, values: (u, s) => timeTicks(u, s).map(x => x.replace('\n', ' ')) },
      { ...ax, size: 56, values: (u, v) => v.map(compact), label: `MD (${dc.label})`, labelSize: 16, labelFont: '11px system-ui, sans-serif' }],
    series: [{}, { label: 'Hole depth', stroke: blue, width: 2 }, { label: 'Bit depth', stroke: css('--series-2'), width: 1 }],
    cursor: { y: false, points: { size: 8 } },
    hooks: {
      draw: [u => paintStates(u, r.states, { vertical: false, inset: 10 })],
      setCursor: [uu => {
        const i = uu.cursor.idx;
        tip.textContent = i == null ? '' : `${fmtDateUTC(uu.data[0][i])} ${new Date(uu.data[0][i]).toISOString().slice(11, 16)} UTC · hole ${fmt(uu.data[1][i], 0)} ${dc.label} · bit ${fmt(uu.data[2][i], 0)} ${dc.label}`;
      }],
    },
  }, [r.x, r.series.hole_depth.avg.map(v => v == null ? null : dc.f(v)), r.series.bit_depth.avg.map(v => v == null ? null : dc.f(v))], dvd);
  const ro = new ResizeObserver(debounce(() => u.setSize({ width: dvd.clientWidth, height: 340 }), 80));
  ro.observe(dvd);

  return { unmount() { ro.disconnect(); u.destroy(); [actEl, pieEl, footEl, ropEl, connEl].forEach(e => Plotly.purge(e)); } };
}

const fmtDateUTC = ms => new Date(ms).toISOString().slice(0, 10);

function tile(k, v, unit, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, h('small', {}, unit)), h('div', { class: 's' }, sub || ''));
}
