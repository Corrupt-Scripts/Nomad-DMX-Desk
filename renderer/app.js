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
  let live = { out: [], status: { packets: 0, lastError: '', current: -1, fading: false, programmer: [] } };
  const ui = { tab: 'desk', deskView: 'fixtures', anchor: null, pending: false, profileEdit: null, cells: [], tiles: new Map(), intensity: null, recNum: null };

  const TABS = [['desk', 'Desk'], ['patch', 'Patch'], ['cues', 'Cues'], ['effects', 'Effects'], ['output', 'Output']];

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
    } else if (e.ctrlKey || e.metaKey) {
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
    } else if (e.ctrlKey || e.metaKey) {
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

    ['white', 'warm', 'cool', 'amber', 'uv', 'pan', 'tilt', 'other'].filter((t) => types.has(t)).forEach((t) => {
      const val = el('span', { class: 'val' }, '–');
      const r = el('input', { type: 'range', min: 0, max: 255, value: 0 });
      r.addEventListener('input', throttle(() => { val.textContent = r.value; call('setParam', t, parseInt(r.value, 10)); }, 30));
      rows.push(el('div', { class: 'row' }, el('label', {}, t[0].toUpperCase() + t.slice(1)), r, val));
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

    const profSel = el('select', { value: show.profiles[0].id }, show.profiles.map((p) => el('option', { value: p.id }, p.name)));
    const count = el('input', { type: 'number', min: 1, max: 256, value: 1 });
    const uni = el('input', { type: 'number', min: 1, max: 16, value: show.currentUniverse });
    const addr = el('input', { type: 'number', min: 1, max: 512, value: 1 });
    const name = el('input', { type: 'text', placeholder: '(profile name)' });
    const add = el('div', { class: 'panel' }, el('h3', {}, 'Add fixtures'),
      el('div', { class: 'form' },
        el('label', {}, 'Profile'), profSel, el('label', {}, 'Quantity'), count,
        el('label', {}, 'Universe'), uni, el('label', {}, 'Start address'), addr, el('label', {}, 'Name'), name,
        el('span'), el('button', { class: 'primary', onclick: () => call('addFixtures', { profileId: profSel.value, count: count.value, universe: uni.value, address: addr.value, name: name.value }) }, 'Patch')),
      el('div', { class: 'hint', style: 'margin-top:8px' }, 'Quantity > 1 patches them back to back, rolling to the next universe when one fills.'));

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
    const rows = show.profiles.map((p) => el('tr', {},
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
  function renderEffects() {
    const typeSel = el('select', { value: 'sine' }, [['sine', 'Sine fade'], ['pulse', 'Pulse (on/off)'], ['strobe', 'Strobe'], ['chase', 'Chase'], ['rainbow', 'Rainbow (RGB)']].map(([v, n]) => el('option', { value: v }, n)));
    const rate = el('input', { type: 'number', step: 0.1, min: 0.05, max: 25, value: 1, style: 'width:70px' });
    const add = el('div', { class: 'panel' }, el('h3', {}, 'Add effect to current selection'),
      el('div', { class: 'row' }, typeSel, el('label', { style: 'width:auto' }, 'Rate Hz'), rate,
        el('button', { class: 'primary', onclick: () => call('addEffect', { type: typeSel.value, rate: parseFloat(rate.value) || 1 }) }, 'Add')),
      el('div', { class: 'hint', style: 'margin-top:8px' }, `Selection: ${selectionText()}. Effects ride on top of cues and the programmer, and are not recorded into cues.`));

    const rows = show.effects.map((e) => el('tr', {},
      el('td', {}, el('input', { type: 'checkbox', checked: e.on, onchange: (ev) => call('updateEffect', e.id, { on: ev.target.checked }) })),
      el('td', {}, el('select', { value: e.type, onchange: (ev) => call('updateEffect', e.id, { type: ev.target.value }) }, ['sine', 'pulse', 'strobe', 'chase', 'rainbow'].map((t) => el('option', { value: t }, t)))),
      el('td', {}, el('input', { class: 'n', type: 'number', step: 0.1, value: e.rate, onchange: (ev) => call('updateEffect', e.id, { rate: ev.target.value }) })),
      el('td', {}, el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: e.depth, onchange: (ev) => call('updateEffect', e.id, { depth: ev.target.value }) })),
      el('td', {}, el('input', { type: 'range', min: 0, max: 1, step: 0.05, value: e.spread, onchange: (ev) => call('updateEffect', e.id, { spread: ev.target.value }) })),
      el('td', {}, `${e.fixtureIds.length} fix`, ' ', el('button', { onclick: () => call('updateEffect', e.id, { useSelection: true }) }, 'Use selection')),
      el('td', {}, el('button', { class: 'danger', onclick: () => call('removeEffect', e.id) }, '✕'))));

    $('#view').replaceChildren(el('div', { class: 'stack' }, add, el('div', { class: 'panel' }, el('h3', {}, 'Running effects'),
      show.effects.length
        ? el('table', {}, el('thead', {}, el('tr', {}, ['On', 'Type', 'Rate Hz', 'Depth', 'Spread', 'Fixtures', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows))
        : el('div', { class: 'hint' }, 'No effects. Select fixtures on the Desk, then add one here.'))));
  }

  // ------------------------------------------------------------------ output
  function renderOutput() {
    const s = show.settings;
    const field = (label, input, hint) => [el('label', {}, label), el('div', {}, input, hint ? el('div', { class: 'hint' }, hint) : null)];
    const set = (k) => (e) => call('updateSettings', { [k]: e.target.value });
    $('#view').replaceChildren(el('div', { class: 'panel', style: 'max-width:680px' }, el('h3', {}, 'DMX output'),
      el('div', { class: 'form', style: 'grid-template-columns:150px 1fr' },
        ...field('Protocol', el('select', { value: s.protocol, onchange: set('protocol') }, [['artnet', 'Art-Net'], ['sacn', 'sACN (E1.31)'], ['both', 'Art-Net + sACN']].map(([v, n]) => el('option', { value: v }, n)))),
        ...field('Universes', el('input', { type: 'number', min: 1, max: 16, value: s.universes, onchange: set('universes') }), 'How many universes to output (512 channels each).'),
        ...field('Art-Net destination', el('input', { type: 'text', value: s.artnetDest, onchange: set('artnetDest') }), 'Broadcast (255.255.255.255) or the unicast IP of your node, e.g. a Boulder Box at 192.168.4.1.'),
        ...field('Art-Net numbering', el('select', { value: String(s.artnetFirst), onchange: set('artnetFirst') }, [['0', 'Desk universe 1 = Art-Net universe 0'], ['1', 'Desk universe 1 = Art-Net universe 1']].map(([v, n]) => el('option', { value: v }, n))), 'Change this if your node expects a different base.'),
        ...field('sACN unicast IP', el('input', { type: 'text', value: s.sacnUnicast, placeholder: '(blank = multicast)', onchange: set('sacnUnicast') })),
        ...field('sACN priority', el('input', { type: 'number', min: 0, max: 200, value: s.sacnPriority, onchange: set('sacnPriority') })),
        ...field('Send from interface', el('input', { type: 'text', value: s.bindIp, placeholder: '(automatic)', onchange: set('bindIp') }), 'Optional: this computer’s IP on the lighting network (useful with several adapters).'),
        ...field('Refresh rate', el('input', { type: 'number', min: 1, max: 44, value: s.fps, onchange: set('fps') }), 'Frames per second (30 is typical, 44 max).')),
      el('div', { class: 'hint', style: 'margin-top:14px' }, 'Show files: File menu → Save as… / Open…. The current show also auto-saves and reopens next launch.')));
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
      s.profiles.map((p) => p.id + p.name + p.channels.length), s.selection, s.currentUniverse, s.conflicts, s.currentCue, s.settings.universes, s.name,
    ]);
  }

  function renderView(force) {
    if (!show) return;
    if (!force && isEditing()) { ui.pending = true; return; }
    ui.pending = false;
    ui.sig = viewSig(show);
    switch (ui.tab) {
      case 'patch': renderPatch(); break;
      case 'cues': renderCues(); break;
      case 'effects': renderEffects(); break;
      case 'output': renderOutput(); break;
      default: renderDesk();
    }
  }

  // -------------------------------------------------------------------- live
  function fixtureColour(f, out) {
    const p = profileOf(f);
    const u = out[f.universe - 1];
    if (!p || !u) return '#000';
    let r = 0; let g = 0; let b = 0; let dim = null; let any = false;
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
        default:
      }
    });
    if (!any && dim == null) return '#000';
    if (!any) { r = 1; g = 1; b = 1; }
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
    const s = show.settings;
    const proto = s.protocol === 'both' ? 'Art-Net + sACN' : s.protocol === 'sacn' ? 'sACN' : 'Art-Net';
    const dest = s.protocol === 'sacn' ? (s.sacnUnicast || 'multicast') : s.artnetDest;
    const st = $('#statusline');
    st.replaceChildren(...[
      el('span', {}, `${proto} → ${dest}`), el('span', {}, `${s.universes} universe${s.universes > 1 ? 's' : ''} @ ${s.fps} fps`),
      el('span', {}, `${live.status.packets} packets`),
      live.status.lastError ? el('span', { class: 'err-text' }, live.status.lastError) : null,
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
    window.desk.onLive((l) => { live = l; updateLive(); });
    show = await window.desk.api('getShow');
    renderTabs(); renderCueBar(); renderMaster(); renderView(true);
  }

  boot();
})();
