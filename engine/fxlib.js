'use strict';
// Effect library. Every effect is a pure function of time and fixture position, so the same
// show always looks the same and the whole library can be tested without any hardware.
//
//   fn(c) -> number               intensity 0..1
//         -> { a, c:[r,g,b], k }  a = intensity 0..1 (default 1), c = colour 0..1, k = colour temp 0 (warm) .. 1 (cool)
//
//   c.t   time in cycles (seconds x rate)       c.o  this fixture's phase offset in cycles (spread applied)
//   c.i   fixture index   c.n  fixture count    c.p  position 0..1 across the selection (0.5 if one fixture)
//   c.s   per-fixture random seed

const TAU = Math.PI * 2;
const fr = (x) => x - Math.floor(x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const mix = (a, b, u) => a + (b - a) * u;
const tri = (x) => { const f = fr(x); return f < 0.5 ? f * 2 : 2 - f * 2; };

function hash(n) {
  n = Math.imul(n ^ (n >>> 15), 2246822519);
  n = Math.imul(n ^ (n >>> 13), 3266489917);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
const h2 = (a, b) => hash(Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + 0x1234567);
const noise = (x, s) => { const i = Math.floor(x); const f = x - i; const u = f * f * (3 - 2 * f); return mix(h2(i, s), h2(i + 1, s), u); };
const fbm = (x, s) => noise(x, s) * 0.6 + noise(x * 2.3, s + 17) * 0.3 + noise(x * 5.1, s + 31) * 0.1;
// Random event in time slots: returns 0..1 progress through the event, or -1 when this slot is quiet.
const evt = (t, per, seed, prob) => { const x = t / per; const s = Math.floor(x); return h2(s, seed) < prob ? x - s : -1; };

function hsv(h, s, v) {
  h = fr(h);
  const i = Math.floor(h * 6); const f = h * 6 - i;
  const p = v * (1 - s); const q = v * (1 - f * s); const u = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, u, p]; case 1: return [q, v, p]; case 2: return [p, v, u];
    case 3: return [p, q, v]; case 4: return [u, p, v]; default: return [v, p, q];
  }
}
// Approximate colour of white light at "k" (0 = 2700K tungsten .. 1 = 8000K cool daylight).
const kRgb = (k) => [mix(1, 0.78, k), mix(0.58, 0.88, k), mix(0.2, 1, k)];
const lerpC = (a, b, u) => [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u)];
const scaleC = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
// Pick from a palette with optional blending: pal(list, x, soft) where x is in cycles.
const pal = (list, x, soft) => {
  const n = list.length; const f = fr(x) * n; const i = Math.floor(f);
  if (!soft) return list[i % n];
  return lerpC(list[i % n], list[(i + 1) % n], sstep(0, 1, f - i));
};

const RED = [1, 0, 0]; const GRN = [0, 1, 0]; const BLU = [0, 0, 1]; const WHT = [1, 1, 1];
const CYN = [0, 1, 1]; const MAG = [1, 0, 1]; const YEL = [1, 1, 0]; const ORG = [1, 0.4, 0]; const AMB = [1, 0.6, 0.05];
const PNK = [1, 0.3, 0.6]; const PUR = [0.5, 0, 1]; const TEAL = [0, 0.8, 0.6]; const SKY = [0.2, 0.55, 1];

// Position helpers for chases.
const centre = (c) => Math.abs(c.p - 0.5) * 2; // 0 in the middle, 1 at the ends
const step = (c, mul) => Math.floor(fr(c.t * (mul || 1)) * c.n);
const pingpong = (c) => { const f = tri(c.t * 0.5) * (c.n - 1); return f; };

const FX = [];
const def = (cat, id, name, fn) => FX.push({ id, cat, name, fn });

// ============================================================================ BASIC
const B = 'Basic';
def(B, 'sine', 'Sine fade', (c) => 0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)));
def(B, 'pulse', 'Pulse (on/off)', (c) => (fr(c.t + c.o) < 0.5 ? 1 : 0));
def(B, 'strobe', 'Strobe', (c) => (fr(c.t + c.o) < 0.1 ? 1 : 0));
def(B, 'triangle', 'Triangle', (c) => tri(c.t + c.o));
def(B, 'ramp-up', 'Ramp up', (c) => fr(c.t + c.o));
def(B, 'ramp-down', 'Ramp down', (c) => 1 - fr(c.t + c.o));
def(B, 'soft-square', 'Soft square', (c) => sstep(0.4, 0.6, tri(c.t + c.o)));
def(B, 'blink-short', 'Short blink', (c) => (fr(c.t + c.o) < 0.04 ? 1 : 0));
def(B, 'double-flash', 'Double flash', (c) => { const f = fr(c.t + c.o); return f < 0.06 || (f > 0.16 && f < 0.22) ? 1 : 0; });
def(B, 'triple-flash', 'Triple flash', (c) => { const f = fr(c.t + c.o); return f < 0.05 || (f > 0.13 && f < 0.18) || (f > 0.26 && f < 0.31) ? 1 : 0; });
def(B, 'heartbeat', 'Heartbeat', (c) => { const f = fr(c.t + c.o); return Math.max(Math.exp(-Math.pow((f - 0.1) / 0.05, 2)), 0.7 * Math.exp(-Math.pow((f - 0.3) / 0.06, 2))); });
def(B, 'breathe', 'Breathe', (c) => Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 2.2));
def(B, 'bounce', 'Bounce', (c) => Math.abs(Math.sin(Math.PI * (c.t + c.o))));
def(B, 'random-flicker', 'Random flicker', (c) => h2(Math.floor((c.t + c.o) * 8), c.s));
def(B, 'random-fade', 'Random fade', (c) => noise((c.t + c.o) * 2, c.s));
def(B, 'swell', 'Slow swell', (c) => Math.pow(fr(c.t + c.o), 3));
def(B, 'gate', 'Gate (25% on)', (c) => (fr(c.t + c.o) < 0.25 ? 1 : 0));
def(B, 'stutter', 'Stutter burst', (c) => { const f = fr(c.t + c.o); return f < 0.3 && fr(f * 12) < 0.5 ? 1 : 0; });
def(B, 'decay', 'Flash and decay', (c) => Math.exp(-5 * fr(c.t + c.o)));
def(B, 'swing-dip', 'Dip', (c) => 1 - Math.exp(-0.5 * Math.pow(Math.sin(Math.PI * (c.t + c.o)) / 0.3, 2)) * 0.9);
def(B, 'staircase', 'Staircase', (c) => Math.floor(fr(c.t + c.o) * 5) / 4);
def(B, 'sine-fast-slow', 'Sine with wobble', (c) => clamp(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)) + 0.15 * Math.sin(TAU * 7 * (c.t + c.o)), 0, 1));

