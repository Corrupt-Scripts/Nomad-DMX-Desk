'use strict';
// Just enough of Node's crypto for the packet builders (random source id).
module.exports = {
  randomBytes(n) {
    const a = new Uint8Array(n);
    (globalThis.crypto || window.crypto).getRandomValues(a);
    return Buffer.from(a);
  },
};
