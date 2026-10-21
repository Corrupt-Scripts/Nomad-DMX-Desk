'use strict';
// Channel types understood by the engine.
const TYPES = ['dimmer', 'red', 'green', 'blue', 'white', 'warm', 'cool', 'amber', 'uv', 'pan', 'tilt', 'cct', 'tint', 'other'];
const EMITTERS = ['red', 'green', 'blue', 'white', 'warm', 'cool', 'amber', 'uv'];
const NON_INTENSITY = ['pan', 'tilt', 'cct', 'tint', 'other']; // not scaled by master / blackout

const ch = (name, type) => ({ name, type });

const BUILTIN_PROFILES = [
  { id: 'b-dimmer', name: 'Generic Dimmer', builtin: true, channels: [ch('Dimmer', 'dimmer')] },
  { id: 'b-rgb', name: 'RGB', builtin: true, channels: [ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue')] },
  { id: 'b-rgbw', name: 'RGBW', builtin: true, channels: [ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue'), ch('White', 'white')] },
  { id: 'b-rgbww', name: 'RGBWW (warm + cool)', builtin: true, channels: [ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue'), ch('Warm', 'warm'), ch('Cool', 'cool')] },
  { id: 'b-rgba', name: 'RGBA', builtin: true, channels: [ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue'), ch('Amber', 'amber')] },
  { id: 'b-bicolour', name: 'Bi-Colour (warm + cool)', builtin: true, channels: [ch('Warm', 'warm'), ch('Cool', 'cool')] },
  { id: 'b-dbicolour', name: 'Dimmer + Bi-Colour', builtin: true, channels: [ch('Dimmer', 'dimmer'), ch('Warm', 'warm'), ch('Cool', 'cool')] },
  { id: 'b-drgb', name: 'Dimmer + RGB', builtin: true, channels: [ch('Dimmer', 'dimmer'), ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue')] },
  { id: 'b-drgbw', name: 'Dimmer + RGBW', builtin: true, channels: [ch('Dimmer', 'dimmer'), ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue'), ch('White', 'white')] },
  { id: 'b-drgbww', name: 'Dimmer + RGBWW', builtin: true, channels: [ch('Dimmer', 'dimmer'), ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue'), ch('Warm', 'warm'), ch('Cool', 'cool')] },
  { id: 'b-cct', name: 'Film: Dimmer + CCT', builtin: true, channels: [ch('Intensity', 'dimmer'), ch('CCT', 'cct')] },
  { id: 'b-cct-tint', name: 'Film: Dimmer + CCT + Tint (+/- green)', builtin: true, channels: [ch('Intensity', 'dimmer'), ch('CCT', 'cct'), ch('Tint', 'tint')] },
  { id: 'b-cct-rgb', name: 'Film: Dimmer + CCT + Tint + RGB', builtin: true, channels: [ch('Intensity', 'dimmer'), ch('CCT', 'cct'), ch('Tint', 'tint'), ch('Red', 'red'), ch('Green', 'green'), ch('Blue', 'blue')] },
  { id: 'b-pantilt', name: 'Dimmer + Pan/Tilt', builtin: true, channels: [ch('Pan', 'pan'), ch('Tilt', 'tilt'), ch('Dimmer', 'dimmer')] },
];

module.exports = { TYPES, EMITTERS, NON_INTENSITY, BUILTIN_PROFILES };