// ========================================================================== CHASES
const C = 'Chase';
def(C, 'chase', 'Chase', (c) => (step(c) === c.i ? 1 : 0));
def(C, 'chase-reverse', 'Chase reverse', (c) => (c.n - 1 - step(c) === c.i ? 1 : 0));
def(C, 'chase-bounce', 'Chase bounce', (c) => Math.max(0, 1 - Math.abs(pingpong(c) - c.i)));
def(C, 'chase-random', 'Random chase', (c) => (Math.floor(hash(Math.floor(c.t * c.n) * 7 + 3) * c.n) === c.i ? 1 : 0));
def(C, 'chase-two', 'Two-way chase', (c) => (step(c) === c.i || c.n - 1 - step(c) === c.i ? 1 : 0));
def(C, 'chase-thirds', 'Every third', (c) => ((c.i + Math.floor(fr(c.t) * 3)) % 3 === 0 ? 1 : 0));
def(C, 'chase-centre-out', 'Centre out', (c) => (fr(c.t) > centre(c) * 0.9 && fr(c.t) < centre(c) * 0.9 + 0.25 ? 1 : 0));
def(C, 'chase-edges-in', 'Edges in', (c) => { const d = 1 - centre(c); return fr(c.t) > d * 0.9 && fr(c.t) < d * 0.9 + 0.25 ? 1 : 0; });
def(C, 'comet', 'Comet trail', (c) => Math.pow(1 - fr(fr(c.t) - c.p), 3));
def(C, 'comet-reverse', 'Comet trail reverse', (c) => Math.pow(1 - fr(fr(c.t) - (1 - c.p)), 3));
def(C, 'wave', 'Smooth wave', (c) => 0.5 + 0.5 * Math.sin(TAU * (c.t - c.p)));
def(C, 'wave-double', 'Double wave', (c) => 0.5 + 0.5 * Math.sin(TAU * (c.t - 2 * c.p)));
def(C, 'wipe-on', 'Wipe on', (c) => (c.p <= fr(c.t) ? 1 : 0));
def(C, 'wipe-off', 'Wipe off', (c) => (c.p > fr(c.t) ? 1 : 0));
def(C, 'fill-clear', 'Fill then clear', (c) => { const f = fr(c.t) * 2; return f < 1 ? (c.p <= f ? 1 : 0) : (c.p > f - 1 ? 1 : 0); });
def(C, 'odd-even', 'Odd / even', (c) => ((c.i + Math.floor(c.t * 2)) % 2 === 0 ? 1 : 0));
def(C, 'halves', 'Halves swap', (c) => ((c.p < 0.5) === (fr(c.t) < 0.5) ? 1 : 0));
def(C, 'quarters', 'Quarter chase', (c) => (Math.floor(c.p * 3.999) === Math.floor(fr(c.t) * 4) ? 1 : 0));
def(C, 'scanner', 'Scanner', (c) => Math.max(0, 1 - Math.abs(tri(c.t * 0.5) * (c.n - 1) - c.i) * 1.5));
def(C, 'knight-rider', 'Knight Rider', (c) => Math.pow(Math.max(0, 1 - Math.abs(tri(c.t * 0.5) * (c.n - 1) - c.i) / 2), 2.5));
def(C, 'ripple-out', 'Ripple out', (c) => Math.max(0, Math.cos(TAU * (fr(c.t) - centre(c) * 0.6))) ** 3);
def(C, 'ripple-in', 'Ripple in', (c) => Math.max(0, Math.cos(TAU * (fr(c.t) + centre(c) * 0.6))) ** 3);
def(C, 'twinkle', 'Twinkle', (c) => Math.pow(noise(c.t * 3 + c.i * 11.3, c.s), 4) * 1.6);
def(C, 'stack-up', 'Stack up', (c) => (c.i <= Math.floor(fr(c.t) * c.n) ? 1 : 0));
def(C, 'random-toggle', 'Random on / off', (c) => (h2(Math.floor(c.t * 4), c.s) < 0.5 ? 1 : 0));
def(C, 'pairs', 'Pairs chase', (c) => (Math.floor(c.i / 2) === Math.floor(fr(c.t) * c.n / 2) ? 1 : 0));
def(C, 'leapfrog', 'Leapfrog', (c) => { const s = step(c); return c.i === s || c.i === (s + Math.floor(c.n / 2)) % c.n ? 1 : 0; });
def(C, 'domino', 'Domino', (c) => Math.exp(-6 * clamp(fr(c.t - c.p * 0.8), 0, 1)));
def(C, 'chase-soft', 'Soft chase', (c) => Math.max(0, 1 - Math.abs(fr(c.t - c.p + 0.5) - 0.5) * 3));

