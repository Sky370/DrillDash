// App shell: routing, top bar, side navigation.
import { api } from './api.js';
import { S, save, h, $, setWellTz, wellName } from './core.js';
import { setSystem } from './units.js';
import * as home from './pages/home.js';
import * as drilling from './pages/drilling.js';
import * as depth from './pages/depth.js';
import * as ops from './pages/ops.js';
import * as traj from './pages/traj.js';
import * as info from './pages/info.js';
import { closeLayoutMenu } from './layouts.js';

const PAGES = {
  drilling: { mod: drilling, label: 'Drilling', icon: '<path d="M4 4v16M9 8v12M14 2v18M19 11v9" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>', full: true },
  depth: { mod: depth, label: 'Depth', icon: '<path d="M12 3v15M7 13l5 6 5-6M4 3h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', full: true },
  ops: { mod: ops, label: 'Operations', icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>' },
  traj: { mod: traj, label: 'Trajectory', icon: '<path d="M5 3c0 8 2 12 14 18" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><circle cx="5" cy="3" r="2" fill="currentColor"/>' },
  info: { mod: info, label: 'Well Info', icon: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M12 11v6M12 7.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>' },
};
const HOME_ICON = '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>';

let CAT = null;
let current = null;  // { unmount }
let last = null;     // last opened well ctx

function parseHash() {
  const p = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (p[0] === 'w' && p.length >= 3) return { wid: p[1], wb: p[2], page: PAGES[p[3]] ? p[3] : 'drilling' };
  return { page: 'home' };
}

export function go(wid, wb, page = 'drilling') {
  location.hash = `#/w/${encodeURIComponent(wid)}/${encodeURIComponent(wb)}/${page}`;
}
window.__go = go;

function findCtx(wid, wb) {
  const well = CAT.wells.find(w => w.id === wid);
  const b = well && well.wellbores.find(x => x.wb === wb);
  return well && b ? { cat: CAT, well, wb: b, wid, wbId: wb, name: wellName(well, b) } : null;
}

function renderNav(route) {
  const nav = $('#sidenav');
  nav.innerHTML = '';
  const ctx = route.wid ? { wid: route.wid, wb: route.wb } : last;
  nav.append(h('a', { href: '#/', class: route.page === 'home' ? 'active' : '', html: `<svg viewBox="0 0 24 24" aria-hidden="true">${HOME_ICON}</svg><span>Wells</span>` }));
  for (const [k, p] of Object.entries(PAGES)) {
    const href = ctx ? `#/w/${encodeURIComponent(ctx.wid)}/${encodeURIComponent(ctx.wb)}/${k}` : '#/';
    nav.append(h('a', { href, class: [route.page === k ? 'active' : '', ctx ? '' : 'disabled'].join(' '), html: `<svg viewBox="0 0 24 24" aria-hidden="true">${p.icon}</svg><span>${p.label}</span>` }));
  }
}

function renderCrumbs(route, ctx) {
  const c = $('#crumbs');
  c.innerHTML = '';
  c.append(h('a', { href: '#/' }, 'Volve field'));
  if (!ctx) return;
  c.append(h('span', { class: 'sep' }, '›'));
  const wellSel = h('select', { 'aria-label': 'Well', onchange: e => {
    const w = CAT.wells.find(x => x.id === e.target.value);
    const b = w.wellbores.find(x => x.drilling) || w.wellbores[0];
    go(w.id, b.wb, route.page);
  } });
  const wells = [...CAT.wells].sort((a, b) => (a.info.name || a.id).localeCompare(b.info.name || b.id));
  for (const w of wells) {
    const yrs = w.wellbores.map(b => b.drilling && new Date(b.drilling.start).getUTCFullYear()).filter(Boolean);
    const label = `${w.info.name || w.id}${yrs.length ? ` (${Math.min(...yrs)}${Math.max(...yrs) !== Math.min(...yrs) ? '–' + Math.max(...yrs) : ''})` : ''}`;
    wellSel.append(h('option', { value: w.id, selected: w.id === ctx.wid }, label));
  }
  c.append(wellSel);
  if (ctx.well.wellbores.length > 1) {
    c.append(h('span', { class: 'sep' }, '›'));
    const wbSel = h('select', { 'aria-label': 'Wellbore', onchange: e => go(ctx.wid, e.target.value, route.page) });
    for (const b of ctx.well.wellbores) {
      const d = b.drilling;
      const span = d ? ` · ${new Date(d.start).toISOString().slice(0, 10)} → ${new Date(d.end).toISOString().slice(0, 10)}` : ' · no time data';
      wbSel.append(h('option', { value: b.wb, selected: b.wb === ctx.wbId }, `#${b.wb} ${b.info.name || ''}${span}`));
    }
    c.append(wbSel);
  }
}

async function route() {
  const r = parseHash();
  // menus and popovers belong to the page being left
  closeLayoutMenu();
  document.querySelectorAll('.popover, .curve-tip').forEach(e => e.remove());
  if (current && current.unmount) { try { current.unmount(); } catch (e) { console.error(e); } }
  current = null;
  const main = $('#main');
  main.innerHTML = '';
  main.className = '';
  let ctx = null;
  if (r.wid) {
    ctx = findCtx(r.wid, r.wb);
    if (!ctx) { location.hash = '#/'; return; }
    last = { wid: r.wid, wb: r.wb };
    setWellTz(ctx.well.info.timeZone);
  }
  renderNav(r);
  renderCrumbs(r, ctx);
  document.title = ctx ? `${ctx.name} · ${PAGES[r.page].label} · DrillDash` : 'DrillDash';
  try {
    if (r.page === 'home') current = await home.mount(main, { cat: CAT });
    else {
      if (PAGES[r.page].full) main.className = 'full';
      current = await PAGES[r.page].mod.mount(main, ctx);
    }
  } catch (e) {
    console.error(e);
    main.append(h('div', { class: 'empty' }, `Something went wrong: ${e.message}`));
  }
}

function initControls() {
  const us = $('#unitSel'), tz = $('#tzSel');
  us.value = S.units;
  tz.value = S.tz;
  us.onchange = () => { S.units = us.value; setSystem(S.units); save(); route(); };
  tz.onchange = () => { S.tz = tz.value; save(); route(); };
  $('#themeBtn').onclick = () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = S.theme;
    save();
    route();
  };
  document.documentElement.dataset.theme = S.theme;
}

(async function boot() {
  initControls();
  $('#main').append(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Loading catalog…'));
  CAT = await api.catalog();
  window.addEventListener('hashchange', route);
  route();
})();
