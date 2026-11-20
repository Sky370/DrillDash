// Suggested track layouts per use case, resolved against the logs each wellbore actually has.
import { S, save, h, toast } from './core.js';

// A curve is either a standard channel (string) or {find:[mnemonics in priority order]} searched in every log.
// A track keeps only the curves this wellbore has; tracks left empty are dropped.
const T = (title, ...ch) => ({ title, ch });
const F = (...m) => ({ find: m });
// curve flags: Sep = own (independent) scale, Off = in the track but switched off
const flag = (c, k) => (typeof c === 'string' ? { std: c, [k]: true } : { ...c, [k]: true });
const Sep = c => flag(c, 'sep');
const Off = c => flag(c, 'off');

// downhole / specialist channel candidates (Baker Hughes, SLB, Geoservices names seen in the Volve export)
const DH_WOB = F('WOBCX', 'WOBAX', 'DWOB', 'DCWAB');
const DH_TQ = F('TORCX', 'TORAX', 'DTOR_RT', 'DCTAB');
const DH_RPM = F('CRPM_RT', 'DRPM', 'D1RPMX');
const ECD = F('ACTECDX', 'ECD_ARC_RT', 'ECDBIT', 'ECD_ECO_RT', 'ACTECDM', 'PWEA');
const ANN_P = F('APRESX', 'APRS_RT', 'DHAP_DH_ECO_RT', 'APRESM', 'PWPA');
const ANN_T = F('TCDX', 'ATMP_RT', 'DHAT_DH_ECO_RT', 'PWTA');
const GAMMA = F('GRCX', 'ARC_GR_RT', 'GRM1', 'GRMA_ECO_RT', 'GRAX');
const INC = F('INCL_CONT_RT', 'CRS_CNINC', 'PDINCL', 'ACTINNX', 'INNX', 'INNM', 'INC');
const AZI = F('AZIM_CONT_RT', 'CRS_CNAZI', 'AZRB', 'AZRX');
const SHOCK = F('SHKPK_RT', 'SEVXYDX', 'D1PY');
const SHOCK2 = F('D1PX');  // Sperry DDSr: second lateral axis
const AXIAL = F('SEVZDX', 'SHKRSK_RT', 'D1PZ');
const STICK = F('STICK_RT', 'SSLIPDX', 'D1SSM');
const RES_DEEP = F('P40H_RT', 'RACLX', 'RACELX', 'RAALX');
const RES_SHALLOW = F('P28H_RT', 'RPCHX', 'RPCEHX', 'RPAHX');
const DENS = F('BDCX', 'ROBB_DH_ECO_RT');
const NEUT = F('NPLX', 'NPKLX', 'NPCLX', 'NPSX');

// opened on a first visit and used by "Reset to default" in the track editor
export const DEFAULT_TIME_LAYOUT = 'standard';