// ========================================================================== COLOUR
const K = 'Colour';
const cc = (col, a) => ({ a: a == null ? 1 : a, c: col });
def(K, 'rainbow', 'Rainbow', (c) => cc(hsv(c.t + c.o, 1, 1)));
def(K, 'colour-cycle', 'Colour cycle (all)', (c) => cc(hsv(c.t, 1, 1)));
def(K, 'rainbow-pastel', 'Pastel rainbow', (c) => cc(hsv(c.t + c.o, 0.45, 1)));
def(K, 'rgb-chase', 'RGB chase', (c) => cc([RED, GRN, BLU][(c.i + Math.floor(c.t * 3)) % 3]));
def(K, 'cmy-chase', 'CMY chase', (c) => cc([CYN, MAG, YEL][(c.i + Math.floor(c.t * 3)) % 3]));
def(K, 'red-blue', 'Red / blue alternate', (c) => cc((c.i + Math.floor(c.t * 2)) % 2 ? BLU : RED));
def(K, 'red-green', 'Red / green alternate', (c) => cc((c.i + Math.floor(c.t * 2)) % 2 ? GRN : RED));
def(K, 'blue-amber', 'Blue / amber alternate', (c) => cc((c.i + Math.floor(c.t * 2)) % 2 ? AMB : BLU));
def(K, 'magenta-cyan', 'Magenta / cyan alternate', (c) => cc((c.i + Math.floor(c.t * 2)) % 2 ? CYN : MAG));
def(K, 'primary-snap', 'Primary snap', (c) => cc([RED, GRN, BLU][Math.floor(c.t) % 3]));
def(K, 'secondary-snap', 'Secondary snap', (c) => cc([CYN, MAG, YEL][Math.floor(c.t) % 3]));
def(K, 'six-snap', 'Six colour snap', (c) => cc([RED, YEL, GRN, CYN, BLU, MAG][Math.floor(c.t) % 6]));
def(K, 'random-snap', 'Random colour snap', (c) => cc(hsv(h2(Math.floor(c.t), 5), 1, 1)));
def(K, 'random-snap-each', 'Random colour each fixture', (c) => cc(hsv(h2(Math.floor(c.t), c.s + 9), 1, 1)));
def(K, 'random-fade-colour', 'Random colour drift', (c) => cc(hsv(noise(c.t * 0.5 + c.o, 3), 1, 1)));
def(K, 'pastel-drift', 'Pastel drift', (c) => cc(hsv(noise(c.t * 0.4 + c.o, 21), 0.4, 1)));
def(K, 'warm-cool', 'Warm to cool', (c) => ({ k: 0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)) }));
def(K, 'warm-cool-chase', 'Warm / cool chase', (c) => ({ k: tri(c.t - c.p) }));
def(K, 'hue-pulse', 'Hue pulse', (c) => cc(hsv(Math.floor(c.t), 1, 1), fr(c.t) < 0.5 ? 1 : 0));
def(K, 'gradient', 'Moving gradient', (c) => cc(hsv(c.t * 0.25 + c.p * 0.33, 1, 1)));
def(K, 'candy', 'Candy', (c) => cc(lerpC(PNK, CYN, tri(c.t + c.o))));
def(K, 'ocean', 'Ocean colours', (c) => cc(lerpC([0, 0.2, 0.8], TEAL, noise(c.t * 0.7 + c.p * 2, 41))));
def(K, 'aurora', 'Aurora', (c) => cc(lerpC(GRN, PUR, noise(c.t * 0.5 + c.p * 1.5, 5)), 0.3 + 0.7 * noise(c.t * 0.8 + c.p * 3, 8)));
def(K, 'lava-colours', 'Lava colours', (c) => cc(lerpC([0.8, 0, 0], [1, 0.7, 0], noise(c.t * 0.6 + c.p * 2, 13))));
def(K, 'forest', 'Forest', (c) => cc(lerpC([0, 0.4, 0.05], [0.7, 0.9, 0.1], noise(c.t * 0.5 + c.p * 2, 77))));
def(K, 'ice', 'Ice', (c) => cc(lerpC([0.6, 0.85, 1], [0.15, 0.4, 1], noise(c.t * 0.6 + c.p * 2, 91))));
def(K, 'neon-colours', 'Neon', (c) => cc(pal([MAG, CYN, [0.4, 1, 0.1]], c.t + c.p, true)));
def(K, 'sunset-colours', 'Sunset palette', (c) => cc(pal([[1, 0.15, 0], [1, 0.4, 0.1], [0.9, 0.1, 0.4], [0.35, 0.05, 0.6]], c.t * 0.5 + c.p * 0.5, true)));
def(K, 'complement', 'Complementary swap', (c) => cc(hsv(Math.floor(c.t * 2) % 2 ? 0.5 + Math.floor(c.t) * 0.13 : Math.floor(c.t) * 0.13, 1, 1)));
def(K, 'duo-chase', 'Two-colour chase', (c) => cc(step(c) === c.i ? AMB : [0, 0.1, 0.6])); 
def(K, 'tricolour', 'Tricolour (R W B)', (c) => cc([RED, WHT, BLU][(c.i + Math.floor(c.t * 2)) % 3]));
def(K, 'white-red-flash', 'White / red flash', (c) => cc(Math.floor(c.t * 2) % 2 ? RED : WHT, fr(c.t * 2) < 0.5 ? 1 : 0.15));
def(K, 'colour-strobe', 'Random colour strobe', (c) => cc(hsv(h2(Math.floor(c.t * 4), c.s), 1, 1), fr(c.t * 4) < 0.2 ? 1 : 0));
def(K, 'rgb-wipe', 'RGB wipe', (c) => { const k = Math.floor(c.t) % 3; const f = fr(c.t); return cc([RED, GRN, BLU][c.p <= f ? k : (k + 2) % 3]); });
def(K, 'christmas', 'Christmas twinkle', (c) => cc(h2(Math.floor(c.t * 2), c.s) < 0.5 ? RED : GRN, 0.4 + 0.6 * noise(c.t * 3, c.s)));
def(K, 'halloween', 'Halloween', (c) => cc(lerpC([1, 0.35, 0], PUR, sstep(0.3, 0.7, tri(c.t + c.o)))));
def(K, 'colour-flame', 'Rolling colour wave', (c) => cc(hsv(c.p * 0.5 + Math.sin(TAU * c.t) * 0.1, 1, 1), 0.5 + 0.5 * Math.sin(TAU * (c.t - c.p))));
def(K, 'spectrum-bounce', 'Spectrum bounce', (c) => cc(hsv(tri(c.t * 0.5) * 0.8 + c.p * 0.1, 1, 1)));
def(K, 'mono-red', 'Red breathe', (c) => cc(RED, Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 1.5)));
def(K, 'mono-blue', 'Blue breathe', (c) => cc([0, 0.2, 1], Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 1.5)));
def(K, 'mono-amber', 'Amber breathe', (c) => cc(AMB, Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 1.5)));

