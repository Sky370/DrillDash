// Trajectory: 3D well path with field context, plan & section views, inclination/DLS, survey table.
import { api } from '../api.js';
import { h, css, fmtDT, plotlyBase, plotlyConfig, withAlpha } from '../core.js';
import { conv, fmt } from '../units.js';

export async function mount(main, ctx) {
  const W = ctx.wid, B = ctx.wbId;
  const [trajs, field] = await Promise.all([api.obj(W, B, 'trajectory'), api.field()]);
  if (!trajs || !trajs.length) {
    main.append(h('div', { class: 'empty' }, 'No survey / trajectory data for this wellbore.'));
    return {};
  }
  const L = conv('m'), A = conv('rad'), DL = conv('rad/m');
  let sel = trajs.indexOf(trajs.reduce((a, b) => (b.stations[b.stations.length - 1].md > a.stations[a.stations.length - 1].md ? b : a)));
  let showField = true;

  const pick = h('select', { class: 'select', 'aria-label': 'Survey', onchange: e => { sel = +e.target.value; draw(); } },
    trajs.map((t, i) => h('option', { value: i, selected: i === sel }, `${t.name || 'Survey ' + (i + 1)} · ${t.stations.length} stations · to ${fmt(L.f(t.stations[t.stations.length - 1].md), 0)} ${L.label}`)));
  const fieldBtn = h('button', { class: 'btn sm', 'aria-pressed': 'true', onclick: () => { showField = !showField; fieldBtn.setAttribute('aria-pressed', String(showField)); draw(); } }, 'Other Volve wells');
  const tilesEl = h('div', { class: 'tiles' });
  const el3d = h('div', { class: 'plot', style: { height: '520px' } });
  const elPlan = h('div', { class: 'plot', style: { height: '250px' } });
  const elSec = h('div', { class: 'plot', style: { height: '250px' } });
  const elInc = h('div', { class: 'plot', style: { height: '220px' } });
  const elDls = h('div', { class: 'plot', style: { height: '220px' } });
  const tblWrap = h('div', { class: 'card-b tbl-wrap' });

  main.append(
    h('div', { class: 'page-h' }, h('div', {}, h('h1', {}, `${ctx.name} · trajectory`), h('p', {}, 'Directional surveys from the WITSML trajectory objects')),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, pick)),
    tilesEl,
    h('div', { class: 'split', style: { marginBottom: '12px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, '3D well path'), fieldBtn), h('div', { class: 'card-b' }, el3d)),
      h('div', { style: { display: 'grid', gap: '12px' } },
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Plan view')), h('div', { class: 'card-b' }, elPlan)),
        h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Vertical section')), h('div', { class: 'card-b' }, elSec)))),
    h('div', { class: 'grid g2', style: { marginBottom: '12px' } },
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, `Inclination & azimuth (${A.label})`)), h('div', { class: 'card-b' }, elInc)),
      h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, `Dogleg severity (${DL.label})`)), h('div', { class: 'card-b' }, elDls))),
    h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', {}, 'Survey stations')), tblWrap));

  function draw() {
    const t = trajs[sel];
    const st = t.stations.filter(s => s.tvd != null && s.ns != null && s.ew != null);
    const last = st[st.length - 1];
    const maxInc = Math.max(...st.map(s => s.incl || 0));
    const maxDls = Math.max(...st.map(s => s.dls || 0));
    const hd = Math.hypot(last.ns, last.ew);
    tilesEl.innerHTML = '';
    tilesEl.append(
      tile('Measured depth', fmt(L.f(last.md), 0), L.label, `${st.length} stations`),
      tile('True vertical depth', fmt(L.f(last.tvd), 0), L.label, ''),
      tile('Horizontal displacement', fmt(L.f(hd), 0), L.label, `N ${fmt(L.f(last.ns), 0)} · E ${fmt(L.f(last.ew), 0)}`),
      tile('Max inclination', fmt(A.f(maxInc), 1), A.label, ''),
      tile('Max dogleg', fmt(DL.f(maxDls), 2), DL.label, ''),
      tile('Survey period', t.start ? t.start.slice(0, 10) : '–', '', t.end ? `to ${t.end.slice(0, 10)}` : ''));

    const blue = css('--series-1'), muted = withAlpha(css('--text-muted'), 0.55);
    const hover = st.map(s => `MD ${fmt(L.f(s.md), 0)} ${L.label}<br>TVD ${fmt(L.f(s.tvd), 0)}<br>Inc ${fmt(A.f(s.incl || 0), 1)}° · Az ${fmt(A.f(s.azi || 0), 1)}°`);
    const traces = [];
    if (showField) {
      for (const f of field) {
        if (f.id === W && f.wb === B) continue;
        traces.push({ type: 'scatter3d', mode: 'lines', x: f.ew.map(L.f), y: f.ns.map(L.f), z: f.tvd.map(L.f), line: { color: muted, width: 2 },
          name: f.name, hovertemplate: `${f.name}<extra></extra>`, showlegend: false });
      }
    }
    traces.push({ type: 'scatter3d', mode: 'lines', x: st.map(s => L.f(s.ew)), y: st.map(s => L.f(s.ns)), z: st.map(s => L.f(s.tvd)),
      line: { color: blue, width: 7 }, name: ctx.name, text: hover, hovertemplate: '%{text}<extra></extra>', showlegend: false });
    traces.push({ type: 'scatter3d', mode: 'markers', x: [L.f(last.ew)], y: [L.f(last.ns)], z: [L.f(last.tvd)], marker: { size: 5, color: blue, line: { color: css('--surface-1'), width: 2 } }, hoverinfo: 'skip', showlegend: false });
    const axis = title => ({ title, gridcolor: css('--grid'), zerolinecolor: css('--axis'), color: css('--text-secondary'), backgroundcolor: 'rgba(0,0,0,0)', showbackground: false });
    Plotly.react(el3d, traces, plotlyBase({
      margin: { l: 0, r: 0, t: 0, b: 0 },
      scene: { xaxis: axis(`East (${L.label})`), yaxis: axis(`North (${L.label})`), zaxis: { ...axis(`TVD (${L.label})`), autorange: 'reversed' },
        aspectmode: 'manual', aspectratio: { x: 1, y: 1, z: 1.1 }, camera: { eye: { x: 1.5, y: -1.5, z: 0.6 } } },
    }), plotlyConfig);

    // plan view
    const planTraces = [];
    if (showField) for (const f of field) if (!(f.id === W && f.wb === B)) planTraces.push({ type: 'scatter', mode: 'lines', x: f.ew.map(L.f), y: f.ns.map(L.f), line: { color: muted, width: 1 }, hoverinfo: 'skip' });
    planTraces.push({ type: 'scatter', mode: 'lines', x: st.map(s => L.f(s.ew)), y: st.map(s => L.f(s.ns)), line: { color: blue, width: 2.5 }, text: hover, hovertemplate: '%{text}<extra></extra>' });
    const pb = plotlyBase({ margin: { l: 52, r: 10, t: 6, b: 36 } });
    Plotly.react(elPlan, planTraces, { ...pb, xaxis: { ...pb.xaxis, title: { text: `East (${L.label})` } }, yaxis: { ...pb.yaxis, title: { text: `North (${L.label})` }, scaleanchor: 'x' } }, plotlyConfig);

    // vertical section along the azimuth to TD
    const az = Math.atan2(last.ew, last.ns);
    const vs = st.map(s => s.ns * Math.cos(az) + s.ew * Math.sin(az));
    Plotly.react(elSec, [{ type: 'scatter', mode: 'lines', x: vs.map(L.f), y: st.map(s => L.f(s.tvd)), line: { color: blue, width: 2.5 }, text: hover, hovertemplate: '%{text}<extra></extra>' }],
      { ...pb, xaxis: { ...pb.xaxis, title: { text: `Section @ ${fmt((az * 180 / Math.PI + 360) % 360, 0)}° (${L.label})` } }, yaxis: { ...pb.yaxis, title: { text: `TVD (${L.label})` }, autorange: 'reversed' } }, plotlyConfig);

    // inclination + azimuth (same unit -> one axis) and DLS
    const md = st.map(s => L.f(s.md));
    const ib = plotlyBase({ margin: { l: 44, r: 10, t: 6, b: 36 }, showlegend: true, legend: { orientation: 'h', x: 0, y: 1.15, font: { color: css('--text-secondary') } } });
    Plotly.react(elInc, [
      { type: 'scatter', mode: 'lines', name: 'Inclination', x: md, y: st.map(s => A.f(s.incl || 0)), line: { color: blue, width: 2 } },
      { type: 'scatter', mode: 'lines', name: 'Azimuth', x: md, y: st.map(s => A.f(s.azi || 0)), line: { color: css('--series-2'), width: 2 } },
    ], { ...ib, xaxis: { ...ib.xaxis, title: { text: `MD (${L.label})` } }, yaxis: { ...ib.yaxis, range: [0, 360] } }, plotlyConfig);
    const db = plotlyBase({ margin: { l: 44, r: 10, t: 6, b: 36 } });
    Plotly.react(elDls, [{ type: 'bar', x: md, y: st.map(s => DL.f(s.dls || 0)), marker: { color: blue }, hovertemplate: `MD %{x:.0f}: %{y:.2f} ${DL.label}<extra></extra>` }],
      { ...db, bargap: 0, xaxis: { ...db.xaxis, title: { text: `MD (${L.label})` } } }, plotlyConfig);

    // table
    const tbl = h('table', { class: 'tbl' });
    tbl.append(h('thead', {}, h('tr', {}, [`MD (${L.label})`, 'Inc (°)', 'Azi (°)', `TVD (${L.label})`, `N/S (${L.label})`, `E/W (${L.label})`, `DLS (${DL.label})`, 'Time', 'Type'].map((x, i) => h('th', { class: i === 8 ? 'l' : '' }, x)))));
    const tb = h('tbody');
    st.forEach(s => tb.append(h('tr', {},
      h('td', {}, fmt(L.f(s.md), 1)), h('td', {}, fmt(A.f(s.incl || 0), 2)), h('td', {}, fmt(A.f(s.azi || 0), 2)),
      h('td', {}, fmt(L.f(s.tvd), 1)), h('td', {}, fmt(L.f(s.ns), 1)), h('td', {}, fmt(L.f(s.ew), 1)),
      h('td', {}, s.dls != null ? fmt(DL.f(s.dls), 2) : ''), h('td', {}, s.t ? fmtDT(s.t) : ''), h('td', { class: 'l' }, s.type || ''))));
    tbl.append(tb);
    tblWrap.innerHTML = '';
    tblWrap.append(tbl);
  }
  draw();
  return { unmount() { [el3d, elPlan, elSec, elInc, elDls].forEach(e => Plotly.purge(e)); } };
}

function tile(k, v, unit, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v, unit ? h('small', {}, unit) : null), h('div', { class: 's' }, sub || ''));
}
