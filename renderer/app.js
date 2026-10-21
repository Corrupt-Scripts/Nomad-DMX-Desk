(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers
  const $ = (s, r = document) => r.querySelector(s);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    let value;
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'value') value = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    if (value !== undefined) n.value = value;
    return n;
  }

  function throttle(fn, ms) {
    let last = 0; let timer = null; let pendingArgs = null;
    return (...a) => {
      const now = Date.now();
      pendingArgs = a;
      if (now - last >= ms) { last = now; fn(...a); pendingArgs = null; return; }
      if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); if (pendingArgs) fn(...pendingArgs); pendingArgs = null; }, ms - (now - last));
    };
  }

  const pad = (n, w) => String(n).padStart(w, '0');

  // -------------------------------------------------------------------- state
  let show = null;
  let lib = { profiles: [], effects: [], categories: [] };
  const fxUi = { cat: 'All', q: '' };
  const patchUi = { man: 'All', q: '' };
  let live = { out: [], status: { packets: 0, lastError: '', current: -1, fading: false, programmer: [] } };
  const ui = { tab: 'desk', deskView: 'fixtures', anchor: null, pending: false, profileEdit: null, cells: [], tiles: new Map(), intensity: null, recNum: null };

  const TABS = [['desk', 'Desk'], ['layout', 'Layout'], ['patch', 'Patch'], ['cues', 'Cues'], ['effects', 'Effects'], ['output', 'Output']];

  async function call(method, ...args) {
    const r = await window.desk.api(method, ...args);
    if (r && r.ok === false) setFeedback(r.message, true);
    return r;
  }

  function setFeedback(msg, err) {
    const f = $('#cmdfeedback');
    f.textContent = msg || '';
    f.className = err ? 'err' : '';
  }

  const profileOf = (f) => show.profiles.find((p) => p.id === f.profileId);
  const selFixtures = () => (show.selection.mode === 'fix' ? show.selection.ids.map((id) => show.patch.find((f) => f.id === id)).filter(Boolean) : []);
  const sortedPatch = () => show.patch.slice().sort((a, b) => a.num - b.num);

  // ---------------------------------------------------------------- top bar
  function renderTabs() {
    const nav = $('#tabs');
    nav.replaceChildren(...TABS.map(([id, label]) => el('button', { class: ui.tab === id ? 'on' : '', onclick: () => { ui.tab = id; renderTabs(); renderView(true); } }, label)));
  }

  function renderCueBar() {
    const bar = $('#cuebar');
    const cur = show.cues[show.currentCue];
    bar.replaceChildren(
      el('div', { class: 'cuelabel', id: 'cuelabel' }, cur ? el('span', {}, 'Cue ', el('b', {}, cur.number), ` · ${cur.label}`) : 'No cue active'),
      el('button', { onclick: () => call('back'), title: 'Previous cue' }, '◀ Back'),
      el('button', { class: 'primary', onclick: () => doGo(), title: 'Space' }, 'GO ▶'),
    );
  }

  async function doGo() {
    if (!show.cues.length) { setFeedback('No cues recorded yet – set a look, then: record cue 1', true); return; }
    await call('go');
  }

  function renderMaster() {
    $('#gm').value = show.gm;
    $('#gmval').textContent = `${show.gm}%`;
    $('#bo').classList.toggle('on', show.blackout);
    $('#bo').textContent = show.blackout ? 'BLACKOUT ON' : 'BLACKOUT';
  }

  // -------------------------------------------------------------------- desk
  function selectionText() {
    const s = show.selection;
    if (s.mode === 'ch') {
      if (!s.channels.length) return 'Nothing selected';
      return `Universe ${s.universe}: ${rangeText(s.channels)}`;
    }
    const f = selFixtures();
    if (!f.length) return 'Nothing selected';
    return `Fixtures ${rangeText(f.map((x) => x.num).sort((a, b) => a - b))}`;
  }

  function rangeText(nums) {
    const out = []; let i = 0;
    while (i < nums.length) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      out.push(j - i >= 2 ? `${nums[i]}–${nums[j]}` : nums.slice(i, j + 1).join(', '));
      i = j + 1;
    }
    return out.join(', ');
  }

  function renderDesk() {
    ui.cells = []; ui.tiles = new Map();
    const chView = ui.deskView === 'channels';
    const head = el('h3', {},
      'Programmer',
      el('div', { class: 'seg' },
        el('button', { class: !chView ? 'on' : '', onclick: () => { ui.deskView = 'fixtures'; renderView(true); } }, 'Fixtures'),
        el('button', { class: chView ? 'on' : '', onclick: () => { ui.deskView = 'channels'; renderView(true); } }, 'Channels')),
      chView ? el('select', { onchange: (e) => call('setUniverse', parseInt(e.target.value, 10)), value: String(show.currentUniverse) },
        Array.from({ length: show.settings.universes }, (_, i) => el('option', { value: String(i + 1) }, `Universe ${i + 1}`))) : null,
      el('button', { class: ui.multi ? 'primary' : '', title: 'Tap several fixtures to select them together (for touch screens)', onclick: () => { ui.multi = !ui.multi; renderView(true); } }, ui.multi ? 'Multi ✓' : 'Multi'),
      el('span', { class: 'grow' }),
      el('span', { class: 'pill' }, selectionText()));

    let body;
    if (!chView) {
      if (!show.patch.length) {
        body = el('div', { class: 'hint' }, 'No fixtures patched yet. Add some on the Patch tab, or switch to Channels to drive raw DMX channels.');
      } else {
        body = el('div', { class: 'tiles' }, sortedPatch().map((f, idx) => {
          const sw = el('div', { class: 'sw' });
          ui.tiles.set(f.id, sw);
          const sel = show.selection.mode === 'fix' && show.selection.ids.includes(f.id);
          return el('div', { class: `tile${sel ? ' sel' : ''}${show.conflicts.includes(f.id) ? ' bad' : ''}`, onclick: (e) => clickFixture(e, f, idx) },
            sw, el('div', { class: 'nm' }, el('b', {}, f.num), el('span', {}, f.name)),
            el('div', { class: 'ad' }, `U${f.universe} · ${pad(f.address, 3)}`));
        }));
      }
    } else {
      const sel = show.selection.mode === 'ch' && show.selection.universe === show.currentUniverse ? new Set(show.selection.channels) : new Set();
      body = el('div', { class: 'chgrid' }, Array.from({ length: 512 }, (_, i) => {
        const ch = i + 1;
        const v = el('span', { class: 'v' }, '0');
        const cell = el('div', { class: `cell${sel.has(ch) ? ' sel' : ''}`, onclick: (e) => clickChannel(e, ch), title: `Universe ${show.currentUniverse} · channel ${ch}` }, el('span', { class: 'n' }, ch), v);
        ui.cells.push({ cell, v });
        return cell;
      }));
    }

    const left = el('div', { class: 'panel deskleft' }, head, el('div', { class: 'scroll' }, body));
    $('#view').replaceChildren(el('div', { class: 'desk' }, left, renderControls()));
    updateLive();
  }

  function clickFixture(e, f, idx) {
    const list = sortedPatch();
    let ids = show.selection.mode === 'fix' ? show.selection.ids.slice() : [];
    if (e.shiftKey && ui.anchor != null) {
      const [a, b] = [Math.min(ui.anchor, idx), Math.max(ui.anchor, idx)];
      ids = Array.from(new Set(ids.concat(list.slice(a, b + 1).map((x) => x.id))));
    } else if (e.ctrlKey || e.metaKey || ui.multi) {
      ids = ids.includes(f.id) ? ids.filter((x) => x !== f.id) : ids.concat(f.id);
      ui.anchor = idx;
    } else {
      ids = ids.length === 1 && ids[0] === f.id ? [] : [f.id];
      ui.anchor = idx;
    }
    call('setSelection', { mode: 'fix', ids });
  }

  function clickChannel(e, ch) {
    const s = show.selection;
    let chans = s.mode === 'ch' && s.universe === show.currentUniverse ? s.channels.slice() : [];
    if (e.shiftKey && ui.anchor != null) {
      const [a, b] = [Math.min(ui.anchor, ch), Math.max(ui.anchor, ch)];
      for (let c = a; c <= b; c++) if (!chans.includes(c)) chans.push(c);
    } else if (e.ctrlKey || e.metaKey || ui.multi) {
      chans = chans.includes(ch) ? chans.filter((x) => x !== ch) : chans.concat(ch);
      ui.anchor = ch;
    } else {
      chans = chans.length === 1 && chans[0] === ch ? [] : [ch];
      ui.anchor = ch;
    }
    call('setSelection', { mode: 'ch', universe: show.currentUniverse, channels: chans });
  }

  const SWATCHES = [['Red', '#ff0000'], ['Orange', '#ff6e00'], ['Amber', '#ffbf00'], ['Yellow', '#ffdc00'], ['Green', '#00ff00'], ['Cyan', '#00ffff'], ['Blue', '#0000ff'], ['Purple', '#8c00ff'], ['Magenta', '#ff00ff'], ['Pink', '#ff50a0'], ['Warm', '#ffbe78'], ['White', '#ffffff']];
  const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

  function renderControls() {
    const fixtures = selFixtures();
    const has = show.selection.mode === 'ch' ? show.selection.channels.length > 0 : fixtures.length > 0;
    const types = new Set();
    fixtures.forEach((f) => (profileOf(f) || { channels: [] }).channels.forEach((c) => types.add(c.type)));

    const intensity = el('input', { type: 'range', min: 0, max: 100, value: 0, disabled: !has });
    const ival = el('span', { class: 'val' }, '0');
    intensity.addEventListener('input', throttle(() => { ival.textContent = intensity.value; call('setLevel', parseInt(intensity.value, 10)); }, 30));
    ui.intensity = { input: intensity, val: ival };

    const rows = [
      el('div', { class: 'row' }, el('label', {}, 'Intensity'), intensity, ival),
    ];

    if (show.selection.mode === 'fix' && fixtures.length && ['red', 'green', 'blue'].some((t) => types.has(t))) {
      const picker = el('input', { type: 'color', value: '#ffffff' });
      picker.addEventListener('input', throttle(() => call('setColour', ...hexToRgb(picker.value)), 30));
      rows.push(el('div', { class: 'row' }, el('label', {}, 'Colour'), picker),
        el('div', { class: 'swatches' }, SWATCHES.map(([n, c]) => el('button', { title: n, style: `background:${c}`, onclick: () => call('setColour', ...hexToRgb(c)) }))));
    }

    const kRange = (() => { for (const f of fixtures) { const p = profileOf(f); const c = p && p.channels.find((x) => x.type === 'cct' && x.range); if (c) return c.range; } return null; })();
    ['white', 'warm', 'cool', 'amber', 'uv', 'cct', 'tint', 'pan', 'tilt', 'other'].filter((t) => types.has(t)).forEach((t) => {
      const kel = (v) => (t === 'cct' && kRange ? `${Math.round(kRange[0] + (kRange[1] - kRange[0]) * v / 255)}K` : String(v));
      const val = el('span', { class: 'val', style: t === 'cct' && kRange ? 'width:52px' : '' }, '–');
      const r = el('input', { type: 'range', min: 0, max: 255, value: 0 });
      r.addEventListener('input', throttle(() => { val.textContent = kel(parseInt(r.value, 10)); call('setParam', t, parseInt(r.value, 10)); }, 30));
      rows.push(el('div', { class: 'row' }, el('label', {}, t === 'cct' ? 'Colour temp' : t === 'tint' ? 'Tint' : t[0].toUpperCase() + t.slice(1)), r, val));
    });

    if (!has) rows.push(el('div', { class: 'hint' }, 'Select fixtures or channels, or type on the command line below.'));

    const nextNum = show.cues.length ? Math.floor(Math.max(...show.cues.map((c) => c.number))) + 1 : 1;
    const recNum = el('input', { type: 'number', step: 'any', min: 0, value: ui.recNum != null ? ui.recNum : nextNum, style: 'width:64px' });
    const recFade = el('input', { type: 'number', step: 'any', min: 0, value: 2, style: 'width:64px' });
    recNum.addEventListener('change', () => { ui.recNum = recNum.value; });

    return el('div', { class: 'panel controls' },
      el('h3', {}, 'Controls'),
      ...rows,
      el('div', { class: 'row' },
        el('button', { onclick: () => call('clearProgrammer') }, 'Clear values'),
        el('button', { onclick: () => call('clearAll') }, 'Clear all')),
      el('h3', { style: 'margin-top:8px' }, 'Record look'),
      el('div', { class: 'row' }, el('label', { style: 'width:auto' }, 'Cue'), recNum, el('label', { style: 'width:auto' }, 'Fade s'), recFade),
      el('div', { class: 'row' }, el('button', {
        class: 'primary',
        onclick: async () => { const r = await call('execute', `record cue ${recNum.value} time ${recFade.value}`); setFeedback(r.message, !r.ok); ui.recNum = null; },
      }, 'Record cue')),
      el('div', { class: 'hint' }, 'Recording stores the programmer plus whatever is playing, then hands the look to the cue list.'));
  }

  // ------------------------------------------------------------------- patch
  function renderPatch() {
    const conflicts = new Set(show.conflicts);
    const rows = sortedPatch().map((f) => {
      const p = profileOf(f);
      const upd = (field, parse) => (e) => call('updateFixture', f.id, { [field]: parse ? parse(e.target.value) : e.target.value });
      return el('tr', { class: conflicts.has(f.id) ? 'bad' : '' },
        el('td', {}, el('input', { class: 'n', type: 'number', min: 1, value: f.num, onchange: upd('num') })),
        el('td', {}, el('input', { type: 'text', value: f.name, onchange: upd('name') })),
        el('td', {}, p ? p.name : '?'),
        el('td', {}, el('input', { class: 'n', type: 'number', min: 1, max: 16, value: f.universe, onchange: upd('universe') })),
        el('td', {}, el('input', { class: 'n', type: 'number', min: 1, max: 512, value: f.address, onchange: upd('address') })),
        el('td', {}, p ? `${p.channels.length} ch` : ''),
        el('td', {}, el('button', { class: 'danger', onclick: () => call('removeFixture', f.id) }, '✕')));
    });

    const table = el('div', { class: 'panel' },
      el('h3', {}, 'Patch', el('span', { class: 'grow' }), conflicts.size ? el('span', { class: 'pill warn' }, 'Address overlap highlighted') : null),
      show.patch.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Name', 'Profile', 'Univ', 'Addr', 'Size', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : el('div', { class: 'hint' }, 'Nothing patched. Use the form on the right.'));

    const mans = ['All', 'Generic & my profiles'].concat(Array.from(new Set(lib.profiles.map((x) => x.m))).sort((a, b) => a.localeCompare(b)));
    const manSel = el('select', { value: patchUi.man }, mans.map((m) => el('option', { value: m }, m)));
    const search = el('input', { type: 'text', placeholder: 'search e.g. 600x, skypanel, tube', value: patchUi.q });
    const profSel = el('select', { size: 8, style: 'width:100%' });
    const info = el('div', { class: 'hint' });
    const fill = () => {
      patchUi.man = manSel.value; patchUi.q = search.value;
      const q = search.value.trim().toLowerCase();
      const items = [];
      if (patchUi.man === 'All' || patchUi.man === 'Generic & my profiles') {
        for (const p of show.profiles) if (!p.library) items.push({ id: p.id, label: `${p.name} (${p.channels.length}ch)`, hay: p.name.toLowerCase() });
      }
      if (patchUi.man !== 'Generic & my profiles') {
        for (const p of lib.profiles) {
          if (patchUi.man !== 'All' && p.m !== patchUi.man) continue;
          const label = `${p.m} ${p.f} - ${p.mode} (${p.n}ch)`;
          items.push({ id: p.id, label, hay: label.toLowerCase() });
        }
      }
      const words = q.split(/\s+/).filter(Boolean);
      const hits = items.filter((it) => words.every((w) => it.hay.includes(w)));
      const shown = hits.slice(0, 400);
      const keep = profSel.value;
      profSel.replaceChildren(...shown.map((it) => el('option', { value: it.id }, it.label)));
      if (shown.some((it) => it.id === keep)) profSel.value = keep; else if (shown.length) profSel.selectedIndex = 0;
      info.textContent = `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length > shown.length ? ` (showing first ${shown.length}, keep typing to narrow)` : ''}`;
    };
    manSel.addEventListener('change', fill);
    search.addEventListener('input', fill);
    const count = el('input', { type: 'number', min: 1, max: 256, value: 1 });
    const uni = el('input', { type: 'number', min: 1, max: 16, value: show.currentUniverse });
    const addr = el('input', { type: 'number', min: 1, max: 512, value: 1 });
    const name = el('input', { type: 'text', placeholder: '(profile name)' });
    const add = el('div', { class: 'panel' }, el('h3', {}, 'Add fixtures'),
      el('div', { class: 'form' },
        el('label', {}, 'Maker'), manSel, el('label', {}, 'Search'), search,
        el('label', {}, 'Fixture / mode'), profSel, el('span'), info,
        el('label', {}, 'Quantity'), count,
        el('label', {}, 'Universe'), uni, el('label', {}, 'Start address'), addr, el('label', {}, 'Name'), name,
        el('span'), el('button', { class: 'primary', onclick: () => { if (profSel.value) call('addFixtures', { profileId: profSel.value, count: count.value, universe: uni.value, address: addr.value, name: name.value }); } }, 'Patch')),
      el('div', { class: 'hint', style: 'margin-top:8px' }, `Quantity > 1 patches them back to back, rolling to the next universe when one fills. ${lib.profiles.length} film & studio fixture modes included (Open Fixture Library).`));
    fill();

    $('#view').replaceChildren(el('div', { class: 'cols2' }, table, el('div', { class: 'stack' }, add, renderProfiles())));
  }

  function renderProfiles() {
    const pe = ui.profileEdit;
    if (pe) {
      const types = show.types;
      const rows = pe.channels.map((c, i) => el('tr', {},
        el('td', {}, i + 1),
        el('td', {}, el('input', { type: 'text', value: c.name, oninput: (e) => { c.name = e.target.value; } })),
        el('td', {}, el('select', { value: c.type, onchange: (e) => { c.type = e.target.value; } }, types.map((t) => el('option', { value: t }, t)))),
        el('td', {}, el('button', { class: 'danger', onclick: () => { pe.channels.splice(i, 1); renderView(true); } }, '✕'))));
      return el('div', { class: 'panel' }, el('h3', {}, pe.id ? 'Edit profile' : 'New profile'),
        el('div', { class: 'form', style: 'margin-bottom:8px' }, el('label', {}, 'Name'), el('input', { type: 'text', value: pe.name, oninput: (e) => { pe.name = e.target.value; } })),
        el('table', {}, el('thead', {}, el('tr', {}, ['#', 'Channel', 'Type', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('button', { onclick: () => { pe.channels.push({ name: `Ch ${pe.channels.length + 1}`, type: 'other' }); renderView(true); } }, '+ Channel'),
          el('button', { class: 'primary', onclick: async () => { const r = await call('saveProfile', { id: pe.id, name: pe.name, channels: pe.channels }); if (r.ok) { ui.profileEdit = null; renderView(true); } } }, 'Save'),
          el('button', { onclick: () => { ui.profileEdit = null; renderView(true); } }, 'Cancel')));
    }
    const rows = show.profiles.filter((p) => !p.library).map((p) => el('tr', {},
      el('td', {}, p.name, p.builtin ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'built-in') : null),
      el('td', {}, `${p.channels.length} ch`),
      el('td', { style: 'white-space:nowrap' },
        !p.builtin ? el('button', { onclick: () => { ui.profileEdit = { id: p.id, name: p.name, channels: p.channels.map((c) => ({ ...c })) }; renderView(true); } }, 'Edit') : null,
        el('button', { onclick: () => { ui.profileEdit = { id: null, name: `${p.name} copy`, channels: p.channels.map((c) => ({ ...c })) }; renderView(true); } }, 'Copy'),
        !p.builtin ? el('button', { class: 'danger', onclick: () => call('deleteProfile', p.id) }, '✕') : null)));
    return el('div', { class: 'panel' }, el('h3', {}, 'Fixture profiles', el('span', { class: 'grow' }),
      el('button', { onclick: () => { ui.profileEdit = { id: null, name: 'New fixture', channels: [{ name: 'Dimmer', type: 'dimmer' }] }; renderView(true); } }, '+ New')),
      el('table', {}, el('tbody', {}, rows)));
  }

  // -------------------------------------------------------------------- cues
  function renderCues() {
    const rows = show.cues.map((c, i) => el('tr', { class: i === show.currentCue ? 'cur' : '' },
      el('td', {}, el('input', { class: 'n', type: 'number', step: 'any', min: 0, value: c.number, onchange: (e) => call('updateCue', c.id, { number: e.target.value }) })),
      el('td', {}, el('input', { type: 'text', value: c.label, onchange: (e) => call('updateCue', c.id, { label: e.target.value }) })),
      el('td', {}, el('input', { class: 'n', type: 'number', step: 'any', min: 0, value: c.fade, onchange: (e) => call('updateCue', c.id, { fade: e.target.value }) })),
      el('td', {}, `${Object.keys(c.values).length} ch`),
      el('td', { style: 'white-space:nowrap' }, el('button', { onclick: () => call('goIndex', i) }, 'Go'), el('button', { class: 'danger', onclick: () => call('deleteCue', c.id) }, '✕'))));
    $('#view').replaceChildren(el('div', { class: 'panel' },
      el('h3', {}, 'Cue list', el('span', { class: 'grow' }),
        el('button', { onclick: () => call('back') }, '◀ Back'), el('button', { class: 'primary', onclick: doGo }, 'GO ▶'),
        el('button', { onclick: () => call('stop') }, 'Stop fade'), el('button', { onclick: () => call('release') }, 'Release')),
      show.cues.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ['Cue', 'Label', 'Fade (s)', 'Levels', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : el('div', { class: 'hint' }, 'No cues yet. On the Desk, set a look and type: record cue 1 time 2   (or use the Record look box).')));
  }

  // ----------------------------------------------------------------- effects
  function fxGroups(selectedId) {
    const q = fxUi.q.trim().toLowerCase();
    const groups = new Map();
    for (const e of lib.effects) {
      if (fxUi.cat !== 'All' && e.cat !== fxUi.cat) continue;
      if (q && !(e.name + ' ' + e.cat).toLowerCase().includes(q) && e.id !== selectedId) continue;
      if (!groups.has(e.cat)) groups.set(e.cat, []);
      groups.get(e.cat).push(e);
    }
    return groups;
  }
  const fxName = (id) => { const e = lib.effects.find((x) => x.id === id); return e ? e.name : id; };

  // ------------------------------------------------------------------ layout
  // Put fixtures on a plan: a background picture (stage plan, floor plan, photo) plus drawn shapes.
  const lay = { lock: false, tool: 'select', shape: null, bgUrl: null, bgVersion: -1, colour: '#8b5cf6', fill: false, nodes: new Map(), drag: null, draft: null, active: false };
  const SVGNS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; };
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const SHAPE_TOOLS = [['select', 'Select'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['line', 'Line'], ['text', 'Text']];

  async function layoutImage() {
    const L = show.layout;
    if (!L.hasBg) { lay.bgUrl = null; lay.bgVersion = L.bgVersion; return; }
    if (lay.bgUrl && lay.bgVersion === L.bgVersion) return;
    const r = await window.desk.api('getLayoutImage');
    lay.bgUrl = r && r.result ? r.result.bg : null;
    lay.bgVersion = L.bgVersion;
  }

  function pickImage(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1800; const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * k)); const h = Math.max(1, Math.round(img.naturalHeight * k));
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
        call('setLayoutImage', c.toDataURL('image/jpeg', 0.85), w / h);
      };
      img.onerror = () => setFeedback('That file is not an image the desk can read', true);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  function renderLayout() {
    lay.active = true;
    layoutImage().then(() => { if (ui.tab === 'layout' && lay.canvasEl) paintBg(); });
    const L = show.layout;
    const stacked = window.innerWidth <= 900;
    const view = $('#view');
    const availW = Math.max(240, view.clientWidth - 28 - (stacked ? 0 : 304));
    const availH = Math.max(220, stacked ? Math.min(window.innerHeight * 0.65, 720) : view.clientHeight - 28);
    const w = Math.floor(Math.min(availW, availH * L.aspect));
    const h = Math.floor(w / L.aspect);
    const canvas = el('div', { class: 'lay-canvas', style: `width:${w}px;height:${h}px` });
    lay.canvasEl = canvas; lay.w = w; lay.h = h;
    const svg = sv('svg', { viewBox: `0 0 1000 ${1000 / L.aspect}`, preserveAspectRatio: 'none' });
    const handles = el('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    const fxLayer = el('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    const band = el('div', { class: 'lay-band', style: 'display:none' });
    canvas.append(svg, fxLayer, handles, band);
    lay.svg = svg; lay.handles = handles; lay.band = band; lay.fxLayer = fxLayer;

    paintFixtures();
    paintShapes();
    paintBg();
    canvas.addEventListener('pointerdown', layDown);
    canvas.addEventListener('pointermove', layMove);
    canvas.addEventListener('pointerup', layUp);
    canvas.addEventListener('pointercancel', layUp);

    const side = el('div', { class: 'panel controls', id: 'laySide' });
    lay.sideEl = side;
    drawSide();
    $('#view').replaceChildren(el('div', { class: 'lay' }, el('div', { class: 'lay-stage' }, canvas), side));
    canvas.classList.toggle('draw', lay.tool !== 'select');
    updateLive();
  }

  function paintBg() {
    const c = lay.canvasEl; if (!c) return;
    c.classList.toggle('hasbg', !!lay.bgUrl);
    c.style.backgroundImage = lay.bgUrl ? `url("${lay.bgUrl}")` : '';
  }

  const shapesNow = () => show.layout.shapes.map((s) => (lay.draft && lay.draft.id === s.id ? lay.draft : s)).concat(lay.draft && lay.draft.id === '__new' ? [lay.draft] : []);

  function paintShapes() {
    const L = show.layout; const H = 1000 / L.aspect; const px = 1000 / lay.w;
    lay.svg.replaceChildren();
    lay.handles.replaceChildren();
    for (const s of shapesNow()) {
      const g = sv('g', { 'data-sid': s.id });
      const stroke = { stroke: s.color, 'stroke-width': s.width, 'vector-effect': 'non-scaling-stroke', fill: s.fill ? s.color : 'none', 'fill-opacity': s.fill ? 0.35 : 0, 'pointer-events': lay.lock ? 'none' : 'all' };
      let main; let hit = null;
      const X = (v) => v * 1000; const Y = (v) => v * H;
      if (s.type === 'rect') main = sv('rect', { x: X(s.x), y: Y(s.y), width: X(s.w), height: Y(s.h), ...stroke });
      else if (s.type === 'ellipse') main = sv('ellipse', { cx: X(s.x + s.w / 2), cy: Y(s.y + s.h / 2), rx: X(s.w / 2), ry: Y(s.h / 2), ...stroke });
      else if (s.type === 'triangle') main = sv('polygon', { points: `${X(s.x + s.w / 2)},${Y(s.y)} ${X(s.x + s.w)},${Y(s.y + s.h)} ${X(s.x)},${Y(s.y + s.h)}`, ...stroke });
      else if (s.type === 'line') {
        main = sv('line', { x1: X(s.x), y1: Y(s.y), x2: X(s.x2), y2: Y(s.y2), ...stroke, fill: 'none', 'stroke-linecap': 'round', 'pointer-events': lay.lock ? 'none' : 'stroke' });
        hit = sv('line', { x1: X(s.x), y1: Y(s.y), x2: X(s.x2), y2: Y(s.y2), stroke: 'transparent', 'stroke-width': 22, 'vector-effect': 'non-scaling-stroke', 'pointer-events': lay.lock ? 'none' : 'stroke' });
      } else {
        main = sv('text', { x: X(s.x), y: Y(s.y), fill: s.color, 'font-size': s.size * px, 'font-family': 'system-ui, sans-serif', 'dominant-baseline': 'hanging', 'pointer-events': lay.lock ? 'none' : 'all' });
        main.textContent = s.text || 'Text';
      }
      g.append(...[main, hit].filter(Boolean));
      if (s.text && s.type !== 'text') {
        const label = sv('text', { x: X(s.type === 'line' ? (s.x + s.x2) / 2 : s.x + s.w / 2), y: Y(s.type === 'line' ? (s.y + s.y2) / 2 : s.y + s.h / 2), fill: '#fff', 'font-size': s.size * px, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-family': 'system-ui, sans-serif', 'pointer-events': 'none' });
        label.textContent = s.text; g.append(label);
      }
      lay.svg.append(g);
      if (s.id === lay.shape && s.id !== '__new') {
        const hs = s.type === 'line' ? [['p1', s.x, s.y], ['p2', s.x2, s.y2]] : s.type === 'text' ? [] : [['br', s.x + s.w, s.y + s.h]];
        for (const [k, hx, hy] of hs) lay.handles.appendChild(el('div', { class: 'lay-handle', 'data-h': k, style: `left:${hx * 100}%;top:${hy * 100}%;pointer-events:auto` }));
        if (s.type !== 'line') {
          const bw = s.type === 'text' ? Math.max(0.05, (s.text || 'Text').length * s.size * 0.6 / lay.w) : s.w; const bh = s.type === 'text' ? s.size * 1.3 / lay.h : s.h;
          lay.handles.appendChild(el('div', { style: `position:absolute;left:${s.x * 100}%;top:${s.y * 100}%;width:${bw * 100}%;height:${bh * 100}%;border:1px dashed var(--accent2);pointer-events:none` }));
        }
      }
    }
  }

  function paintFixtures() {
    lay.fxLayer.replaceChildren();
    lay.nodes = new Map();
    const sel = new Set(show.selection.mode === 'fix' ? show.selection.ids : []);
    for (const f of show.patch) {
      const p = show.layout.pos[f.id];
      if (!p) continue;
      const n = el('div', { class: `lay-fx${sel.has(f.id) ? ' sel' : ''}${show.conflicts.includes(f.id) ? ' bad' : ''}`, 'data-fid': f.id, title: `${f.num} ${f.name}`, style: `left:${p.x * 100}%;top:${p.y * 100}%` }, String(f.num));
      const lb = show.layout.labels || { name: true, addr: true, size: 11 };
      if (lb.name || lb.addr) {
        const lines = [];
        if (lb.name) lines.push(f.name);
        if (lb.addr) lines.push(`U${f.universe}·${pad(f.address, 3)}`);
        n.appendChild(el('div', { class: 'lay-label', style: `font-size:${lb.size}px` }, lines.map((t) => el('div', {}, t))));
      }
      lay.nodes.set(f.id, n);
      lay.fxLayer.appendChild(n);
    }
  }

  function layPoint(e) {
    const r = lay.canvasEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  const additive = (e) => e.shiftKey || e.ctrlKey || e.metaKey || ui.multi;

  function layDown(e) {
    if (e.button != null && e.button > 0) return;
    const pt = layPoint(e);
    const fx = e.target.closest('[data-fid]');
    const hd = e.target.closest('[data-h]');
    const sh = e.target.closest('[data-sid]');
    try { lay.canvasEl.setPointerCapture(e.pointerId); } catch (x) { /* pointer already gone */ }
    if (hd && lay.shape) {
      const s = show.layout.shapes.find((x) => x.id === lay.shape);
      lay.drag = { kind: 'resize', h: hd.dataset.h, s, moved: false };
    } else if (fx && lay.tool === 'select') {
      const id = fx.dataset.fid;
      const selIds = show.selection.mode === 'fix' ? show.selection.ids : [];
      const group = selIds.includes(id) ? selIds.filter((i) => show.layout.pos[i]) : [id];
      lay.drag = { kind: 'fix', id, start: pt, group, orig: Object.fromEntries(group.map((i) => [i, { ...show.layout.pos[i] }])), moved: false, add: additive(e) };
    } else if (lay.tool !== 'select') {
      lay.drag = { kind: 'draw', start: pt, moved: false };
    } else if (sh) {
      const s = show.layout.shapes.find((x) => x.id === sh.dataset.sid);
      lay.shape = s ? s.id : null;
      lay.drag = s ? { kind: 'shape', s, start: pt, moved: false } : null;
      paintShapes(); drawSide();
    } else {
      lay.drag = { kind: 'band', start: pt, moved: false, add: additive(e) };
    }
    e.preventDefault();
  }

  function layMove(e) {
    const d = lay.drag; if (!d) return;
    const pt = layPoint(e);
    const dx = pt.x - (d.start ? d.start.x : 0); const dy = pt.y - (d.start ? d.start.y : 0);
    if (!d.moved && (Math.abs(dx) * lay.w > 4 || Math.abs(dy) * lay.h > 4 || d.kind === 'resize')) d.moved = true;
    if (!d.moved) return;
    if (d.kind === 'fix') {
      d.pos = {};
      for (const id of d.group) {
        const o = d.orig[id]; const np = { x: clamp01(o.x + dx), y: clamp01(o.y + dy) };
        d.pos[id] = np;
        const n = lay.nodes.get(id); if (n) { n.style.left = `${np.x * 100}%`; n.style.top = `${np.y * 100}%`; }
      }
    } else if (d.kind === 'shape') {
      const s = d.s; const nx = s.x + dx; const ny = s.y + dy;
      lay.draft = { ...s, x: nx, y: ny, x2: s.x2 + dx, y2: s.y2 + dy };
      paintShapes();
    } else if (d.kind === 'resize') {
      const s = d.s;
      if (s.type === 'line') lay.draft = d.h === 'p1' ? { ...s, x: pt.x, y: pt.y } : { ...s, x2: pt.x, y2: pt.y };
      else lay.draft = { ...s, w: Math.max(0.01, pt.x - s.x), h: Math.max(0.01, pt.y - s.y) };
      paintShapes();
    } else if (d.kind === 'draw') {
      const t = lay.tool;
      lay.draft = { id: '__new', type: t, color: lay.colour, fill: lay.fill, width: 2, text: '', size: 16, x: Math.min(d.start.x, pt.x), y: Math.min(d.start.y, pt.y), w: Math.abs(dx), h: Math.abs(dy), x2: pt.x, y2: pt.y };
      if (t === 'line') { lay.draft.x = d.start.x; lay.draft.y = d.start.y; }
      paintShapes();
    } else if (d.kind === 'band') {
      const x0 = Math.min(d.start.x, pt.x); const y0 = Math.min(d.start.y, pt.y);
      d.rect = { x0, y0, x1: Math.max(d.start.x, pt.x), y1: Math.max(d.start.y, pt.y) };
      Object.assign(lay.band.style, { display: 'block', left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(d.rect.x1 - x0) * 100}%`, height: `${(d.rect.y1 - y0) * 100}%` });
    }
  }

  async function layUp(e) {
    const d = lay.drag; if (!d) return;
    try { lay.canvasEl.releasePointerCapture(e.pointerId); } catch (x) { /* already released */ }
    const draft = lay.draft;
    lay.drag = null; lay.draft = null;
    lay.band.style.display = 'none';
    const selIds = show.selection.mode === 'fix' ? show.selection.ids : [];
    if (d.kind === 'fix') {
      if (d.moved) await call('setLayoutPositions', Object.entries(d.pos || {}).map(([id, p]) => ({ id, x: p.x, y: p.y })));
      else {
        let ids;
        if (d.add) ids = selIds.includes(d.id) ? selIds.filter((x) => x !== d.id) : selIds.concat(d.id);
        else ids = selIds.length === 1 && selIds[0] === d.id ? [] : [d.id];
        lay.shape = null;
        await call('setSelection', { mode: 'fix', ids });
      }
    } else if (d.kind === 'shape' || d.kind === 'resize') {
      if (draft && d.moved) await call('updateShape', draft.id, draft);
      else paintShapes();
    } else if (d.kind === 'draw') {
      const t = lay.tool;
      const tiny = !draft || (draft.w < 0.01 && draft.h < 0.01 && Math.hypot(draft.x2 - draft.x, draft.y2 - draft.y) < 0.01);
      let o = null;
      if (t === 'text') o = { type: 'text', x: d.start.x, y: d.start.y, text: 'Text', color: lay.colour, size: 20 };
      else if (!tiny) o = { ...draft, type: t };
      lay.tool = 'select';
      if (o) {
        const r = await call('addShape', o);
        if (r && r.ok) lay.shape = r.result;
      }
      renderView(true);
    } else if (d.kind === 'band') {
      if (d.moved && d.rect) {
        const inside = show.patch.filter((f) => { const p = show.layout.pos[f.id]; return p && p.x >= d.rect.x0 && p.x <= d.rect.x1 && p.y >= d.rect.y0 && p.y <= d.rect.y1; }).map((f) => f.id);
        await call('setSelection', { mode: 'fix', ids: d.add ? Array.from(new Set(selIds.concat(inside))) : inside });
      } else {
        const hadShape = !!lay.shape; lay.shape = null;
        if (!d.add && selIds.length) await call('setSelection', { mode: 'fix', ids: [] });
        else if (hadShape) { paintShapes(); drawSide(); }
      }
    }
    if (ui.pending) renderView(true);
  }

  function drawSide() {
    const L = show.layout;
    const s = show.layout.shapes.find((x) => x.id === lay.shape);
    const unplaced = show.patch.filter((f) => !L.pos[f.id]);
    const file = el('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: (e) => { pickImage(e.target.files[0]); e.target.value = ''; } });
    const parts = [
      el('h3', {}, 'Background'),
      el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => file.click() }, L.hasBg ? 'Change image…' : 'Choose image…'),
        L.hasBg ? el('button', { class: 'danger', onclick: () => call('setLayoutImage', null) }, 'Remove') : null, file),
      el('div', { class: 'hint' }, 'A stage plan, floor plan or photo. It is saved inside the show.'),
      el('label', { class: 'hint', style: 'display:flex;gap:6px;align-items:center' }, el('input', { type: 'checkbox', checked: lay.lock, onchange: (e) => { lay.lock = e.target.checked; paintShapes(); } }), 'Lock shapes (so they can\'t be dragged by accident)'),
      el('h3', { style: 'margin-top:6px' }, 'Draw'),
      el('div', { class: 'chips' }, SHAPE_TOOLS.map(([id, label]) => el('button', { class: lay.tool === id ? 'primary' : '', onclick: () => { lay.tool = id; lay.canvasEl.classList.toggle('draw', id !== 'select'); drawSide(); } }, label))),
      el('div', { class: 'row' }, el('label', {}, 'Colour'),
        el('input', { type: 'color', value: s ? s.color : lay.colour, onchange: (e) => { if (s) call('updateShape', s.id, { color: e.target.value }); else lay.colour = e.target.value; } }),
        el('label', { style: 'width:auto' }, el('input', { type: 'checkbox', checked: s ? s.fill : lay.fill, onchange: (e) => { if (s) call('updateShape', s.id, { fill: e.target.checked }); else lay.fill = e.target.checked; } }), ' Fill')),
    ];
    if (s) {
      parts.push(el('h3', { style: 'margin-top:6px' }, `Selected ${s.type}`),
        el('div', { class: 'row' }, el('label', {}, s.type === 'text' ? 'Text' : 'Label'), el('input', { type: 'text', value: s.text, style: 'flex:1', onchange: (e) => call('updateShape', s.id, { text: e.target.value }) })),
        el('div', { class: 'row' }, el('label', {}, 'Text size'), el('input', { type: 'number', min: 8, max: 96, value: s.size, style: 'width:70px', onchange: (e) => call('updateShape', s.id, { size: e.target.value }) })),
        s.type !== 'text' ? el('div', { class: 'row' }, el('label', {}, 'Line'), el('input', { type: 'number', min: 1, max: 20, value: s.width, style: 'width:70px', onchange: (e) => call('updateShape', s.id, { width: e.target.value }) })) : null,
        el('div', { class: 'row' }, el('button', { onclick: () => call('moveShape', s.id, true) }, 'Bring to front'), el('button', { onclick: () => call('moveShape', s.id, false) }, 'Send to back'),
          el('button', { class: 'danger', onclick: () => { lay.shape = null; call('removeShape', s.id); } }, 'Delete')));
    }
    parts.push(el('h3', { style: 'margin-top:6px' }, 'Fixtures', el('span', { class: 'grow' }),
      el('button', { class: ui.multi ? 'primary' : '', title: 'Tap several fixtures to select them together', onclick: () => { ui.multi = !ui.multi; drawSide(); } }, ui.multi ? 'Multi ✓' : 'Multi')));
    const lb = L.labels || { name: true, addr: true, size: 11 };
    parts.push(el('div', { class: 'row', style: 'flex-wrap:wrap' },
      el('label', { style: 'width:auto;display:flex;gap:4px;align-items:center' }, el('input', { type: 'checkbox', checked: lb.name, onchange: (e) => call('setLayoutOptions', { name: e.target.checked }) }), 'Name'),
      el('label', { style: 'width:auto;display:flex;gap:4px;align-items:center' }, el('input', { type: 'checkbox', checked: lb.addr, onchange: (e) => call('setLayoutOptions', { addr: e.target.checked }) }), 'Address'),
      el('label', { style: 'width:auto' }, 'Size'), el('input', { type: 'number', min: 8, max: 24, value: lb.size, style: 'width:60px', onchange: (e) => call('setLayoutOptions', { size: e.target.value }) })));
    if (!show.patch.length) parts.push(el('div', { class: 'hint' }, 'Patch some fixtures first.'));
    else {
      parts.push(el('div', { class: 'hint' }, unplaced.length ? `${unplaced.length} not on the layout yet. Tap one to drop it in the middle, then drag it into place.` : 'All fixtures are placed. Drag to move; drag on empty space to box-select.'));
      if (unplaced.length) {
        parts.push(el('div', { class: 'chips' }, unplaced.slice(0, 120).map((f) => el('button', { title: f.name, onclick: () => call('setLayoutPositions', [{ id: f.id, x: 0.5, y: 0.5 }]) }, String(f.num)))),
          el('div', { class: 'row' }, el('button', { class: 'primary', onclick: () => call('layoutAuto') }, 'Place all in a grid')));
      }
      const placedSel = (show.selection.mode === 'fix' ? show.selection.ids : []).filter((id) => L.pos[id]);
      parts.push(el('div', { class: 'row' },
        el('button', { disabled: !placedSel.length, onclick: () => call('removeLayoutPositions', placedSel) }, 'Take selected off'),
        el('button', { class: 'danger', disabled: !L.shapes.length, onclick: () => { lay.shape = null; call('clearShapes'); } }, 'Clear shapes')));
    }
    parts.push(el('div', { class: 'hint' }, `Selection: ${selectionText()}. Set levels and colours on the Desk tab or the command line, and the fixtures here show them live.`));
    lay.sideEl.replaceChildren(...parts.filter(Boolean));
  }

  if (!window.__layResize) { window.__layResize = true; window.addEventListener('resize', () => { if (ui.tab === 'layout' && show && !lay.drag) renderView(true); }); }

  const taps = [];
  function renderEffects() {
    const catSel = el('select', { value: fxUi.cat }, ['All'].concat(lib.categories).map((c) => el('option', { value: c }, c)));
    const search = el('input', { type: 'text', placeholder: `search ${lib.effects.length} effects: fire, police, lightning…`, value: fxUi.q, style: 'flex:1' });
    const list = el('select', { size: 12, style: 'width:100%' });
    const info = el('span', { class: 'hint' });
    const rate = el('input', { type: 'number', step: 1, min: 1, max: 1500, value: 60, style: 'width:80px' });
    const fill = () => {
      fxUi.cat = catSel.value; fxUi.q = search.value;
      const keep = list.value;
      const groups = fxGroups();
      let total = 0;
      list.replaceChildren(...Array.from(groups.entries()).map(([cat, items]) => { total += items.length; return el('optgroup', { label: cat }, items.map((e) => el('option', { value: e.id }, e.name))); }));
      if (keep && list.querySelector(`option[value="${keep}"]`)) list.value = keep; else if (total) list.selectedIndex = 0;
      info.textContent = `${total} effect${total === 1 ? '' : 's'}`;
    };
    catSel.addEventListener('change', fill);
    search.addEventListener('input', fill);
    const doAdd = () => { if (list.value) call('addEffect', { type: list.value, rate: (parseFloat(rate.value) || 60) / 60 }); };
    list.addEventListener('dblclick', doAdd);
    const add = el('div', { class: 'panel' }, el('h3', {}, 'Add effect to current selection', el('span', { class: 'grow' }), info),
      el('div', { class: 'row' }, catSel, search),
      list,
      el('div', { class: 'row', style: 'margin-top:8px' }, el('label', { style: 'width:auto' }, 'Speed BPM'), rate,
        el('button', { title: 'Tap the beat to set the speed', onclick: () => { const now = Date.now(); taps.push(now); while (taps.length && now - taps[0] > 3000) taps.shift(); if (taps.length >= 2) { rate.value = Math.round(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))); } } }, 'Tap'),
        el('button', { class: 'primary', onclick: doAdd }, 'Add effect')),
      el('div', { class: 'hint', style: 'margin-top:8px' }, `Selection: ${selectionText()}. Double-click an effect to add it. Effects ride on top of cues and the programmer, and are not recorded into cues. Film effects work on any fixture: colour ones use RGB, CCT or bi-colour channels, whichever the fixture has.`));
    fill();

    const rows = show.effects.map((e) => {
      return el('tr', {},
        el('td', {}, el('input', { type: 'checkbox', checked: e.on, onchange: (ev) => call('updateEffect', e.id, { on: ev.target.checked }) })),
        el('td', {}, el('select', { value: e.type, onchange: (ev) => call('updateEffect', e.id, { type: ev.target.value }) },
          lib.categories.map((cat) => el('optgroup', { label: cat }, lib.effects.filter((x) => x.cat === cat).map((x) => el('option', { value: x.id }, x.name)))))),
        el('td', {}, el('input', { class: 'n', type: 'number', step: 1, min: 1, max: 1500, value: Math.round(e.rate * 600) / 10, onchange: (ev) => call('updateEffect', e.id, { rate: (parseFloat(ev.target.value) || 60) / 60 }) })),
        el('td', {}, el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: e.depth, onchange: (ev) => call('updateEffect', e.id, { depth: ev.target.value }) })),
        el('td', {}, el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: e.spread, onchange: (ev) => call('updateEffect', e.id, { spread: ev.target.value }) })),
        el('td', {}, `${e.fixtureIds.length} fix`, ' ', el('button', { onclick: () => call('updateEffect', e.id, { useSelection: true }) }, 'Use selection')),
        el('td', {}, el('button', { class: 'danger', onclick: () => call('removeEffect', e.id) }, '✕')));
    });

    $('#view').replaceChildren(el('div', { class: 'stack' }, add, el('div', { class: 'panel' }, el('h3', {}, 'Running effects'),
      show.effects.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ['On', 'Effect', 'BPM', 'Depth', 'Spread', 'Fixtures', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : el('div', { class: 'hint' }, 'No effects. Select fixtures on the Desk, then add one here.'))));
  }

  // ------------------------------------------------------------------ output
  // Each card redraws on its own, so a scan finishing never wipes what you're typing in another card.
  const net = { nodes: null, scanning: false };
  const wifi = { list: null, scanning: false, note: '', msg: '', error: false, pickSsid: null, busy: false };
  const bleUi = { unnamed: false };
  const cards = {};

  function mountCard(id, build) {
    const c = el('div', { class: 'panel' });
    cards[id] = { el: c, build };
    c.replaceChildren(...build());
    return c;
  }
  function refreshCard(id) {
    const c = cards[id];
    if (c && c.el.isConnected) c.el.replaceChildren(...c.build());
  }

  async function scanNodes() {
    if (net.scanning) return;
    net.scanning = true; refreshCard('net');
    try { net.nodes = await window.desk.artnetScan(); } catch (e) { net.nodes = []; }
    net.scanning = false; refreshCard('net');
  }

  async function useNode(n) {
    const patch = { artnetDest: n.ip };
    if (n.outputs.length) patch.artnetFirst = n.outputs[0];
    if (show.settings.protocol !== 'artnet') patch.sacnUnicast = n.ip;
    await call('updateSettings', patch);
    refreshCard('net'); refreshCard('adv');
  }

  async function useBroadcast() {
    await call('updateSettings', { artnetDest: '255.255.255.255', sacnUnicast: '' });
    refreshCard('net'); refreshCard('adv');
  }

  function netCard() {
    const s = show.settings;
    const dest = s.artnetDest === '255.255.255.255' ? 'everyone on the network (broadcast)' : s.artnetDest;
    const rows = (net.nodes || []).map((n) => el('tr', {},
      el('td', {}, el('b', {}, n.shortName || n.longName || 'Art-Net node'), n.longName && n.longName !== n.shortName ? el('div', { class: 'hint' }, n.longName) : null),
      el('td', {}, n.ip),
      el('td', {}, n.outputs.length ? n.outputs.join(', ') : '–'),
      el('td', {}, el('button', { class: s.artnetDest === n.ip ? 'primary' : '', onclick: () => useNode(n) }, s.artnetDest === n.ip ? 'In use' : 'Use'))));
    let body;
    if (net.nodes && net.nodes.length) {
      body = el('table', {}, el('thead', {}, el('tr', {}, ['Node', 'Address', 'Art-Net universes', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows));
    } else {
      body = el('div', { class: 'hint' }, net.scanning ? 'Looking for Art-Net nodes…' : net.nodes ? (window.desk.native ? 'No Art-Net nodes answered. Join the lighting box\'s Wi-Fi in the iPad Settings app first, then scan again. If it is still not found, type its address under Advanced: iPadOS can hide broadcast replies from apps.' : 'No Art-Net nodes answered. Make sure this computer is on the same Wi-Fi or network as the box (join its Wi-Fi below), then scan again. Sending to everyone also works with most nodes.') : '');
    }
    return [
      el('h3', {}, 'Lighting nodes on this network', el('span', { class: 'grow' }), el('button', { class: 'primary', disabled: net.scanning, onclick: scanNodes }, net.scanning ? 'Scanning…' : 'Scan')),
      el('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Sending to: ', el('b', {}, dest)),
      body,
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { onclick: useBroadcast }, 'Send to everyone (broadcast)')),
    ];
  }

  async function scanWifi() {
    if (wifi.scanning) return;
    wifi.scanning = true; wifi.msg = ''; refreshCard('wifi');
    let r;
    try { r = await window.desk.wifiScan(); } catch (e) { r = { ok: false, message: 'Could not scan Wi-Fi' }; }
    wifi.scanning = false;
    if (r.ok) { wifi.list = r.networks; wifi.note = r.note || ''; wifi.error = false; } else { wifi.list = wifi.list || []; wifi.msg = r.message; wifi.error = true; }
    refreshCard('wifi');
  }

  async function joinWifi(ssid, password) {
    wifi.busy = true; wifi.msg = `Joining ${ssid}…`; wifi.error = false; refreshCard('wifi');
    let r;
    try { r = await window.desk.wifiConnect(ssid, password); } catch (e) { r = { ok: false, message: 'Could not join' }; }
    wifi.busy = false; wifi.pickSsid = null; wifi.msg = r.message; wifi.error = !r.ok;
    refreshCard('wifi');
    if (r.ok) setTimeout(() => { scanWifi(); scanNodes(); }, 6000);
  }

  function wifiCard() {
    const rows = (wifi.list || []).map((n) => {
      const picking = wifi.pickSsid === n.ssid;
      const pw = picking ? el('input', { type: 'password', placeholder: 'Wi-Fi password', style: 'width:150px', onkeydown: (e) => { if (e.key === 'Enter') joinWifi(n.ssid, e.target.value); } }) : null;
      return el('tr', {},
        el('td', {}, n.ssid, n.current ? el('span', { class: 'pill ok', style: 'margin-left:6px' }, 'connected') : null,
          /boulder|nomad|dmx|lumen/i.test(n.ssid) ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'lighting?') : null),
        el('td', {}, n.security === 'open' ? 'Open' : 'Secured'),
        el('td', {}, `${n.signal}%`),
        el('td', { style: 'white-space:nowrap' }, picking
          ? [pw, el('button', { class: 'primary', onclick: (e) => joinWifi(n.ssid, e.target.parentNode.querySelector('input').value) }, 'Join'), el('button', { onclick: () => { wifi.pickSsid = null; refreshCard('wifi'); } }, 'Cancel')]
          : el('button', { disabled: wifi.busy, onclick: () => { if (n.security === 'open') joinWifi(n.ssid, ''); else { wifi.pickSsid = n.ssid; refreshCard('wifi'); } } }, 'Join')));
    });
    return [
      el('h3', {}, 'Wi-Fi networks', el('span', { class: 'grow' }),
        el('button', { onclick: () => window.desk.wifiSettings() }, 'Wi-Fi settings'),
        el('button', { class: 'primary', disabled: wifi.scanning || wifi.busy, onclick: scanWifi }, wifi.scanning ? 'Scanning…' : 'Scan')),
      wifi.msg ? el('div', { class: wifi.error ? 'err-text' : 'hint', style: 'margin-bottom:8px' }, wifi.msg) : null,
      wifi.list && wifi.list.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ['Network', 'Security', 'Signal', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : el('div', { class: 'hint' }, wifi.scanning ? 'Scanning for Wi-Fi networks…' : 'No networks listed yet.'),
      wifi.note ? el('div', { class: 'hint', style: 'margin-top:6px' }, wifi.note) : null,
      el('div', { class: 'hint', style: 'margin-top:8px' }, 'Joining a lighting box’s own Wi-Fi can cut this computer off from the internet while it is connected.'),
    ].filter(Boolean);
  }

  function bleCard() {
    const s = show.settings;
    const B = window.BLE;
    if (!B || !B.supported) {
      return [el('h3', {}, 'Bluetooth'), el('div', { class: 'hint' }, 'Bluetooth is not available on this computer, or it is switched off.')];
    }
    const head = el('h3', {}, 'Bluetooth', el('span', { class: 'grow' }),
      B.connected ? el('button', { onclick: () => B.disconnect() }, 'Disconnect')
        : B.scanning ? el('button', { onclick: () => B.cancel() }, 'Cancel')
          : el('button', { class: 'primary', onclick: () => B.scan() }, 'Scan'));
    const out = [head];
    const ok = B.connected && B.ready;
    out.push(el('div', { class: ok ? '' : 'hint', style: 'margin-bottom:8px' }, ok ? el('span', {}, el('b', {}, B.name), ` – connected (${B.mode === 'dmxcat' ? 'DMXcat' : 'DMX adapter'})`) : B.status));
    if (B.scanning) {
      const all = B.devices.slice();
      const named = all.filter((d) => d.name);
      const unnamed = all.filter((d) => !d.name);
      named.sort((a, b) => (/boulder|nomad|dmx|lumen|cat/i.test(b.name) ? 1 : 0) - (/boulder|nomad|dmx|lumen|cat/i.test(a.name) ? 1 : 0) || a.name.localeCompare(b.name));
      const list = named.concat(bleUi.unnamed ? unnamed : []);
      out.push(list.length
        ? el('table', {}, el('tbody', {}, list.map((d) => el('tr', {},
          el('td', {}, d.name || 'Unnamed device', /boulder|nomad|dmx|lumen|cat/i.test(d.name) ? el('span', { class: 'pill', style: 'margin-left:6px' }, 'lighting?') : null),
          el('td', {}, el('button', { class: 'primary', onclick: () => B.choose(d.id) }, 'Connect'))))))
        : el('div', { class: 'hint' }, 'Searching for nearby Bluetooth devices… make sure the receiver is powered on.'));
      out.push(el('label', { class: 'hint', style: 'display:flex;gap:6px;margin-top:8px;align-items:center' },
        el('input', { type: 'checkbox', checked: bleUi.unnamed, onchange: (e) => { bleUi.unnamed = e.target.checked; refreshCard('ble'); } }),
        `Show unnamed devices (${unnamed.length})`));
    }
    out.push(el('div', { class: 'form', style: 'grid-template-columns:170px 1fr;margin-top:12px' },
      el('label', {}, 'Universe sent'), el('input', { type: 'number', min: 1, max: 16, value: s.bleUniverse, onchange: (e) => call('updateSettings', { bleUniverse: e.target.value }) }),
      el('label', {}, 'Packet format'), el('select', { value: s.bleFormat, onchange: (e) => call('updateSettings', { bleFormat: e.target.value }) },
        [['OFFSET', 'Offset (Nomad / Boulders receivers)'], ['PLAIN', 'Plain 513-byte stream']].map(([v, n]) => el('option', { value: v }, n)))));
    out.push(el('div', { class: 'hint', style: 'margin-top:8px' }, 'Bluetooth carries one universe and runs alongside the network output.'));
    return out;
  }

  function routeCard() {
    const s = show.settings;
    const routes = Array.from({ length: 16 }, (_, i) => Object.assign({ proto: 'default', number: null, dest: '' }, (s.routes || [])[i] || {}));
    const save = (i, patch) => { routes[i] = Object.assign({}, routes[i], patch); return call('updateSettings', { routes }); };
    const label = { artnet: 'Art-Net', sacn: 'sACN', both: 'both', default: 'default', off: 'off' };
    const rows = Array.from({ length: s.universes }, (_, i) => {
      const r = routes[i];
      const eff = r.proto === 'default' ? s.protocol : r.proto;
      const autoNum = eff === 'sacn' ? i + 1 : i + (parseInt(s.artnetFirst, 10) || 0);
      return el('tr', {},
        el('td', {}, `Desk ${i + 1}`),
        el('td', {}, el('select', { value: r.proto, onchange: (e) => save(i, { proto: e.target.value }) },
          [['default', `Default (${label[s.protocol]})`], ['artnet', 'Art-Net'], ['sacn', 'sACN'], ['both', 'Art-Net + sACN'], ['off', 'Off']].map(([v, n]) => el('option', { value: v }, n)))),
        el('td', {}, el('input', { class: 'n', type: 'number', min: 0, max: 63999, value: r.number == null ? '' : r.number, placeholder: String(autoNum), onchange: (e) => save(i, { number: e.target.value }) })),
        el('td', {}, el('input', { type: 'text', value: r.dest, placeholder: '(default)', onchange: (e) => save(i, { dest: e.target.value }) })));
    });
    return [
      el('h3', {}, 'Universe routing', el('span', { class: 'grow' }),
        el('button', { class: 'primary', title: 'Everything that is Art-Net becomes sACN, and the other way round', onclick: async () => { const r = await call('swapProtocols'); if (r && r.ok) setFeedback(`Now sending ${r.result === 'sacn' ? 'sACN' : 'Art-Net'} by default`); } }, 'Swap Art-Net ⇄ sACN')),
      el('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Desk universes are virtual. Send each one as Art-Net or sACN, to any universe number and any address. Blank fields use the settings below.'),
      el('table', {}, el('thead', {}, el('tr', {}, ['Desk universe', 'Send as', 'Universe no.', 'Send to'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)),
    ];
  }

  function advCard() {
    const s = show.settings;
    const field = (label, input, hint) => [el('label', {}, label), el('div', {}, input, hint ? el('div', { class: 'hint' }, hint) : null)];
    const set = (k) => (e) => call('updateSettings', { [k]: e.target.value });
    return [el('h3', {}, 'Network output settings'),
      el('div', { class: 'form', style: 'grid-template-columns:150px 1fr' },
        ...field('Protocol', el('select', { value: s.protocol, onchange: set('protocol') }, [['artnet', 'Art-Net'], ['sacn', 'sACN (E1.31)'], ['both', 'Art-Net + sACN']].map(([v, n]) => el('option', { value: v }, n)))),
        ...field('Universes', el('input', { type: 'number', min: 1, max: 16, value: s.universes, onchange: set('universes') }), 'How many universes to output (512 channels each).'),
        ...field('Art-Net destination', el('input', { type: 'text', value: s.artnetDest, onchange: (e) => { call('updateSettings', { artnetDest: e.target.value }).then(() => refreshCard('net')); } }), 'Filled in for you when you pick a node above. 255.255.255.255 = everyone.'),
        ...field('First Art-Net universe', el('input', { type: 'number', min: 0, max: 32000, value: s.artnetFirst, onchange: set('artnetFirst') }), 'The Art-Net universe number desk universe 1 sends to (usually 0, or 1 on some nodes).'),
        ...field('sACN unicast IP', el('input', { type: 'text', value: s.sacnUnicast, placeholder: '(blank = multicast)', onchange: set('sacnUnicast') })),
        ...field('sACN priority', el('input', { type: 'number', min: 0, max: 200, value: s.sacnPriority, onchange: set('sacnPriority') })),
        ...field('Send from interface', el('input', { type: 'text', value: s.bindIp, placeholder: '(automatic)', onchange: set('bindIp') }), 'Optional: this computer’s IP on the lighting network (useful with several adapters).'),
        ...field('Refresh rate', el('input', { type: 'number', min: 1, max: 44, value: s.fps, onchange: set('fps') }), 'Frames per second (30 is typical, 44 max).')),
      el('div', { class: 'hint', style: 'margin-top:14px' }, 'Show files: File menu → Save as… / Open…. The current show also auto-saves and reopens next launch.')];
  }

  function remoteCard() {
    const st = { info: null, msg: '' };
    const card = el('div', { class: 'panel' });
    const draw = () => {
      const i = st.info;
      if (!i) { card.replaceChildren(el('h3', {}, 'iPad / phone remote'), el('div', { class: 'hint' }, 'Loading…')); return; }
      const url = i.addresses.length ? `http://${i.addresses[0]}:${i.port}` : '';
      card.replaceChildren(...[el('h3', {}, 'iPad / phone remote', el('span', { class: 'grow' }), el('span', { class: `pill${i.running ? ' ok' : ''}` }, i.running ? `on · ${i.clients} connected` : 'off')),
        el('div', { class: 'hint', style: 'margin-bottom:8px' }, 'Control this desk from an iPad, phone or any browser on the same Wi-Fi. This computer keeps sending the DMX, so leave it running.'),
        el('div', { class: 'row' }, el('button', { class: i.running ? '' : 'primary', onclick: async () => { const r = await window.desk.remoteSet({ enabled: !i.running }); st.msg = r && !r.ok ? r.message : ''; await load(); } }, i.running ? 'Turn off' : 'Turn on')),
        i.running ? el('div', { class: 'stack', style: 'margin-top:10px;gap:8px' },
          el('div', {}, 'On the iPad, open Safari and go to:'),
          ...i.addresses.map((a) => el('div', { style: 'font:16px ui-monospace,Consolas,monospace;color:var(--accent2)' }, `http://${a}:${i.port}`)),
          el('div', {}, 'PIN: ', el('b', { style: 'font:18px ui-monospace,Consolas,monospace;letter-spacing:.2em' }, i.pin), ' ', el('button', { onclick: async () => { await window.desk.remoteSet({ newPin: true, enabled: true }); await load(); } }, 'New PIN')),
          el('div', { class: 'hint' }, 'Tip: in Safari tap Share, then Add to Home Screen, to open it full screen like an app. Anyone on your network with the PIN can control the lights, and the connection is not encrypted, so use it on your own network.'),
          !url ? el('div', { class: 'hint' }, 'No network address found. Join a Wi-Fi network first.') : null) : null,
        st.msg ? el('div', { class: 'err-text', style: 'margin-top:8px' }, st.msg) : null].filter(Boolean));
    };
    const load = async () => { st.info = await window.desk.remoteInfo(); draw(); };
    draw(); load();
    return card;
  }

  function renderOutput() {
    if (window.desk.remote) {
      $('#view').replaceChildren(el('div', { class: 'panel', style: 'max-width:780px' }, el('h3', {}, 'Output'),
        el('div', { class: 'hint' }, 'You are controlling the desk remotely. Network and Bluetooth output are set up on the computer running Nomad DMX Desk.')));
      return;
    }
    if (window.desk.native) {
      $('#view').replaceChildren(el('div', { class: 'stack', style: 'max-width:780px' },
        el('div', { class: 'panel' }, el('h3', {}, 'iPad'),
          el('div', { class: 'hint' }, 'Keep this app open on screen while the lights are running: iPadOS pauses apps in the background, which stops the DMX. The iPad is kept awake while the app is open.'),
          el('div', { class: 'hint', style: 'margin-top:6px' }, 'Wi-Fi is chosen in the iPad Settings app. sACN multicast is not available on iPad (Apple restricts it), so use Art-Net or sACN to a node\'s address.')),
        mountCard('net', netCard), mountCard('route', routeCard), mountCard('ble', bleCard), mountCard('adv', advCard)));
      if (net.nodes == null && !net.scanning) scanNodes();
      return;
    }
    $('#view').replaceChildren(el('div', { class: 'stack', style: 'max-width:780px' },
      mountCard('net', netCard), mountCard('wifi', wifiCard), mountCard('route', routeCard), mountCard('ble', bleCard), remoteCard(), mountCard('adv', advCard)));
    if (net.nodes == null && !net.scanning) scanNodes();
    if (wifi.list == null && !wifi.scanning) scanWifi();
  }

  // --------------------------------------------------------------- rendering
  function isEditing() {
    const a = document.activeElement;
    return !!a && $('#view').contains(a) && (a.tagName === 'SELECT' || (a.tagName === 'INPUT' && ['text', 'number'].includes(a.type)));
  }

  // Signature of everything that needs a full redraw. Plain value edits (sliders, text fields)
  // don't change it, so the controls under the user's hand are never rebuilt mid-edit.
  function viewSig(s) {
    return JSON.stringify([
      s.patch.map((f) => f.id), s.cues.map((c) => c.id + ':' + Object.keys(c.values).length), s.effects.map((e) => e.id + ':' + e.fixtureIds.join('.')),
      s.profiles.map((p) => p.id + p.name + p.channels.length), s.layout, s.selection, s.currentUniverse, s.conflicts, s.currentCue, s.settings.universes, s.name,
    ]);
  }

  function renderView(force) {
    if (!show) return;
    if (!force && (isEditing() || lay.drag)) { ui.pending = true; return; }
    ui.pending = false;
    ui.sig = viewSig(show);
    switch (ui.tab) {
      case 'patch': renderPatch(); break;
      case 'cues': renderCues(); break;
      case 'effects': renderEffects(); break;
      case 'layout': renderLayout(); break;
      case 'output': renderOutput(); break;
      default: renderDesk();
    }
  }

  // -------------------------------------------------------------------- live
  function fixtureColour(f, out) {
    const p = profileOf(f);
    const u = out[f.universe - 1];
    if (!p || !u) return '#000';
    let r = 0; let g = 0; let b = 0; let dim = null; let any = false; let cct = null;
    p.channels.forEach((c, i) => {
      const ch = f.address - 1 + i;
      if (ch < 0 || ch > 511) return;
      const v = u[ch] / 255;
      switch (c.type) {
        case 'dimmer': dim = v; break;
        case 'red': r += v; any = true; break;
        case 'green': g += v; any = true; break;
        case 'blue': b += v; any = true; break;
        case 'white': r += v; g += v; b += v; any = true; break;
        case 'warm': r += v; g += v * 0.78; b += v * 0.5; any = true; break;
        case 'cool': r += v * 0.8; g += v * 0.9; b += v; any = true; break;
        case 'amber': r += v; g += v * 0.75; any = true; break;
        case 'uv': r += v * 0.4; b += v * 0.9; any = true; break;
        case 'cct': cct = v; break;
        default:
      }
    });
    if (!any && dim == null && cct == null) return '#000';
    if (!any) { if (cct != null) { r = 1 - 0.22 * cct; g = 0.58 + 0.3 * cct; b = 0.2 + 0.8 * cct; } else { r = 1; g = 1; b = 1; } }
    const k = dim == null ? 1 : dim;
    const c8 = (x) => Math.round(Math.min(1, x) * k * 255);
    return `rgb(${c8(r)},${c8(g)},${c8(b)})`;
  }

  function updateLive() {
    if (!show) return;
    const out = live.out || [];
    if (ui.tab === 'desk') {
      if (ui.deskView === 'channels' && ui.cells.length) {
        const u = out[show.currentUniverse - 1];
        const prog = new Set((live.status.programmer || []).filter((k) => Math.floor(k / 512) === show.currentUniverse - 1).map((k) => k % 512));
        ui.cells.forEach((c, i) => {
          const v = u ? u[i] : 0;
          c.v.textContent = v;
          c.cell.style.setProperty('--v', `${Math.round((v / 255) * 100)}%`);
          c.cell.classList.toggle('prog', prog.has(i));
        });
      }
      for (const [id, sw] of ui.tiles) {
        const f = show.patch.find((x) => x.id === id);
        if (f) sw.style.background = fixtureColour(f, out);
      }
      if (ui.intensity && document.activeElement !== ui.intensity.input) {
        let v = 0;
        if (show.selection.mode === 'ch') {
          const u = out[show.selection.universe - 1];
          if (u && show.selection.channels.length) v = u[show.selection.channels[0] - 1];
        } else {
          const f = selFixtures()[0];
          const p = f && profileOf(f);
          const u = f && out[f.universe - 1];
          if (p && u) {
            const vals = p.channels.map((c, i) => ({ t: c.type, v: u[f.address - 1 + i] || 0 }));
            const d = vals.find((x) => x.t === 'dimmer');
            v = d ? d.v : Math.max(0, ...vals.filter((x) => ['red', 'green', 'blue', 'white', 'warm', 'cool', 'amber', 'uv'].includes(x.t)).map((x) => x.v));
          }
        }
        ui.intensity.input.value = Math.round((v / 255) * 100);
        ui.intensity.val.textContent = ui.intensity.input.value;
      }
    }
    if (ui.tab === 'layout') {
      for (const [id, node] of lay.nodes) {
        const f = show.patch.find((x) => x.id === id);
        if (f) node.style.background = fixtureColour(f, out);
      }
    }
    const s = show.settings;
    const proto = s.protocol === 'both' ? 'Art-Net + sACN' : s.protocol === 'sacn' ? 'sACN' : 'Art-Net';
    const dest = s.protocol === 'sacn' ? (s.sacnUnicast || 'multicast') : s.artnetDest;
    const st = $('#statusline');
    st.replaceChildren(...[
      el('span', {}, `${proto} → ${dest}`), el('span', {}, `${s.universes} universe${s.universes > 1 ? 's' : ''} @ ${s.fps} fps`),
      el('span', {}, `${live.status.packets} packets`),
      live.status.lastError ? el('span', { class: 'err-text' }, live.status.lastError) : null,
      window.BLE && window.BLE.connected && window.BLE.ready ? el('span', {}, `Bluetooth: ${window.BLE.name}`) : null,
      live.status.fading ? el('span', {}, 'fading…') : null,
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------- input
  const history = []; let histPos = 0;
  function wireCommandLine() {
    const cmd = $('#cmd');
    cmd.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const text = cmd.value.trim();
        if (!text) return;
        history.push(text); histPos = history.length;
        cmd.value = '';
        const r = await call('execute', text);
        setFeedback(r.message, !r.ok);
      } else if (e.key === 'ArrowUp') {
        if (histPos > 0) { histPos--; cmd.value = history[histPos]; } e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        if (histPos < history.length - 1) { histPos++; cmd.value = history[histPos]; } else { histPos = history.length; cmd.value = ''; } e.preventDefault();
      } else if (e.key === 'Escape') {
        cmd.value = ''; cmd.blur();
      }
    });
    document.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      const typing = a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); doGo(); return; }
      if (e.key === 'Escape') { call('clearAll'); return; }
      if (e.key.length === 1) cmd.focus(); // start typing a command
    });
    $('#gm').addEventListener('input', throttle(() => call('setMaster', parseInt($('#gm').value, 10)), 30));
    $('#bo').addEventListener('click', () => call('setBlackout', null));
    $('#view').addEventListener('focusout', (e) => {
      if (!ui.pending) return;
      const to = e.relatedTarget;
      if (to && $('#view').contains(to)) return;
      setTimeout(() => { if (ui.pending && !isEditing()) renderView(true); }, 300);
    });
  }

  // -------------------------------------------------------------------- boot
  async function boot() {
    wireCommandLine();
    window.desk.onShow((s) => {
      const changed = !show || viewSig(s) !== ui.sig;
      show = s;
      renderCueBar(); renderMaster();
      if (changed) renderView(false);
    });
    window.desk.onLive((l) => {
      live = l; updateLive();
      if (window.BLE && window.BLE.connected && window.BLE.ready) window.BLE.send(l.out[(show.settings.bleUniverse || 1) - 1], show.settings.bleFormat);
    });
    if (window.BLE) window.BLE.onChange = () => { refreshCard('ble'); updateLive(); };
    show = await window.desk.api('getShow');
    try { lib = await window.desk.api('getLibrary'); } catch (e) { /* library optional */ }
    renderTabs(); renderCueBar(); renderMaster(); renderView(true);
  }

  boot();
})();

// Apple Pencil fallback. Some iPad web views deliver Pencil touches as pointer events but never
// turn them into clicks or slider moves. This turns a pen tap into a click and lets the pen drag sliders.
(function penFallback() {
  let down = null, clicked = false;
  document.addEventListener('click', () => { clicked = true; }, true);
  const setRange = (r, e) => {
    const b = r.getBoundingClientRect();
    const min = parseFloat(r.min || 0), max = parseFloat(r.max || 100), step = parseFloat(r.step || 1);
    let v = min + Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)) * (max - min);
    v = Math.round(v / step) * step;
    if (String(v) !== r.value) { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'pen') return;
    clicked = false;
    const range = e.target.closest && e.target.closest('input[type=range]');
    down = { x: e.clientX, y: e.clientY, t: e.target, range: range && !range.disabled ? range : null };
    if (down.range) setRange(down.range, e);
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (down && down.range && e.pointerType === 'pen') setRange(down.range, e);
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (!down || e.pointerType !== 'pen') return;
    const d = down; down = null;
    if (d.range) { d.range.dispatchEvent(new Event('change', { bubbles: true })); return; }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const target = document.elementFromPoint(e.clientX, e.clientY) || d.t;
    if (target.closest && target.closest('.lay-canvas')) return;   // layout uses pointer events itself
    setTimeout(() => {
      if (clicked) return;
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName) && target.type !== 'checkbox' && target.type !== 'button') target.focus();
      else target.click();
    }, 60);
  }, true);
})();