// ======================================================================= FILM FIRE
const F = 'Film: fire & light';
const flame = (c, speed, deep, pw, sd) => {
  const n = fbm(c.t * speed + c.i * 3.7, c.s + sd);
  const a = clamp(1 - deep + deep * Math.pow(n * 1.25, pw), 0, 1);
  return { a, c: lerpC([1, 0.18, 0], [1, 0.62, 0.12], clamp(a * 1.1, 0, 1)) };
};
def(F, 'campfire', 'Campfire', (c) => flame(c, 6, 0.65, 1.2, 1));
def(F, 'fireplace', 'Fireplace', (c) => flame(c, 3.5, 0.45, 1.1, 2));
def(F, 'bonfire-large', 'Large bonfire', (c) => flame(c, 9, 0.8, 1.4, 3));
def(F, 'torch', 'Torch', (c) => flame(c, 11, 0.55, 1, 4));
def(F, 'candle', 'Candle', (c) => { const n = fbm(c.t * 4 + c.i * 5.1, c.s + 5); const gust = evt(c.t, 4, c.s + 40, 0.35); const dip = gust >= 0 ? 0.35 * Math.sin(Math.PI * gust) : 0; return { a: clamp(0.78 + 0.3 * (n - 0.5) - dip, 0, 1), c: [1, 0.55, 0.14] }; });
def(F, 'candle-draught', 'Candle in a draught', (c) => { const n = fbm(c.t * 7 + c.i * 5.1, c.s + 6); const gust = evt(c.t, 1.2, c.s + 41, 0.7); const dip = gust >= 0 ? 0.6 * Math.sin(Math.PI * gust) : 0; return { a: clamp(0.7 + 0.5 * (n - 0.5) - dip, 0.05, 1), c: [1, 0.5, 0.1] }; });
def(F, 'candles-group', 'Candle cluster', (c) => { const n = fbm(c.t * 3 + c.i * 17.9, c.s + 7); return { a: clamp(0.6 + 0.7 * (n - 0.4), 0.15, 1), c: [1, 0.58, 0.18] }; });
def(F, 'oil-lamp', 'Oil lamp', (c) => ({ a: clamp(0.85 + 0.12 * (noise(c.t * 1.5 + c.i, c.s) - 0.5), 0, 1), c: [1, 0.6, 0.2] }));
def(F, 'lantern-swing', 'Swinging lantern', (c) => ({ a: clamp(0.65 + 0.3 * Math.sin(TAU * (c.t * 0.5 + c.o)) + 0.15 * (noise(c.t * 6, c.s) - 0.5), 0.1, 1), c: [1, 0.58, 0.17] }));
def(F, 'embers', 'Glowing embers', (c) => ({ a: clamp(0.15 + 0.35 * Math.pow(noise(c.t * 1.2 + c.i * 2.2, c.s + 8), 1.5), 0, 1), c: [1, 0.12 + 0.12 * noise(c.t, c.s), 0] }));
def(F, 'sparks', 'Sparks', (c) => { const e = evt(c.t, 0.25, c.s, 0.35); return { a: e >= 0 ? Math.exp(-9 * e) : 0.04, c: [1, 0.5, 0.1] }; });
def(F, 'sparkler', 'Sparkler', (c) => ({ a: Math.pow(h2(Math.floor(c.t * 18), c.s), 3), c: lerpC(WHT, AMB, h2(Math.floor(c.t * 18), c.s + 3)) }));
def(F, 'match-strike', 'Match strike', (c) => { const f = fr(c.t); const flash = Math.exp(-30 * f) * 0.8; return { a: clamp(flash + (f > 0.05 ? 0.55 + 0.3 * noise(c.t * 20, c.s) : 0), 0, 1), c: [1, 0.5, 0.12] }; });
def(F, 'lava-lamp', 'Lava lamp', (c) => ({ a: 0.4 + 0.6 * noise(c.t * 0.3 + c.p * 3, 31), c: lerpC([1, 0.05, 0.1], [1, 0.45, 0], noise(c.t * 0.4 + c.p * 2, 32)) }));
def(F, 'fireflies', 'Fireflies', (c) => { const e = evt(c.t, 1, c.s + 70, 0.3); return { a: e >= 0 ? Math.pow(Math.sin(Math.PI * e), 2) : 0, c: [0.7, 1, 0.1] }; });
def(F, 'stars', 'Starry twinkle', (c) => ({ a: 0.25 + 0.75 * Math.pow(noise(c.t * 2.5 + c.i * 9.1, c.s + 90), 3), c: [0.85, 0.9, 1] }));
def(F, 'sunbeam', 'Sunbeam through trees', (c) => ({ a: clamp(0.4 + 0.9 * (fbm(c.t * 0.7 + c.p * 2.5, 60) - 0.3), 0.1, 1), k: 0.35 }));

