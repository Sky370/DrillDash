// Track editor modal. Full mode edits the whole layout; quick mode (target) adds one curve to one track.
import { h, $, toast } from './core.js';
import { chanConv, chanLabel } from './units.js';
import { MAX_CURVES } from './tracks.js';

// keywords that relate channels of the same physical quantity across vendors / logs
const FAMILIES = [
  ['wob', /WOB|WEIGHT ON BIT/i], ['torque', /TORQ|TQ|TOR[ACOX]/i], ['rpm', /RPM|ROTARY SPEED|ROTATION/i],
  ['hookload', /HKL|HOOK/i], ['pressure', /SPP|PRESS|PUMP|APRS|PRS/i], ['flow', /FLOW|FLO|TFLO/i], ['rop', /ROP|PENETRATION/i],
  ['depth', /DEPTH|DMEA|DBTM|BITDEP|DEPT/i], ['gamma', /GAMMA|^GR|GR[A-Z]X?$/i], ['ecd', /ECD/i], ['density', /MW|MUD WEIGHT|DENS/i],
  ['gas', /GAS|C1|METH/i], ['temp', /TEMP|MT[IO]/i], ['vibration', /SHOCK|VIB|STICK|SHK|ACC/i], ['block', /BLOCK|BPOS/i],
];
const famOf = (m, desc) => FAMILIES.filter(([, re]) => re.test(m) || (desc && re.test(desc))).map(([k]) => k);

/**
 * sources: [{id, name, channels:[{mnem, unit, desc, n}]}]
 * tracks:  [{title, ch:[[src, mnem]]}]
 * target:  track index -> quick "add curve" mode
 */
