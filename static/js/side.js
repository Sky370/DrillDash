// Collapsible side panel: each card folds to its header; the whole panel folds to a thin rail.
import { S, save, h } from './core.js';

const chevron = open => h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸');

/** cards: [{key, title, body, extra?, grow?}] -> panel element (state persisted per page). */
export function sidePanel(pageKey, cards) {
  S.side = S.side || {};
  const st = S.side[pageKey] = Object.assign({ collapsed: false }, S.side[pageKey] || {});
  const root = h('div', { class: 'side' });

  function render() {
    root.innerHTML = '';
    root.classList.toggle('rail', st.collapsed);
    if (st.collapsed) {
      root.append(h('button', { class: 'rail-btn', title: 'Show side panel', 'aria-label': 'Show side panel',
        onclick: () => { st.collapsed = false; save(); render(); } }, '«'));
      for (const c of cards) {
        root.append(h('button', { class: 'rail-tab', title: `Show ${c.title}`,
          onclick: () => { st.collapsed = false; st[c.key] = true; save(); render(); } }, c.title));
      }
      return;
    }
    cards.forEach((c, i) => {
      const open = st[c.key] !== false;
      const card = h('div', { class: `card side-card ${open ? '' : 'closed'}`, style: { flex: open && c.grow ? '1' : 'none' } });
      const hdr = h('div', { class: 'card-h' },
        h('button', { class: 'card-toggle', 'aria-expanded': String(open), title: open ? 'Minimize' : 'Expand',
          onclick: () => { st[c.key] = !open; save(); render(); } }, chevron(open), h('h2', {}, c.title)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, open ? c.extra : null,
          i === 0 ? h('button', { class: 'icon-btn sm', title: 'Hide side panel', 'aria-label': 'Hide side panel',
            onclick: () => { st.collapsed = true; save(); render(); } }, '»') : null));
      card.append(hdr);
      if (open) card.append(c.body);
      root.append(card);
    });
  }
  render();
  return root;
}