// ======================================================================= FILM STORM
const S = 'Film: storm & weather';
const bolt = (c, per, seed, prob, len) => {
  const e = evt(c.t, per, seed, prob);
  if (e < 0) return 0;
  const x = e * len; // multi-strike flicker inside the slot
  const strikes = Math.exp(-14 * x) + 0.8 * Math.exp(-14 * Math.abs(x - 0.12)) * (x > 0.1 ? 1 : 0) + 0.5 * Math.exp(-14 * Math.abs(x - 0.3)) * (x > 0.28 ? 1 : 0);
  return clamp(strikes, 0, 1);
};
def(S, 'lightning', 'Lightning', (c) => ({ a: bolt({ ...c, t: c.t }, 2, 100 + (c.i % 3), 0.5, 0.6), k: 0.9 }));
def(S, 'lightning-sync', 'Lightning (all together)', (c) => ({ a: bolt(c, 2, 101, 0.5, 0.6), k: 0.95 }));
def(S, 'lightning-distant', 'Distant lightning', (c) => ({ a: 0.7 * Math.pow(bolt(c, 3, 102, 0.6, 1.2) , 1.5) + 0.0, k: 0.8 }));
def(S, 'thunderstorm', 'Thunderstorm', (c) => { const b = bolt(c, 2.5, 103, 0.55, 0.7); return { a: clamp(0.06 + 0.06 * noise(c.t, c.s) + b, 0, 1), c: lerpC([0.05, 0.1, 0.35], WHT, b) }; });
def(S, 'storm-clouds', 'Storm clouds rolling', (c) => ({ a: 0.15 + 0.5 * noise(c.t * 0.4 + c.p * 3, 4), c: [0.2, 0.25, 0.45] }));
def(S, 'heat-lightning', 'Heat lightning', (c) => { const b = bolt(c, 3.5, 104, 0.5, 1.5); return { a: b * 0.8, c: [1, 0.55, 0.3] }; });
def(S, 'rain-window', 'Rain on window', (c) => ({ a: clamp(0.3 + 0.35 * noise(c.t * 4 + c.i * 3, 50) + 0.35 * Math.pow(noise(c.t * 9 + c.i, 51), 4), 0, 1), c: [0.45, 0.6, 1] }));
def(S, 'clouds-passing', 'Clouds passing sun', (c) => ({ a: clamp(1.1 - 0.9 * sstep(0.35, 0.65, noise(c.t * 0.35 + c.p * 1.5, 55)), 0.1, 1), k: 0.45 }));
def(S, 'moonlight', 'Moonlight through clouds', (c) => ({ a: clamp(0.3 + 0.5 * noise(c.t * 0.3 + c.p * 1.5, 56), 0, 1), c: [0.45, 0.6, 1] }));
def(S, 'underwater', 'Underwater', (c) => ({ a: 0.4 + 0.6 * Math.pow(0.5 + 0.5 * Math.sin(TAU * (c.t * 0.7 - c.p * 1.3) + 2 * noise(c.t, c.s)), 1.5), c: lerpC([0, 0.35, 0.8], [0, 0.9, 0.8], noise(c.t * 0.4 + c.p, 57)) }));
def(S, 'pool-caustics', 'Pool caustics', (c) => ({ a: 0.3 + 0.7 * Math.pow(noise(c.t * 3 + c.i * 2.7, c.s + 58), 2.2) * 1.4, c: [0.2, 0.8, 1] }));
def(S, 'sunrise', 'Sunrise', (c) => { const u = fr(c.t * 0.1); return { a: Math.pow(u, 1.4), c: pal([[0.35, 0.05, 0.25], [1, 0.25, 0.05], [1, 0.62, 0.2], [1, 0.9, 0.7]], u * 0.75, true) }; });
def(S, 'sunset', 'Sunset', (c) => { const u = fr(c.t * 0.1); return { a: Math.pow(1 - u, 1.4), c: pal([[1, 0.9, 0.7], [1, 0.62, 0.2], [1, 0.25, 0.05], [0.35, 0.05, 0.25]], u * 0.75, true) }; });
def(S, 'golden-hour', 'Golden hour drift', (c) => ({ a: 0.75 + 0.25 * noise(c.t * 0.3 + c.p, 59), c: [1, 0.62, 0.22] }));
def(S, 'daylight-cycle', 'Day cycle (colour temp)', (c) => { const u = fr(c.t * 0.1); return { a: 0.35 + 0.65 * Math.sin(Math.PI * u), k: Math.sin(Math.PI * u) }; });
def(S, 'tungsten-sag', 'Tungsten sag', (c) => ({ a: 0.9 + 0.1 * noise(c.t * 0.5, 62), k: 0.05 + 0.1 * noise(c.t * 0.4 + c.i, 63) }));
def(S, 'snow-glow', 'Snow glow', (c) => ({ a: 0.55 + 0.35 * noise(c.t * 0.5 + c.p * 2, 64), c: [0.7, 0.85, 1] }));