export function openTrackEditor({ title = 'Edit tracks', sources, tracks, defaults, unitOf, onSave, target = null }) {
  let work = JSON.parse(JSON.stringify(tracks));
  const quick = target != null && work[target];
  let chSel = null;
  const root = $('#modalRoot');
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  // suggestions: same quantity family and/or same unit as the target track's curves
  let suggested = null;
  if (quick) {
    const fams = new Set(work[target].ch.flatMap(([s, m]) => famOf(m, chanLabel(m, s))));
    const units = new Set(work[target].ch.map(([s, m]) => chanConv(m, unitOf(s, m), s).label));
    const have = new Set(work[target].ch.map(([s, m]) => `${s}|${m}`));
    const list = [];
    for (const s of sources) for (const c of s.channels) {
      if (have.has(`${s.id}|${c.mnem}`)) continue;
      const f = famOf(c.mnem, c.desc || chanLabel(c.mnem, s.id));
      const sameUnit = units.has(chanConv(c.mnem, unitOf(s.id, c.mnem), s.id).label);
      const score = (f.some(x => fams.has(x)) ? 2 : 0) + (sameUnit ? 1 : 0);
      if (score >= 2 || (fams.size === 0 && sameUnit)) list.push({ ...c, _src: s.id, _srcName: s.name, _score: score });
    }
    list.sort((a, b) => b._score - a._score || (b.n || 0) - (a.n || 0));
    suggested = { id: '__suggested', name: '★ Suggested for this track', channels: list.slice(0, 80) };
  }
  // every channel of every log in one searchable list
  const all = { id: '__all', name: 'All channels', channels: sources.flatMap(s => s.channels.map(c => ({ ...c, _src: s.id, _srcName: s.name }))) };
  const allSources = [all, ...(suggested ? [suggested] : []), ...sources];
  let srcSel = suggested ? suggested.id : all.id;

  const listEl = h('div', { class: 'track-list' });
  const srcList = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Data source' });
  const chList = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Channels' });
  const filter = h('input', { class: 'input', type: 'search', placeholder: 'Search all channels - mnemonic or description (e.g. block pos, gamma, ECD)…', 'aria-label': 'Search channels' });
  const LIMIT = 400;
  const addBar = h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } });

  const unitKey = (src, m) => chanConv(m, unitOf(src, m), src).label;
  const resolve = c => [c._src || srcSel, c.mnem];

  function renderTracks() {
    listEl.innerHTML = '';
    work.forEach((t, i) => {
      if (quick && i !== target) return;
      const row = h('div', { class: 'track-item', 'data-i': i },
        quick ? null : h('button', { class: 'grip', title: 'Drag to reorder (or focus and use ↑ / ↓)', 'aria-label': `Move ${t.title}`,
          onmousedown: e => startDrag(e, i, row),
          onkeydown: e => {
            const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
            if (!d || i + d < 0 || i + d >= work.length) return;
            e.preventDefault();
            const [m] = work.splice(i, 1); work.splice(i + d, 0, m);
            renderTracks();
            listEl.querySelectorAll('.grip')[i + d].focus();
          } }, '⠿'),
        h('input', { class: 'input nm', value: t.title, 'aria-label': 'Track title', style: { width: '140px' }, oninput: e => { t.title = e.target.value; } }),
        h('div', { class: 'chs' }, t.ch.map(([s, m], k) => h('span', { class: 'chpill', title: `${s} · ${m}` },
          `${chanLabel(m, s)} (${unitKey(s, m) || '–'})`,
          h('button', { 'aria-label': `Remove ${m}`, onclick: () => { t.ch.splice(k, 1); if (!t.ch.length && !quick) work.splice(i, 1); renderTracks(); renderAdd(); } }, '×')))),
        quick ? null : h('button', { class: 'btn sm ghost', 'aria-pressed': String(!t.hidden), title: t.hidden ? 'Hidden - click to show' : 'Shown - click to hide',
          onclick: () => { if (t.hidden) delete t.hidden; else t.hidden = true; renderTracks(); } }, t.hidden ? 'Show' : 'Hide'),
        quick ? null : h('button', { class: 'btn sm ghost', 'aria-label': 'Delete track', onclick: () => { work.splice(i, 1); renderTracks(); renderAdd(); } }, 'Remove'));
      listEl.append(row);
    });
    if (!work.length) listEl.append(h('div', { class: 'muted' }, 'No tracks - add a channel below.'));
  }

  // pointer-driven reordering: the row follows the mouse, a line marks where it will land
  function startDrag(e, from, row) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rows = [...listEl.querySelectorAll('.track-item')];
    const rects = rows.map(r => r.getBoundingClientRect());
    const y0 = e.clientY;
    const marker = h('div', { class: 'drop-line' });
    listEl.append(marker);
    row.classList.add('dragging');
    document.body.classList.add('dragging-row');
    let to = from;
    const lr = listEl.getBoundingClientRect();
    const move = ev => {
      row.style.transform = `translateY(${ev.clientY - y0}px)`;
      // insertion slot = number of row midpoints above the pointer
      to = rects.filter(r => r.top + r.height / 2 < ev.clientY).length;
      const y = to < rects.length ? rects[to].top - 4 : rects[rects.length - 1].bottom + 2;
      marker.style.top = `${y - lr.top + listEl.scrollTop}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.body.classList.remove('dragging-row');
      const dest = to > from ? to - 1 : to;
      if (dest !== from) { const [m] = work.splice(from, 1); work.splice(dest, 0, m); }
      renderTracks();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
    move(e);
  }

  function renderSources() {
    srcList.innerHTML = '';
    for (const s of allSources) {
      srcList.append(h('button', { class: s.id === srcSel ? 'sel' : '', role: 'option', 'aria-selected': String(s.id === srcSel),
        onclick: () => { srcSel = s.id; chSel = null; renderSources(); renderChannels(); renderAdd(); } },
        h('span', {}, s.name), h('span', { class: 'u' }, String(s.channels.length))));
    }
  }

  function renderChannels() {
    chList.innerHTML = '';
    const s = allSources.find(x => x.id === srcSel);
    if (!s) return;
    // every word must match the mnemonic, description, standard label or log name
    const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const chans = s.channels.filter(c => {
      if (!words.length) return true;
      const hay = `${c.mnem} ${c.desc || ''} ${chanLabel(c.mnem, c._src || s.id)} ${c._srcName || s.name}`.toLowerCase();
      return words.every(w => hay.includes(w));
    });
    if (words.length || s.id === '__all') chList.append(h('div', { class: 'muted', style: { padding: '6px 10px', fontSize: '12px' } },
      `${chans.length} channel${chans.length === 1 ? '' : 's'}${s.id === '__all' ? ' across all logs' : ` in ${s.name}`}${chans.length > LIMIT ? ` - showing the first ${LIMIT}, refine the search` : ''}`));
    for (const c of chans.slice(0, LIMIT)) {
      const sid = c._src || s.id;
      const lab = chanLabel(c.mnem, sid);
      chList.append(h('button', { class: chSel === c ? 'sel' : '', role: 'option', title: c.desc || c.mnem,
        onclick: () => { chSel = c; renderChannels(); renderAdd(); },
        ondblclick: () => { chSel = c; quickAdd(); } },
        h('span', {}, lab, c.desc && lab === c.mnem ? h('span', { class: 'muted' }, ` · ${c.desc}`) : null,
          c._srcName ? h('span', { class: 'muted' }, ` · ${c._srcName}`) : null),
        h('span', { class: 'u' }, unitKey(sid, c.mnem) || '')));
    }
    if (!chans.length) chList.append(h('div', { class: 'muted', style: { padding: '10px' } }, s.id === '__suggested' ? 'No related channels found - browse a log on the left.' : 'No channels match.'));
  }

  function quickAdd() {
    if (!chSel || !quick) return;
    const t = work[target];
    if (t.ch.length >= MAX_CURVES) { toast(`A track holds up to ${MAX_CURVES} curves`); return; }
    t.ch.push(resolve(chSel));
    onSave(work);
    toast(`${chanLabel(chSel.mnem, resolve(chSel)[0])} added to ${t.title}`);
    close();
  }

  function renderAdd() {
    addBar.innerHTML = '';
    if (!chSel) { addBar.append(h('span', { class: 'muted' }, quick ? 'Pick a channel (double-click adds it straight away).' : 'Pick a channel to add it.')); return; }
    const [sid, m] = resolve(chSel);
    const u = unitKey(sid, m);
    addBar.append(h('span', { class: 'sec' }, `${chanLabel(m, sid)} (${u || 'no unit'})`));
    if (quick) {
      const tu = new Set(work[target].ch.map(([s, mm]) => unitKey(s, mm)));
      addBar.append(h('button', { class: 'btn primary sm', onclick: quickAdd }, `+ Add to ${work[target].title}`));
      if (tu.size && !tu.has(u)) addBar.append(h('span', { class: 'muted', style: { fontSize: '12px' } }, `Different unit - it gets its own scale (shown in the track header).`));
      return;
    }
    addBar.append(h('button', { class: 'btn primary sm', onclick: () => {
      work.push({ title: chanLabel(m, sid), ch: [[sid, m]] }); renderTracks(); toast('Track added');
    } }, '+ New track'));
    const opts = work.map((t, i) => [t, i]).filter(([t]) => t.ch.length < MAX_CURVES && !t.ch.some(([s, mm]) => s === sid && mm === m));
    if (opts.length) {
      const sel = h('select', { class: 'select', 'aria-label': 'Add to track' }, opts.map(([t, i]) => h('option', { value: i }, t.title)));
      addBar.append(h('span', { class: 'muted' }, 'or'), sel, h('button', { class: 'btn sm', onclick: () => {
        work[+sel.value].ch.push([sid, m]); renderTracks(); toast('Curve added to track');
      } }, 'Add to track'));
    }
  }

  filter.oninput = () => {
    // typing searches everything unless a specific log is being browsed on purpose
    if (filter.value.trim() && srcSel === '__suggested') { srcSel = '__all'; chSel = null; renderSources(); }
    renderChannels();
  };
  renderTracks(); renderSources(); renderChannels(); renderAdd();

  root.append(h('div', { class: 'modal-bg', onclick: e => { if (e.target.classList.contains('modal-bg')) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-h' }, h('h2', {}, quick ? `Add a curve to “${work[target].title}”` : title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '×')),
      h('div', { class: 'modal-b' },
        h('div', {}, h('h3', { style: { marginBottom: '6px' } }, quick ? 'Curves in this track' : 'Tracks - top of the list is the leftmost track · drag ⠿ to reorder'), listEl),
        h('div', {}, h('h3', { style: { marginBottom: '6px' } }, 'Add a channel'),
          h('div', { class: 'picker' }, srcList, h('div', { style: { display: 'grid', gap: '8px', gridTemplateRows: 'auto 1fr' } }, filter, chList))),
        addBar),
      h('div', { class: 'modal-f' },
        quick ? null : h('button', { class: 'btn ghost', onclick: () => { work = JSON.parse(JSON.stringify(defaults)); renderTracks(); renderAdd(); } }, 'Reset to default'),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: () => { onSave(work.filter(t => t.ch.length)); close(); } }, quick ? 'Save' : 'Apply')))));
  filter.focus();
}
