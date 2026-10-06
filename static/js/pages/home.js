// Home: field summary, field map (all trajectories), well cards.
import { api } from '../api.js';
import { h, css, STATES, stateColor, stateHours, fmtDate, fmtDur, plotlyBase, plotlyConfig, wellName, S, save } from '../core.js';
import { conv, fmt } from '../units.js';

function stateBar(hours) {
  const tot = hours.reduce((a, b) => a + b, 0) - hours[0];
  const bar = h('div', { class: 'statebar', role: 'img', 'aria-label': 'Time by rig state' });
  if (!tot) return bar;
  hours.forEach((v, i) => {
    if (i === 0 || v / tot < 0.004) return;
    bar.append(h('span', { style: { width: `${(v / tot) * 100}%`, background: stateColor(i) }, title: `${STATES[i]}: ${fmtDur(v)} (${(v / tot * 100).toFixed(1)}%)` }));
  });
  return bar;
}

export function stateLegend(skip = [0]) {
  return h('div', { class: 'legend' }, STATES.map((s, i) => skip.includes(i) ? null :
    h('span', { class: 'state-chip' }, h('i', { style: { background: stateColor(i) } }), s)));
}

export async function mount(main, { cat }) {
  const dc = conv('m');
  const rows = [];
  for (const w of cat.wells) for (const b of w.wellbores) rows.push({ w, b, d: b.drilling });
  const withData = rows.filter(r => r.d);
  const hrs = Array(9).fill(0);
  withData.forEach(r => stateHours(r.d).forEach((v, i) => { hrs[i] += v; }));
  const totalH = hrs.slice(1).reduce((a, b) => a + b, 0);
  const deepest = Math.max(...withData.map(r => r.d.maxHoleDepth || 0));

  main.append(
    h('div', { class: 'page-h' },
      h('div', {}, h('h1', {}, 'Volve field · drilling data'),
        h('p', {}, `${cat.wells.length} well folders · ${rows.length} wellbores · converted from the WITSML 1.4.1 real-time export`))),
    cat.demo ? h('div', { class: 'card demo-note' },
      h('b', {}, 'Demo dataset'), ' - two sample wellbores bundled with the code. For all 30 wellbores, download the store-*.zip files from the ',
      h('b', {}, 'Releases'), ' page of the DrillDash GitHub repository and unzip them into the DrillDash folder, or run ingest.py on the Volve WITSML data.') : null,
    h('div', { class: 'tiles' },
      tile('Wellbores with time data', `${withData.length}`, `of ${rows.length} wellbores`),
      tile('Recorded rig time', fmt(totalH / 24, 0), 'days', `${fmt(totalH, 0)} h`),
      tile('Drilling (rotary + slide)', fmt((hrs[1] + hrs[2]), 0), 'h', `${(100 * (hrs[1] + hrs[2]) / totalH).toFixed(1)}% of rig time`),
      tile('In slips', fmt(hrs[3], 0), 'h', `${(100 * hrs[3] / totalH).toFixed(1)}% of rig time`),
      tile('Deepest hole', fmt(dc.f(deepest), 0), dc.label, 'measured depth'),
    ),
  );

  // field map + activity
  const mapEl = h('div', { class: 'plot', style: { height: '380px' } });
  const actEl = h('div', { class: 'plot', style: { height: '380px' } });
  let mode3d = false;
  const toggle = h('button', { class: 'btn sm', 'aria-pressed': 'false', onclick: () => { mode3d = !mode3d; toggle.setAttribute('aria-pressed', String(mode3d)); drawMap(); } }, '3D');
  main.append(h('div', { class: 'grid g2', style: { marginBottom: '12px' } },
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Field map · well paths (plan view)'), toggle), h('div', { class: 'card-b' }, mapEl)),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Rig time by activity · all wellbores')), h('div', { class: 'card-b' }, actEl)),
  ));

  // cards
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Search wells…', 'aria-label': 'Search wells', style: { width: '220px' } });
  const onlyData = h('input', { type: 'checkbox', checked: true, id: 'onlyData' });
  const grid = h('div', { class: 'wells' });
  main.append(
    h('div', { class: 'page-h', style: { marginTop: '6px' } },
      h('div', {}, h('h2', {}, 'Wellbores'), h('div', { style: { marginTop: '6px' } }, stateLegend())),
      h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
        h('label', { class: 'sec', style: { fontSize: '13px', display: 'flex', gap: '6px', alignItems: 'center' } }, onlyData, 'Only with time data'), search)),
    grid);

  const renderCards = () => {
    grid.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const list = rows
      .filter(r => !onlyData.checked || r.d)
      .filter(r => !q || `${wellName(r.w, r.b)} ${r.w.folder} ${r.w.info.operator} ${r.b.rig?.name || ''}`.toLowerCase().includes(q))
      .sort((a, b) => wellName(a.w, a.b).localeCompare(wellName(b.w, b.b), undefined, { numeric: true }) || (a.d?.start || 0) - (b.d?.start || 0));
    for (const { w, b, d } of list) {
      const name = wellName(w, b);
      const op = w.info.operator || (w.folder.split('-')[1] !== 'NA' ? w.folder.split('-')[1] : '');
      const tags = [];
      if (b.objects?.messages) tags.push(`${b.objects.messages} remarks`);
      if (b.objects?.bhaRuns) tags.push(`${b.objects.bhaRuns} BHA runs`);
      if (b.objects?.mudlog) tags.push('Mud log');
      if (b.objects?.trajectory) tags.push('Survey');
      tags.push(`${b.nTimeLogs} time · ${b.nDepthLogs} depth logs`);
      const card = h('div', { class: `card well-card ${d ? '' : 'dim'}`, tabindex: '0', role: 'link',
        onclick: () => window.__go(w.id, b.wb, d ? 'drilling' : 'info'),
        onkeydown: e => { if (e.key === 'Enter') window.__go(w.id, b.wb, d ? 'drilling' : 'info'); } },
        h('div', { class: 't' }, h('b', {}, name), h('span', { class: 'muted', style: { fontSize: '12px' } }, `#${b.wb}`)),
        h('div', { class: 'sec', style: { fontSize: '12px', marginTop: '-6px' } },
          [op, b.rig?.name, d ? `${fmtDate(d.start)} → ${fmtDate(d.end)}` : 'No drilling time data'].filter(Boolean).join(' · ')),
        d ? h('div', { class: 'meta' },
          h('div', {}, h('b', {}, `${fmt(dc.f(d.maxHoleDepth || 0), 0)} ${dc.label}`), 'max hole depth'),
          h('div', {}, h('b', {}, fmtDur((d.end - d.start) / 3600e3)), 'data span'),
          h('div', {}, h('b', {}, fmtDur(stateHours(d)[1] + stateHours(d)[2])), 'drilling')) : null,
        d ? stateBar(stateHours(d)) : null,
        h('div', { class: 'tags' }, tags.map(t => h('span', { class: 'badge' }, t))));
      grid.append(card);
    }
    if (!list.length) grid.append(h('div', { class: 'empty' }, 'No wellbores match.'));
  };
  search.oninput = renderCards;
  onlyData.onchange = renderCards;
  renderCards();

  // activity chart (horizontal bars, one series -> one color per state as identity)
  const idx = [1, 2, 3, 4, 5, 6, 7, 8];
  Plotly.newPlot(actEl, [{
    type: 'bar', orientation: 'h', y: idx.map(i => STATES[i]), x: idx.map(i => hrs[i]),
    marker: { color: idx.map(i => stateColor(i)) },
    text: idx.map(i => `${fmtDur(hrs[i])} · ${(100 * hrs[i] / totalH).toFixed(1)}%`), textposition: 'outside', cliponaxis: false,
    textfont: { color: css('--text-secondary'), size: 11 },
    hovertemplate: '%{y}: %{x:.0f} h<extra></extra>',
  }], plotlyBase({
    margin: { l: 120, r: 90, t: 8, b: 40 },
    yaxis: { ...plotlyBase().yaxis, autorange: 'reversed', gridcolor: 'rgba(0,0,0,0)' },
    xaxis: { ...plotlyBase().xaxis, title: { text: 'hours', font: { color: css('--text-secondary') } } },
    bargap: 0.35,
  }), plotlyConfig);

  // field map
  const field = await api.field();
  function drawMap() {
    const L = conv('m');
    const traces = [];
    const blue = css('--series-1'), gray = css('--text-muted');
    let shownA = false, shownB = false;
    for (const tr of field) {
      const has = tr.hasDrilling;
      const common = {
        mode: 'lines', name: has ? 'Has drilling time data' : 'Survey only',
        legendgroup: has ? 'a' : 'b', showlegend: has ? !shownA : !shownB,
        line: { color: has ? blue : gray, width: has ? 2 : 1.5 },
        customdata: tr.md.map(m => [tr.name, L.f(m)]),
        hovertemplate: `<b>%{customdata[0]}</b><br>MD %{customdata[1]:.0f} ${L.label}<extra></extra>`,
        meta: [tr.id, tr.wb],
      };
      if (has) shownA = true; else shownB = true;
      if (mode3d) traces.push({ type: 'scatter3d', x: tr.ew.map(L.f), y: tr.ns.map(L.f), z: tr.tvd.map(L.f), ...common });
      else traces.push({ type: 'scattergl', x: tr.ew.map(L.f), y: tr.ns.map(L.f), ...common });
    }
    const base = plotlyBase({ showlegend: true, legend: { orientation: 'h', x: 0, y: 1.08, font: { color: css('--text-secondary') } }, margin: { l: 56, r: 12, t: 24, b: 44 } });
    if (mode3d) {
      const ax = t => ({ title: t, gridcolor: css('--grid'), zerolinecolor: css('--axis'), color: css('--text-secondary'), backgroundcolor: 'rgba(0,0,0,0)' });
      base.scene = { xaxis: ax(`East (${L.label})`), yaxis: ax(`North (${L.label})`), zaxis: { ...ax(`TVD (${L.label})`), autorange: 'reversed' }, aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: 1.2 } };
      base.margin = { l: 0, r: 0, t: 24, b: 0 };
    } else {
      base.xaxis = { ...base.xaxis, title: { text: `East offset (${L.label})` } };
      base.yaxis = { ...base.yaxis, title: { text: `North offset (${L.label})` }, scaleanchor: 'x', scaleratio: 1 };
    }
    Plotly.react(mapEl, traces, base, plotlyConfig);
    mapEl.removeAllListeners && mapEl.removeAllListeners('plotly_click');
    mapEl.on('plotly_click', ev => {
      const m = ev.points[0]?.data?.meta;
      if (m) window.__go(m[0], m[1], 'traj');
    });
  }
  drawMap();

  return { unmount() { Plotly.purge(mapEl); Plotly.purge(actEl); } };
}

function tile(k, v, unit, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k),
    h('div', { class: 'v' }, v, unit && !sub ? null : unit ? h('small', {}, unit) : null),
    h('div', { class: 's' }, sub || unit || ''));
}