// ======================================================================= FILM SCREEN
const T = 'Film: screens & signs';
def(T, 'tv-flicker', 'TV flicker', (c) => { const n = noise(c.t * 12, c.s + 200); const sc = h2(Math.floor(c.t * 1.2), c.s); return { a: clamp(0.3 + 0.7 * n, 0, 1), c: lerpC([0.35, 0.5, 1], sc < 0.35 ? [1, 0.7, 0.4] : [0.7, 0.85, 1], n) }; });
def(T, 'tv-surf', 'TV channel surfing', (c) => { const s = Math.floor(c.t * 1.5); return { a: clamp(0.35 + 0.65 * noise(c.t * 10, c.s + 201), 0, 1), c: hsv(h2(s, 202), 0.55 * h2(s, 203), 1) }; });
def(T, 'tv-static', 'TV static', (c) => ({ a: h2(Math.floor(c.t * 30), c.s + 204), c: [0.85, 0.9, 1] }));
def(T, 'cinema-projector', 'Cinema projector', (c) => ({ a: clamp(0.82 + 0.1 * h2(Math.floor(c.t * 24), 206) + 0.06 * Math.sin(TAU * c.t * 3), 0, 1), k: 0.55 }));
def(T, 'monitor-glow', 'Computer monitor glow', (c) => ({ a: clamp(0.5 + 0.3 * noise(c.t * 1.3 + c.i, c.s + 207) + 0.25 * (h2(Math.floor(c.t * 3), c.s) > 0.8 ? 1 : 0), 0, 1), c: [0.55, 0.8, 1] }));
def(T, 'neon-buzz', 'Neon buzz', (c) => ({ a: clamp(0.9 + 0.1 * h2(Math.floor(c.t * 40), c.s + 208) - (h2(Math.floor(c.t * 2), c.s + 209) > 0.93 ? 0.7 : 0), 0, 1), c: [1, 0.1, 0.6] }));
def(T, 'neon-sign', 'Neon sign (failing)', (c) => { const e = evt(c.t, 3, c.s + 210, 0.6); const off = e >= 0 && e < 0.3 && h2(Math.floor(e * 30), c.s) > 0.45; return { a: off ? 0.05 : 1, c: [0.1, 0.8, 1] }; });
def(T, 'fluorescent-fault', 'Faulty fluorescent', (c) => { const e = evt(c.t, 5, c.s + 211, 0.7); const f = e >= 0 && e < 0.4 ? (h2(Math.floor(e * 50), c.s + 5) > 0.5 ? 1 : 0.1) : 1; return { a: f, k: 0.75 }; });
def(T, 'dying-bulb', 'Dying bulb', (c) => { const u = fr(c.t * 0.15); const fail = u * 0.9; return { a: h2(Math.floor(c.t * 14), c.s + 212) > fail ? 1 : 0.1 + 0.1 * u, k: 0.1 }; });
def(T, 'bulb-pop', 'Bulb blowing', (c) => { const u = fr(c.t * 0.2); return { a: u < 0.8 ? 1 : u < 0.83 ? 2.5 : 0, k: 0.1 }; });
def(T, 'elevator-flicker', 'Elevator flicker', (c) => { const e = evt(c.t, 4, 213, 0.5); return { a: e >= 0 && e < 0.25 ? h2(Math.floor(e * 40), 7) : 0.9, k: 0.6 }; });
def(T, 'horror-flicker', 'Horror flicker', (c) => { const e = evt(c.t, 4, c.s + 214, 0.5); return { a: e >= 0 && e < 0.2 ? (e < 0.1 ? 0 : 1) : 0.18 + 0.1 * noise(c.t, c.s), c: [0.7, 0.9, 0.8] }; });
def(T, 'ghost', 'Ghostly fade', (c) => ({ a: Math.pow(0.5 + 0.5 * Math.sin(TAU * (c.t * 0.5 + c.p * 0.4)), 3), c: [0.6, 0.85, 1] }));
def(T, 'glitch', 'Glitch', (c) => { const g = h2(Math.floor(c.t * 10), c.s + 215) > 0.8; return { a: g ? h2(Math.floor(c.t * 40), c.s) : 0.85, c: g ? hsv(h2(Math.floor(c.t * 40), c.s + 1), 1, 1) : [0.3, 0.9, 1] }; });
def(T, 'hologram', 'Hologram', (c) => ({ a: clamp(0.7 + 0.2 * Math.sin(TAU * c.t * 4) + 0.2 * h2(Math.floor(c.t * 20), c.s + 216) - (h2(Math.floor(c.t * 3), 217) > 0.9 ? 0.5 : 0), 0, 1), c: [0.2, 0.85, 1] }));
def(T, 'reactor', 'Sci-fi reactor pulse', (c) => ({ a: 0.35 + 0.65 * Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 2), c: lerpC([0, 0.35, 1], [0.4, 1, 1], 0.5 - 0.5 * Math.cos(TAU * (c.t + c.o))) }));
def(T, 'hyperspace', 'Hyperspace', (c) => ({ a: Math.pow(fr(c.t * 2 - c.p), 4), c: [0.6, 0.8, 1] }));
def(T, 'laser-sweep', 'Laser sweep', (c) => ({ a: Math.pow(Math.max(0, 1 - Math.abs(tri(c.t) - c.p) * 5), 2), c: GRN }));
def(T, 'tractor-beam', 'Tractor beam', (c) => ({ a: Math.pow(0.5 + 0.5 * Math.sin(TAU * (c.t - c.p)), 2) * 0.8 + 0.2, c: lerpC(GRN, WHT, 0.4 * Math.sin(TAU * c.t) + 0.4) }));
def(T, 'warp-core', 'Warp core', (c) => ({ a: 0.5 + 0.5 * Math.sin(TAU * (c.t - c.p * 1.5)), c: lerpC([0.1, 0.2, 1], [0.7, 0.3, 1], 0.5 + 0.5 * Math.sin(TAU * c.t * 0.5)) }));
def(T, 'countdown', 'Countdown tick', (c) => ({ a: fr(c.t) < 0.12 ? 1 : 0.04, c: RED }));
def(T, 'traffic-light', 'Traffic lights', (c) => { const f = fr(c.t * 0.25); return { a: 1, c: f < 0.45 ? GRN : f < 0.55 ? AMB : f < 0.95 ? RED : [1, 0.4, 0] }; });

