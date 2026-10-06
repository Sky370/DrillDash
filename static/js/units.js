// Unit system: the store is SI; everything is converted for display here.
const R2D = 180 / Math.PI;
const Q = {
  'N':      { metric: ['t', v => v / 9806.65],        imperial: ['klbf', v => v / 4448.2216] },
  'Pa':     { metric: ['bar', v => v / 1e5],          imperial: ['psi', v => v / 6894.757] },
  'Pa_mse': { metric: ['MPa', v => v / 1e6],          imperial: ['ksi', v => v / 6894757] },
  'm3/s':   { metric: ['L/min', v => v * 60000],      imperial: ['gpm', v => v * 15850.32] },
  'c/s':    { metric: ['rpm', v => v * 60],           imperial: ['rpm', v => v * 60] },
  'N.m':    { metric: ['kN·m', v => v / 1000],        imperial: ['kft·lbf', v => v / 1355.818] },
  'm/s':    { metric: ['m/h', v => v * 3600],         imperial: ['ft/h', v => v * 11811.02] },
  'kg/m3':  { metric: ['sg', v => v / 1000],          imperial: ['ppg', v => v / 119.826] },
  'm':      { metric: ['m', v => v],                  imperial: ['ft', v => v / 0.3048] },
  'm3':     { metric: ['m³', v => v],                 imperial: ['bbl', v => v / 0.158987] },
  'K':      { metric: ['°C', v => v - 273.15],        imperial: ['°F', v => (v - 273.15) * 9 / 5 + 32] },
  'Hz':     { metric: ['spm', v => v * 60],           imperial: ['spm', v => v * 60] },
  'rad':    { metric: ['°', v => v * R2D],            imperial: ['°', v => v * R2D] },
  'rad/m':  { metric: ['°/30m', v => v * R2D * 30],   imperial: ['°/100ft', v => v * R2D * 30.48] },
  's':      { metric: ['s', v => v],                  imperial: ['s', v => v] },
};

// Canonical drilling channels (names produced by ingest.py)
export const CANON = {
  hole_depth:   { label: 'Hole Depth', s: 'Hole',      u: 'm',      d: 1 },
  bit_depth:    { label: 'Bit Depth', s: 'Bit',       u: 'm',      d: 1 },
  block_pos:    { label: 'Block Height', s: 'Block',    u: 'm',      d: 2 },
  hookload:     { label: 'Hookload',        u: 'N',      d: 1 },
  wob:          { label: 'WOB',             u: 'N',      d: 1 },
  rpm:          { label: 'RPM',             u: 'c/s',    d: 0 },
  torque:       { label: 'Torque',          u: 'N.m',    d: 1 },
  spp:          { label: 'SPP',             u: 'Pa',     d: 0 },
  flow_in:      { label: 'Flow In', s: 'In',         u: 'm3/s',   d: 0 },
  flow_out:     { label: 'Flow Out', s: 'Out',        u: 'm3/s',   d: 0 },
  flow_out_pct: { label: 'Flow Out %',      u: '%',      d: 0 },
  rop:          { label: 'ROP',             u: 'm/s',    d: 1 },
  mw_in:        { label: 'Mud Wt In', s: 'In',       u: 'kg/m3',  d: 2 },
  mw_out:       { label: 'Mud Wt Out', s: 'Out',      u: 'kg/m3',  d: 2 },
  pit_vol:      { label: 'Active Pits',     u: 'm3',     d: 1 },
  gain_loss:    { label: 'Gain / Loss',     u: 'm3',     d: 2 },
  gas:          { label: 'Total Gas',       u: '',       d: 2 },
  spm:          { label: 'Total SPM',       u: 'Hz',     d: 0 },
  choke_p:      { label: 'Choke Press.',    u: 'Pa',     d: 1 },
  mse:          { label: 'MSE',             u: 'Pa_mse', d: 1 },
  bit_rpm:      { label: 'Bit RPM',         u: 'c/s',    d: 0 },
  temp_in:      { label: 'Mud Temp In', s: 'In',     u: 'K',      d: 1 },
  temp_out:     { label: 'Mud Temp Out', s: 'Out',    u: 'K',      d: 1 },
  ecd:          { label: 'ECD',             u: 'kg/m3',  d: 2 },
  rig_code:     { label: 'Rig Activity Code', u: '',     d: 0 },
  // depth_drilling extras
  slide_frac:   { label: 'Slide Fraction',  u: 'frac',   d: 0 },
  rop_calc:     { label: 'ROP (time-based)',u: 'm/s',    d: 1 },
};

let SYSTEM = 'metric';
export const setSystem = s => { SYSTEM = s; };
export const getSystem = () => SYSTEM;

/** Converter for an SI unit string -> {label, f} in the active system. */
export function conv(u) {
  if (u === 'frac') return { label: '%', f: v => v * 100 };
  const q = Q[u];
  if (!q) return { label: u === 'unitless' ? '' : (u || ''), f: v => v };
  const [label, f] = q[SYSTEM];
  return { label, f };
}

/** Converter for a channel: canonical key or a raw log channel {unit}. */
export function chanConv(name, unit, src) {
  if ((src === 'drilling' || src === 'depth_drilling') && CANON[name]) return conv(CANON[name].u);
  if (name === 'MSE' || /MSE/.test(name) && unit === 'Pa') return conv('Pa_mse');
  return conv(unit);
}

export function chanLabel(name, src, short = false) {
  if ((src === 'drilling' || src === 'depth_drilling') && CANON[name]) return (short && CANON[name].s) || CANON[name].label;
  return name;
}

/** Sensible decimals for a display value. */
export function fmt(v, d) {
  if (v == null || !isFinite(v)) return '–';
  if (d == null) {
    const a = Math.abs(v);
    d = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3;
  }
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

export const depthConv = () => conv('m');
