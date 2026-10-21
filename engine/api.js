'use strict';
// Methods the UI (or a remote screen) may call on the engine.
const ALLOWED = new Set([
  'getShow', 'getLibrary', 'execute', 'setUniverse', 'setSelection', 'setLevel', 'setColour', 'setParam', 'setChannel',
  'clearProgrammer', 'clearAll', 'setMaster', 'setBlackout', 'go', 'back', 'goto', 'stop', 'release',
  'recordCue', 'updateCue', 'deleteCue', 'goIndex', 'addEffect', 'updateEffect', 'removeEffect',
  'setLayoutImage', 'getLayoutImage', 'setLayoutPositions', 'removeLayoutPositions', 'layoutAuto', 'addShape', 'updateShape', 'removeShape', 'moveShape', 'clearShapes', 'setLayoutOptions',
  'addFixtures', 'updateFixture', 'removeFixture', 'saveProfile', 'deleteProfile', 'updateSettings',
]);

module.exports = { ALLOWED };