// ======================================================================= FILM EMERGENCY
const E = 'Film: emergency & vehicles';
def(E, 'police-car', 'Police car', (c) => { const f = fr(c.t); const left = c.p < 0.5; const on = left ? (f < 0.45 && fr(f * 6) < 0.6) : (f >= 0.5 && f < 0.95 && fr(f * 6) < 0.6); return { a: on ? 1 : 0.03, c: left ? RED : BLU }; });
def(E, 'police-wigwag', 'Police wig-wag', (c) => { const on = (Math.floor(c.t * 2) % 2 === 0) === (c.i % 2 === 0); return { a: on ? 1 : 0.02, c: c.i % 2 ? BLU : RED }; });
def(E, 'police-rotate', 'Police rotating bar', (c) => { const x = fr(c.t - c.p * 0.5); return { a: Math.pow(Math.max(0, 1 - x * 2.5), 2), c: c.i % 2 ? BLU : RED }; });
def(E, 'ambulance', 'Ambulance', (c) => { const on = fr(c.t * 2 + c.p * 0.5) < 0.5; return { a: on ? 1 : 0.05, c: Math.floor(c.t) % 2 ? BLU : WHT }; });
def(E, 'fire-engine', 'Fire engine', (c) => { const x = fr(c.t); return { a: Math.pow(Math.max(0, Math.sin(TAU * (x - c.p * 0.25))), 2), c: [1, 0.05, 0] }; });
def(E, 'red-alert', 'Red alert', (c) => ({ a: 0.1 + 0.9 * Math.pow(0.5 - 0.5 * Math.cos(TAU * (c.t + c.o)), 2), c: RED }));
def(E, 'klaxon', 'Klaxon', (c) => ({ a: fr(c.t) < 0.5 ? 1 : 0.05, c: [1, 0.08, 0] }));
def(E, 'siren-beacon', 'Rotating beacon', (c) => ({ a: Math.pow(Math.max(0, 1 - Math.abs(fr(c.t - c.p) - 0.0) * 4), 2) + Math.pow(Math.max(0, 1 - Math.abs(fr(c.t - c.p) - 1) * 4), 2), c: AMB }));
def(E, 'hazard', 'Hazard lights', (c) => ({ a: fr(c.t) < 0.5 ? 1 : 0, c: AMB }));
def(E, 'indicator', 'Sequential indicator', (c) => ({ a: fr(c.t) < 0.6 && c.p <= fr(c.t) / 0.6 ? 1 : 0, c: AMB }));
def(E, 'lighthouse', 'Lighthouse beam', (c) => ({ a: Math.pow(Math.max(0, 1 - Math.abs(fr(c.t * 0.5) - c.p) * 6), 2), k: 0.4 }));
def(E, 'helicopter-search', 'Helicopter searchlight', (c) => ({ a: clamp(1 - Math.abs(noise(c.t * 0.5, 80) - c.p) * 3.5, 0, 1), k: 0.55 }));
def(E, 'headlights-pass', 'Headlights passing', (c) => { const x = fr(c.t * 0.5); return { a: Math.exp(-Math.pow((c.p - x) / 0.12, 2)), k: 0.55 }; });
def(E, 'streetlights', 'Streetlights passing (night drive)', (c) => ({ a: 0.12 + 0.88 * Math.pow(Math.max(0, Math.sin(TAU * c.t)), 4), c: [1, 0.55, 0.15] }));
def(E, 'train-window', 'Train going past', (c) => ({ a: fr(c.t * 6 - c.p * 2) < 0.55 ? 0.9 : 0.1, k: 0.5 }));
def(E, 'car-interior', 'Car interior at night', (c) => ({ a: clamp(0.15 + 0.85 * Math.pow(Math.max(0, Math.sin(TAU * (c.t * 0.7 + c.p * 0.2))), 8) * (0.6 + 0.4 * h2(Math.floor(c.t * 0.7), 3)), 0, 1), c: lerpC([1, 0.55, 0.15], [0.6, 0.75, 1], h2(Math.floor(c.t * 0.7), 4)) }));
def(E, 'disco-ball', 'Mirror ball sparkle', (c) => ({ a: Math.pow(h2(Math.floor(c.t * 10), c.s + 300), 4) * 1.5, k: 0.6 }));

