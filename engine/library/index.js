'use strict';
// Film / studio fixture library, generated from Open Fixture Library data (see THIRD_PARTY_NOTICES.md).
const data = require('./film-ofl.json');

const byId = new Map();
const index = [];
for (const p of data.profiles) {
  const name = `${p.manufacturer} ${p.fixture} - ${p.mode}`;
  byId.set(p.id, { id: p.id, name, manufacturer: p.manufacturer, fixture: p.fixture, mode: p.mode, library: true, channels: p.channels });
  index.push({ id: p.id, m: p.manufacturer, f: p.fixture, mode: p.mode, n: p.channels.length });
}
index.sort((a, b) => a.m.localeCompare(b.m) || a.f.localeCompare(b.f) || a.n - b.n || a.mode.localeCompare(b.mode));

module.exports = { byId, index, source: data.source };
