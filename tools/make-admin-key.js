#!/usr/bin/env node
'use strict';
// Makes an admin key for B-Box Lighting Desk. Usage:
//   node tools/make-admin-key.js <path-to-admin-private.key> [name]
// Keep the private key file secret and out of git: anyone who has it can make working admin keys.
const fs = require('fs');
const nacl = require('tweetnacl');
const [, , keyPath, name] = process.argv;
if (!keyPath) { console.error('Usage: node tools/make-admin-key.js <admin-private.key> [name]'); process.exit(1); }
const sk = Uint8Array.from(Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64'));
const b64u = (u) => Buffer.from(u).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const payload = b64u(Buffer.from(JSON.stringify({ v: 1, t: 'admin', n: name || 'Admin', iat: Math.floor(Date.now() / 1000) })));
const sig = b64u(nacl.sign.detached(Uint8Array.from(Buffer.from(payload, 'utf8')), sk));
console.log(`BBOX-ADMIN-${payload}.${sig}`);