// ======================================================================= FILM ACTION
const A = 'Film: action & power';
def(A, 'camera-flash', 'Camera flash', (c) => { const e = evt(c.t, 1.5, 310, 0.6); return { a: e >= 0 ? Math.exp(-18 * e) : 0, k: 0.7 }; });
def(A, 'paparazzi', 'Paparazzi', (c) => { const e = evt(c.t, 0.35, c.s + 311, 0.45); return { a: e >= 0 ? Math.exp(-25 * e) : 0.02, k: 0.7 }; });
def(A, 'paparazzi-heavy', 'Press scrum', (c) => { const e = evt(c.t, 0.15, c.s + 312, 0.5); return { a: e >= 0 ? Math.exp(-20 * e) : 0, k: 0.7 }; });
def(A, 'welding', 'Welding arc', (c) => { const on = noise(c.t * 6, 320) > 0.35; return { a: on ? clamp(0.5 + 0.7 * h2(Math.floor(c.t * 45), c.s), 0, 1) : 0.03, c: lerpC([0.5, 0.65, 1], WHT, h2(Math.floor(c.t * 45), c.s + 1)) }; });
def(A, 'explosion', 'Explosion', (c) => { const u = fr(c.t * 0.25); const bang = u < 0.04 ? 1 : 0; const fire = Math.exp(-4 * Math.max(0, u - 0.04)) * (0.6 + 0.4 * noise(c.t * 30, c.s)); return { a: bang ? 1 : fire * (u > 0.04 ? 1 : 0), c: bang ? WHT : lerpC([0.9, 0.1, 0], [1, 0.6, 0.1], fire) }; });
def(A, 'fireball', 'Fireball', (c) => { const u = fr(c.t * 0.3); return { a: u < 0.1 ? u * 10 : Math.exp(-3 * (u - 0.1)), c: lerpC(WHT, [0.9, 0.12, 0], clamp(u * 2.2, 0, 1)) }; });
def(A, 'fireworks', 'Fireworks', (c) => { const e = evt(c.t, 1.3, c.s + 330, 0.65); const sl = Math.floor(c.t / 1.3); return { a: e >= 0 ? Math.exp(-4 * e) : 0, c: hsv(h2(sl, c.s + 331), 0.9, 1) }; });
def(A, 'fireworks-finale', 'Fireworks finale', (c) => { const e = evt(c.t, 0.4, c.s + 332, 0.8); const sl = Math.floor(c.t / 0.4); return { a: e >= 0 ? Math.exp(-5 * e) : 0, c: hsv(h2(sl, c.s + 333), 0.8, 1) }; });
def(A, 'muzzle-flash', 'Muzzle flash', (c) => ({ a: fr(c.t * 3) < 0.15 ? 1 : 0, c: [1, 0.75, 0.35] }));
def(A, 'gunfire', 'Gunfire burst', (c) => { const e = evt(c.t, 2, 340, 0.6); const on = e >= 0 && e < 0.5 && fr(e * 14) < 0.4; return { a: on ? h2(Math.floor(e * 14), c.s) * 0.5 + 0.5 : 0, c: [1, 0.75, 0.35] }; });
def(A, 'electrical-short', 'Electrical short', (c) => { const e = evt(c.t, 1.5, 341, 0.6); const on = e >= 0 && e < 0.35; return { a: on ? h2(Math.floor(e * 60), c.s) : 0.03, c: [0.6, 0.75, 1] }; });
def(A, 'power-surge', 'Power surge', (c) => { const u = fr(c.t * 0.3); return { a: u < 0.7 ? 0.5 + 0.4 * u : u < 0.75 ? 1.6 : 0.2, k: 0.4 }; });
def(A, 'power-cut', 'Power cut', (c) => { const u = fr(c.t * 0.2); return { a: u < 0.6 ? 1 : u < 0.75 ? (h2(Math.floor(u * 80), c.s + 350) > 0.5 ? 1 : 0.15) : u < 0.9 ? 0 : sstep(0.9, 1, u), k: 0.3 }; });
def(A, 'generator', 'Generator brown-out', (c) => ({ a: clamp(0.75 + 0.2 * Math.sin(TAU * c.t * 4) * noise(c.t * 0.7, 351) + 0.1 * (h2(Math.floor(c.t * 12), c.s) - 0.5), 0, 1), k: 0.1 }));
def(A, 'emergency-lighting', 'Emergency lighting', (c) => ({ a: c.i % 2 === 0 ? 0.55 + 0.1 * noise(c.t, 352) : 0, k: 0.2 }));
def(A, 'interrogation', 'Interrogation lamp swing', (c) => ({ a: 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.cos(TAU * c.t * 0.5), 1.8), k: 0.7 }));
def(A, 'swinging-bulb', 'Swinging bulb', (c) => ({ a: 0.25 + 0.75 * Math.exp(-Math.pow((c.p - 0.5 - 0.5 * Math.sin(TAU * c.t * 0.5)) / 0.25, 2)), k: 0.1 }));
def(A, 'strobe-club', 'Club strobe', (c) => ({ a: fr(c.t * 4) < 0.08 ? 1 : 0, k: 0.8 }));
def(A, 'disco-party', 'Disco party', (c) => ({ a: 1, c: hsv(h2(Math.floor(c.t * 2), c.s + 360), 1, 1) }));
def(A, 'bomb-timer', 'Bomb timer (accelerating)', (c) => { const u = fr(c.t * 0.1); const rate = 1 + 7 * u * u; const ph = u * 10 + u * u * 35 * 0.5 * rate; return { a: fr(ph) < 0.2 ? 1 : 0.02, c: RED }; });
def(A, 'slow-burn', 'Slow burn up', (c) => ({ a: sstep(0, 1, fr(c.t * 0.1)), k: 0.1 + 0.4 * fr(c.t * 0.1) }));

// ============================================================================ API
const byId = new Map(FX.map((e) => [e.id, e]));
const list = () => FX.map((e) => ({ id: e.id, name: e.name, cat: e.cat }));
const get = (id) => byId.get(id) || null;
const categories = () => Array.from(new Set(FX.map((e) => e.cat)));

module.exports = { FX, list, get, categories, hsv, kRgb, clamp };
