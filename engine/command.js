'use strict';
// Command-line parser. Produces plain action objects; the engine executes them.
//
//   1 thru 10 @ 50        channels 1-10 to 50%
//   1 + 5 + 9 @ full      channels 1, 5 and 9 to full
//   1 thru 10 - 5 @ 0     channels 1-10 except 5
//   u2 1 thru 4 @ 75      universe 2, channels 1-4
//   fix 1 thru 4 @ 50     fixtures 1-4 (patch numbers)
//   @ 30                  selection to 30%
//   colour red | #ff8800 | 255 128 0
//   clear | release | blackout [on|off] | master 80
//   go | back | stop | goto 3
//   record cue 5 [time 3] [label Walk in]   delete cue 5

const COLOURS = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], white: [255, 255, 255],
  amber: [255, 191, 0], orange: [255, 110, 0], yellow: [255, 220, 0], cyan: [0, 255, 255],
  magenta: [255, 0, 255], purple: [140, 0, 255], pink: [255, 80, 160], lime: [130, 255, 0],
  warm: [255, 190, 120], cool: [190, 220, 255], off: [0, 0, 0],
};

function tokenise(s) {
  const out = [];
  const re = /#[0-9a-f]{6}|\d+(?:\.\d+)?|[a-z]+|[@+\-<>]/gi;
  let m;
  while ((m = re.exec(s))) out.push(m[0].toLowerCase());
  return out;
}

class Cursor {
  constructor(t) { this.t = t; this.i = 0; }
  peek() { return this.t[this.i]; }
  next() { return this.t[this.i++]; }
  done() { return this.i >= this.t.length; }
}

const isNum = (x) => x != null && /^\d+(\.\d+)?$/.test(x);

function parseLevel(c) {
  const t = c.next();
  if (t === 'full') return 100;
  if (t === 'out') return 0;
  if (t === 'half') return 50;
  if (isNum(t)) return Math.max(0, Math.min(100, parseFloat(t)));
  throw new Error('Expected a level (0-100, full or out) after @');
}

function parseSelection(c, mode, universe) {
  const ops = [];
  let op = 'add';
  for (;;) {
    const a = c.next();
    if (!isNum(a)) throw new Error('Expected a number');
    let from = parseInt(a, 10);
    let to = from;
    if (c.peek() === 'thru' || c.peek() === 'through' || c.peek() === '>') {
      c.next();
      const b = c.next();
      if (!isNum(b)) throw new Error('Expected a number after thru');
      to = parseInt(b, 10);
    }
    ops.push({ op, from: Math.min(from, to), to: Math.max(from, to) });
    if (c.peek() === '+') { c.next(); op = 'add'; continue; }
    if (c.peek() === '-') { c.next(); op = 'remove'; continue; }
    break;
  }
  let level = null;
  if (c.peek() === '@') { c.next(); level = parseLevel(c); }
  if (!c.done()) throw new Error(`Unexpected "${c.peek()}"`);
  return { type: 'select', mode, universe, ops, level };
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Empty command');

  let m = raw.match(/^rec(?:ord)?\s+cue\s+(\d+(?:\.\d+)?)(?:\s+time\s+(\d+(?:\.\d+)?))?(?:\s+(?:label\s+)?(.+))?$/i);
  if (m) return { type: 'record', number: parseFloat(m[1]), fade: m[2] != null ? parseFloat(m[2]) : null, label: m[3] ? m[3].trim() : null };
  if (/^rec(?:ord)?\b/i.test(raw)) throw new Error('Usage: record cue <number> [time <seconds>] [label <text>]');
  m = raw.match(/^del(?:ete)?\s+cue\s+(\d+(?:\.\d+)?)$/i);
  if (m) return { type: 'deleteCue', number: parseFloat(m[1]) };

  const c = new Cursor(tokenise(raw));
  const first = c.peek();

  switch (first) {
    case 'clear': case 'clr': c.next(); return { type: 'clear' };
    case 'release': case 'rel': c.next(); return { type: 'release' };
    case 'blackout': case 'bo': {
      c.next();
      const v = c.next();
      return { type: 'blackout', on: v === 'on' ? true : v === 'off' ? false : null };
    }
    case 'master': case 'gm': {
      c.next();
      const v = c.next();
      if (!isNum(v)) throw new Error('Usage: master <0-100>');
      return { type: 'master', level: Math.max(0, Math.min(100, parseFloat(v))) };
    }
    case 'go': c.next(); return { type: 'go' };
    case 'back': c.next(); return { type: 'back' };
    case 'stop': c.next(); return { type: 'stop' };
    case 'goto': {
      c.next();
      const v = c.next();
      if (!isNum(v)) throw new Error('Usage: goto <cue number>');
      return { type: 'goto', number: parseFloat(v) };
    }
    case 'colour': case 'color': case 'col': {
      c.next();
      const a = c.next();
      if (a && a[0] === '#') {
        return { type: 'colour', rgb: [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)] };
      }
      if (a && COLOURS[a]) return { type: 'colour', rgb: COLOURS[a].slice() };
      if (isNum(a)) {
        const g = c.next(); const b = c.next();
        if (!isNum(g) || !isNum(b)) throw new Error('Usage: colour <name> | #rrggbb | r g b');
        return { type: 'colour', rgb: [a, g, b].map((x) => Math.max(0, Math.min(255, parseInt(x, 10)))) };
      }
      throw new Error('Unknown colour. Try red, green, blue, white, amber, cyan, magenta, #rrggbb or r g b');
    }
    case '@': {
      c.next();
      const level = parseLevel(c);
      if (!c.done()) throw new Error(`Unexpected "${c.peek()}"`);
      return { type: 'level', level };
    }
    case 'fix': case 'fixture': case 'f':
      c.next();
      return parseSelection(c, 'fix', null);
    case 'universe': case 'u': {
      c.next();
      const n = c.next();
      if (!isNum(n)) throw new Error('Usage: universe <number>');
      const uni = parseInt(n, 10);
      if (c.done()) return { type: 'universe', n: uni };
      return parseSelection(c, 'ch', uni);
    }
    default:
      if (isNum(first)) return parseSelection(c, 'ch', null);
      throw new Error(`Unknown command "${first}"`);
  }
}

module.exports = { parseCommand, tokenise, COLOURS };