export const TIME_LAYOUTS = [
  { id: 'standard', name: 'Standard (default)', desc: 'Depth, hookload & block, surface vs downhole WOB, ROP & MSE, RPM, torque, flow & SPP, pressure losses, ECD vs pore/frac.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Hookload', 'hookload', Sep('block_pos')), T('WOB', 'wob', DH_WOB), T('ROP', 'rop', 'mse'),
      T('RPM', 'bit_rpm', F('SURF_RPM', 'RPM', 'GS_RPM')), T('Torque', 'torque', DH_TQ), T('FLOW', 'spp', 'flow_in', 'flow_out'),
      T('PRESS', Off(F('DSTRINGLOSS')), Off(F('ANNLOSS')), Off(F('BITLOSS')), ANN_P, F('DINPAX')),
      T('ECD', F('ECDBIT', 'ACTECDX', 'ECD_ARC_RT', 'ECD_ECO_RT', 'ACTECDM', 'PWEA'), F('POR_EQMD'), F('FRAC_EQMD'))] },
  { id: 'overview', name: 'Overview', desc: 'General real-time view: depth, hookload, WOB, RPM, torque, SPP, flow, ROP.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Hookload', 'hookload'), T('WOB', 'wob'), T('RPM', 'rpm'), T('Torque', 'torque'),
      T('SPP', 'spp'), T('Flow', 'flow_in', 'flow_out'), T('ROP', 'rop')] },
  { id: 'drilling', name: 'Drilling performance', desc: 'ROP optimisation: surface vs downhole WOB, RPM and torque, MSE, SPP.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('ROP', 'rop'), T('WOB', 'wob', DH_WOB), T('RPM', 'rpm', 'bit_rpm', DH_RPM),
      T('Torque', 'torque', DH_TQ), T('MSE', 'mse'), T('SPP', 'spp'), T('Hookload', 'hookload')] },
  { id: 'hydraulics', name: 'Hydraulics & hole cleaning', desc: 'Flow in/out, pump pressure, strokes, ECD vs mud weight, annular pressure, pits, temperatures.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Flow', 'flow_in', 'flow_out'), T('SPP', 'spp'), T('Strokes', 'spm'),
      T('Mud wt & ECD', 'mw_in', 'mw_out', 'ecd', ECD), T('Annular press.', ANN_P), T('Pits', 'pit_vol', 'gain_loss'),
      T('Temperature', 'temp_in', 'temp_out', ANN_T)] },
  { id: 'tripping', name: 'Tripping', desc: 'Block movement, hookload (drag), trip-tank volumes vs expected fill, flow and pressure.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Block', 'block_pos'), T('Hookload', 'hookload'),
      T('Trip tanks', F('TTV1', 'PIT_TRIPIN'), F('TTV2', 'PIT_TRIPOUT'), F('TRIPPVT'), F('TRIPEXPFILL')),
      T('Flow', 'flow_in'), T('SPP', 'spp'), T('RPM', 'rpm')] },
  { id: 'wellcontrol', name: 'Well control / kick detection', desc: 'Flow out vs in, pit gain, choke & casing pressure, gas, mud weight, drilling breaks.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Flow', 'flow_in', 'flow_out', 'flow_out_pct'), T('Pit gain', 'gain_loss', 'pit_vol'),
      T('SPP', 'spp'), T('Choke / casing', 'choke_p', F('CASPR', 'KILL_PRESS')), T('Gas', 'gas'), T('Mud weight', 'mw_in', 'mw_out'), T('ROP', 'rop')] },
  { id: 'dynamics', name: 'Drillstring dynamics', desc: 'Vibration: shocks, stick-slip, axial vibration with surface and downhole RPM, torque, WOB.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('RPM', 'rpm', DH_RPM, 'bit_rpm'), T('Stick-slip', STICK), T('Torque', 'torque', DH_TQ),
      T('Shock / lateral', SHOCK, SHOCK2), T('Axial', AXIAL), T('WOB', 'wob', DH_WOB), T('ROP', 'rop')] },
  { id: 'directional', name: 'Directional / steering', desc: 'Continuous inclination & azimuth, gamma, and the parameters that drive slide vs rotate.',
    tracks: [T('Depth', 'hole_depth', 'bit_depth'), T('Inclination', INC), T('Azimuth', AZI), T('Gamma', GAMMA), T('ROP', 'rop'),
      T('WOB', 'wob'), T('RPM', 'rpm'), T('Torque', 'torque')] },
];

export const DEPTH_LAYOUTS = [
  { id: 'performance', name: 'Drilling performance', desc: 'ROP, WOB, RPM, torque, SPP, flow, MSE and slide fraction by depth.',
    tracks: [T('ROP', 'rop'), T('WOB', 'wob'), T('RPM', 'rpm'), T('Torque', 'torque'), T('SPP', 'spp'), T('Flow In', 'flow_in'), T('MSE', 'mse'), T('Slide', 'slide_frac')] },
  { id: 'formation', name: 'Formation evaluation (LWD)', desc: 'Gamma, deep/shallow resistivity, density, neutron, with ROP for drilling-break correlation.',
    tracks: [T('Gamma', GAMMA), T('Resistivity', RES_DEEP, RES_SHALLOW), T('Density', DENS), T('Neutron', NEUT), T('ROP', 'rop'), T('ECD', ECD)] },
  { id: 'hydraulics', name: 'Hydraulics', desc: 'Flow, SPP, mud weight vs ECD, annular pressure and temperature by depth.',
    tracks: [T('Flow In', 'flow_in'), T('SPP', 'spp'), T('Mud wt & ECD', 'mw_in', ECD), T('Annular press.', ANN_P), T('Annular temp.', ANN_T), T('ROP', 'rop')] },
  { id: 'dynamics', name: 'Drillstring dynamics', desc: 'Shocks, stick-slip and axial vibration against RPM, torque, WOB and ROP.',
    tracks: [T('RPM', 'rpm', DH_RPM), T('Stick-slip', STICK), T('Shock / lateral', SHOCK), T('Axial', AXIAL), T('Torque', 'torque', DH_TQ), T('WOB', 'wob', DH_WOB), T('ROP', 'rop')] },
];

/**
 * Resolve a layout for this wellbore.
 * std: {id, channels:Set} of the standard source ('drilling' / 'depth_drilling'); logs: [{gid, channels:[{mnem,n}]}]
 */
