'use strict';
// The native UDP plugin (ios/ plugin NomadUdp). Tests can put a stand-in on window.__nomadUdp.
const { registerPlugin } = require('@capacitor/core');

module.exports = (typeof window !== 'undefined' && window.__nomadUdp) || registerPlugin('NomadUdp');