export function resolveLayout(layout, std, logs) {
  const tracks = [];
  let found = 0, wanted = 0;
  for (const t of layout.tracks) {
    const ch = [], off = [], sep = [];
    for (const c of t.ch) {
      wanted++;
      let ref = null;
      const stdM = typeof c === 'string' ? c : c.std;
      if (stdM) ref = std && std.channels.has(stdM) ? [std.id, stdM] : null;
      else {
        for (const m of c.find) {
          let best = null;
          for (const l of logs) {
            const hit = l.channels.find(x => x.mnem === m && x.n > 0);
            if (hit && (!best || hit.n > best.n)) best = { gid: l.gid, n: hit.n };
          }
          if (best) { ref = [best.gid, m]; break; }
        }
      }
      if (ref && !ch.some(x => x[0] === ref[0] && x[1] === ref[1])) {
        ch.push(ref); found++;
        if (c.off) off.push(ref.join('|'));
        if (c.sep) sep.push(ref.join('|'));
      }
    }
    if (ch.length) tracks.push({ title: t.title, ch, ...(off.length && { off }), ...(sep.length && { sep }) });
  }
  return { tracks, found, wanted };
}

/** Dropdown with suggested layouts, the user's saved layouts and "save current". */
export function openLayoutMenu(anchor, { kind, layouts, resolve, current, onApply }) {
  closeLayoutMenu();
  S.savedLayouts = S.savedLayouts || {};
  const mine = S.savedLayouts[kind] = S.savedLayouts[kind] || [];
  const active = (S.activeLayout || {})[kind];
  const menu = h('div', { class: 'popover layout-menu', role: 'menu', 'aria-label': 'Track layouts' });
  menu.append(h('div', { class: 'lm-h' }, 'Suggested layouts'),
    h('div', { class: 'muted lm-note' }, 'Picks the best channels this wellbore has for each use case.'));
  for (const L of layouts) {
    const r = resolve(L);
    menu.append(h('button', { class: `lm-item${active === L.id ? ' on' : ''}`, role: 'menuitem', disabled: !r.tracks.length,
      onclick: () => { onApply(r.tracks, L.id); closeLayoutMenu(); toast(`${L.name}: ${r.tracks.length} tracks, ${r.found} curves`); } },
      h('span', { class: 'lm-t' }, h('b', {}, L.name), active === L.id ? h('span', { class: 'lm-check' }, ' ✓') : null,
        h('span', { class: 'muted' }, ` · ${r.found}/${r.wanted} curves here`)),
      h('span', { class: 'lm-d' }, L.desc)));
  }
  menu.append(h('div', { class: 'lm-h', style: { marginTop: '6px' } }, 'My layouts'));
  if (!mine.length) menu.append(h('div', { class: 'muted lm-note' }, 'None yet - save the current tracks below.'));
  mine.forEach((L, i) => menu.append(h('div', { class: 'lm-row' },
    h('button', { class: 'lm-item', role: 'menuitem', onclick: () => { onApply(JSON.parse(JSON.stringify(L.tracks)), null); closeLayoutMenu(); toast(`Layout “${L.name}” applied`); } },
      h('span', { class: 'lm-t' }, h('b', {}, L.name), h('span', { class: 'muted' }, ` · ${L.tracks.length} tracks`))),
    h('button', { class: 'btn sm ghost', 'aria-label': `Delete ${L.name}`, title: 'Delete', onclick: () => { mine.splice(i, 1); save(); openLayoutMenu(anchor, { kind, layouts, resolve, current, onApply }); } }, '×'))));
  const name = h('input', { class: 'input', placeholder: 'Name for the current layout', 'aria-label': 'Layout name', style: { flex: 1 } });
  const doSave = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    const idx = mine.findIndex(x => x.name === n);
    const rec = { name: n, tracks: JSON.parse(JSON.stringify(current())) };
    if (idx >= 0) mine[idx] = rec; else mine.push(rec);
    save();
    toast(`Saved “${n}”`);
    openLayoutMenu(anchor, { kind, layouts, resolve, current, onApply });
  };
  name.addEventListener('keydown', e => { if (e.key === 'Enter') doSave(); });
  menu.append(h('div', { class: 'pop-row', style: { marginTop: '4px' } }, name, h('button', { class: 'btn sm primary', onclick: doSave }, 'Save')));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
  menu.style.top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - mh - 8)) + 'px';
  const away = e => { if (!menu.contains(e.target) && e.target !== anchor) closeLayoutMenu(); };
  const esc = e => { if (e.key === 'Escape') closeLayoutMenu(); };
  setTimeout(() => { document.addEventListener('mousedown', away); document.addEventListener('keydown', esc); });
  openMenu = { menu, away, esc };
}

let openMenu = null;
export function closeLayoutMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  document.removeEventListener('mousedown', openMenu.away);
  document.removeEventListener('keydown', openMenu.esc);
  openMenu = null;
}
