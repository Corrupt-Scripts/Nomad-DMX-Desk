'use strict';
const assert = require('assert');
const dgram = require('dgram');
const { artnetPacket, sacnPacket, sacnMulticastAddr } = require('../engine/protocols');
const { parseCommand } = require('../engine/command');
const { Engine, keyOf } = require('../engine/engine');

let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('ok  ', name); } catch (e) { console.error('FAIL', name, '\n', e); process.exitCode = 1; } };

(async () => {
  await t('artnet packet layout', () => {
    const d = new Uint8Array(512); d[0] = 255; d[511] = 7;
    const b = artnetPacket(3, 9, d);
    assert.strictEqual(b.length, 530);
    assert.strictEqual(b.toString('ascii', 0, 7), 'Art-Net');
    assert.strictEqual(b[7], 0);
    assert.strictEqual(b.readUInt16LE(8), 0x5000);
    assert.strictEqual(b.readUInt16BE(10), 14);
    assert.strictEqual(b[12], 9);
    assert.strictEqual(b.readUInt16LE(14), 3);
    assert.strictEqual(b.readUInt16BE(16), 512);
    assert.strictEqual(b[18], 255); assert.strictEqual(b[529], 7);
    assert.strictEqual(artnetPacket(0x0102, 1, d).readUInt8(15), 1); // net
  });

  await t('sacn packet layout', () => {
    const d = new Uint8Array(512); d[0] = 200;
    const b = sacnPacket(5, 4, d, 120, 'Test');
    assert.strictEqual(b.length, 638);
    assert.strictEqual(b.readUInt16BE(0), 0x10);
    assert.strictEqual(b.toString('ascii', 4, 13), 'ASC-E1.17');
    assert.strictEqual(b.readUInt16BE(16), 0x7000 | 622);
    assert.strictEqual(b.readUInt32BE(18), 4);
    assert.strictEqual(b.readUInt16BE(38), 0x7000 | 600);
    assert.strictEqual(b.readUInt32BE(40), 2);
    assert.strictEqual(b.toString('utf8', 44, 48), 'Test');
    assert.strictEqual(b[108], 120);
    assert.strictEqual(b[111], 4);
    assert.strictEqual(b.readUInt16BE(113), 5);
    assert.strictEqual(b.readUInt16BE(115), 0x7000 | 523);
    assert.strictEqual(b[118], 0xa1);
    assert.strictEqual(b.readUInt16BE(123), 513);
    assert.strictEqual(b[125], 0);
    assert.strictEqual(b[126], 200);
    assert.strictEqual(sacnMulticastAddr(258), '239.255.1.2');
  });

  await t('command parser', () => {
    assert.deepStrictEqual(parseCommand('1 thru 10 @ 50'), { type: 'select', mode: 'ch', universe: null, ops: [{ op: 'add', from: 1, to: 10 }], level: 50 });
    const a = parseCommand('1 thru 10 - 5 @ full');
    assert.strictEqual(a.level, 100); assert.strictEqual(a.ops[1].op, 'remove');
    assert.strictEqual(parseCommand('1@50').level, 50);
    assert.strictEqual(parseCommand('u2 1 thru 4 @ 75').universe, 2);
    assert.strictEqual(parseCommand('fix 1 + 3 @ out').mode, 'fix');
    assert.deepStrictEqual(parseCommand('u 3'), { type: 'universe', n: 3 });
    assert.deepStrictEqual(parseCommand('@ 30'), { type: 'level', level: 30 });
    assert.deepStrictEqual(parseCommand('colour #ff8800').rgb, [255, 136, 0]);
    assert.deepStrictEqual(parseCommand('col 10 20 30').rgb, [10, 20, 30]);
    assert.deepStrictEqual(parseCommand('record cue 2.5 time 3 label Walk In'), { type: 'record', number: 2.5, fade: 3, label: 'Walk In' });
    assert.deepStrictEqual(parseCommand('rec cue 4'), { type: 'record', number: 4, fade: null, label: null });
    assert.strictEqual(parseCommand('goto 3').number, 3);
    assert.throws(() => parseCommand('banana'));
    assert.throws(() => parseCommand('1 thru'));
    assert.throws(() => parseCommand('1 @'));
  });

  await t('channel levels, master, blackout', () => {
    const e = new Engine();
    assert.ok(e.execute('1 thru 3 @ 50').ok);
    let f = e.computeFrame(Date.now())[0];
    assert.deepStrictEqual([f[0], f[1], f[2], f[3]], [128, 128, 128, 0]);
    e.execute('master 50');
    f = e.computeFrame(Date.now())[0]; assert.strictEqual(f[0], 64);
    e.execute('blackout');
    f = e.computeFrame(Date.now())[0]; assert.strictEqual(f[0], 0);
    e.execute('blackout off'); e.execute('master 100');
    e.execute('1 thru 3 - 2 @ full');
    f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1], f[2]], [255, 128, 255]);
    assert.strictEqual(e.execute('999 @ 50').ok, false);
    assert.strictEqual(e.execute('u9 1 @ 50').ok, false);
  });

  await t('fixtures: patch, colour, intensity', () => {
    const e = new Engine();
    e.addFixtures({ profileId: 'b-rgb', count: 4, universe: 1, address: 1 });
    e.addFixtures({ profileId: 'b-drgbw', count: 1, universe: 1, address: 13 });
    assert.strictEqual(e.patch.length, 5);
    assert.strictEqual(e.patch[3].address, 10);
    assert.ok(e.execute('fix 1 thru 4').ok);
    assert.ok(e.execute('colour red').ok);
    let f = e.computeFrame(Date.now())[0];
    assert.deepStrictEqual([f[0], f[1], f[2], f[3]], [255, 0, 0, 255]);
    e.execute('@ 50');
    f = e.computeFrame(Date.now())[0];
    assert.deepStrictEqual([f[0], f[1], f[2]], [128, 0, 0]);
    e.execute('fix 5'); e.execute('colour 0 0 255');
    f = e.computeFrame(Date.now())[0];
    assert.deepStrictEqual([f[12], f[13], f[14], f[15], f[16]], [255, 0, 0, 255, 0]); // dimmer auto 255
    e.execute('@ 40');
    f = e.computeFrame(Date.now())[0]; assert.strictEqual(f[12], 102);
    assert.deepStrictEqual(e.conflicts(), []);
    e.addFixtures({ profileId: 'b-rgb', count: 1, universe: 1, address: 2 });
    assert.ok(e.conflicts().length >= 2);
  });

  await t('auto-patch rolls to next universe', () => {
    const e = new Engine();
    e.addFixtures({ profileId: 'b-rgb', count: 175, universe: 1, address: 1 });
    assert.strictEqual(e.patch[169].universe, 1);
    assert.strictEqual(e.patch[170].universe, 2);
    assert.strictEqual(e.patch[170].address, 1);
    assert.strictEqual(e.settings.universes, 2);
  });

  await t('cues record, go, fade, back', () => {
    const e = new Engine();
    e.execute('1 @ full'); assert.ok(e.execute('record cue 1 time 0 label One').ok);
    assert.strictEqual(e.programmer.size, 0);
    let f = e.computeFrame(Date.now())[0]; assert.strictEqual(f[0], 255);
    e.execute('clear'); e.execute('2 @ full'); e.execute('record cue 2 time 0');
    f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1]], [255, 255]); // record keeps tracked look
    e.execute('release'); f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1]], [0, 0]);
    e.execute('goto 1'); f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1]], [255, 0]);
    e.execute('go'); f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1]], [255, 255]);
    e.execute('back'); f = e.computeFrame(Date.now())[0]; assert.deepStrictEqual([f[0], f[1]], [255, 0]);
    e.updateCue(e.cues[1].id, { fade: 10 });
    e.execute('go');
    f = e.computeFrame(Date.now() + 5000)[0]; assert.ok(f[1] > 100 && f[1] < 150, 'mid-fade ' + f[1]);
    f = e.computeFrame(Date.now() + 11000)[0]; assert.strictEqual(f[1], 255);
    assert.strictEqual(e.execute('goto 99').ok, false);
    assert.ok(e.execute('delete cue 2').ok); assert.strictEqual(e.cues.length, 1);
  });

  await t('effects', () => {
    const e = new Engine();
    e.addFixtures({ profileId: 'b-dimmer', count: 4, universe: 1, address: 1 });
    e.execute('fix 1 thru 4');
    e.addEffect({ type: 'chase', rate: 1 });
    const seen = new Set();
    for (let ms = 0; ms < 1000; ms += 50) {
      const f = e.computeFrame(e.t0 + ms)[0];
      const lit = [0, 1, 2, 3].filter((i) => f[i] > 0);
      assert.strictEqual(lit.length, 1, 'one lit at ' + ms);
      seen.add(lit[0]);
    }
    assert.strictEqual(seen.size, 4);
    e.updateEffect(e.effects[0].id, { type: 'sine' });
    const f1 = e.computeFrame(e.t0 + 500)[0]; assert.ok(f1[0] >= 0);
    e.removeEffect(e.effects[0].id);
    assert.strictEqual(e.computeFrame(e.t0)[0][0], 0);
    e.addFixtures({ profileId: 'b-rgb', count: 1, universe: 1, address: 21 });
    e.execute('fix 5'); e.addEffect({ type: 'rainbow', rate: 1 });
    const f = e.computeFrame(e.t0 + 0)[0]; assert.strictEqual(f[20], 255);
  });

  await t('show save/load round trip', () => {
    const e = new Engine();
    e.addFixtures({ profileId: 'b-rgbw', count: 2, universe: 1, address: 1 });
    e.saveProfile({ name: 'My Par', channels: [{ name: 'Dim', type: 'dimmer' }, { name: 'Strobe', type: 'other' }] });
    e.execute('1 @ full'); e.execute('rec cue 1 time 1');
    const json = JSON.parse(JSON.stringify(e.serialize()));
    const e2 = new Engine(); e2.load(json);
    assert.strictEqual(e2.patch.length, 2); assert.strictEqual(e2.cues.length, 1); assert.strictEqual(e2.profiles.length, 1);
    e2.execute('goto 1'); assert.strictEqual(e2.computeFrame(Date.now() + 2000)[0][0], 255);
    assert.throws(() => e2.load({ foo: 1 }));
    assert.throws(() => e2.deleteProfile('b-rgbw') || e2.deleteProfile('b-rgbw'), /used|Cannot/);
  });

  await t('master/blackout leave pan/tilt alone', () => {
    const e = new Engine();
    e.addFixtures({ profileId: 'b-pantilt', count: 1, universe: 1, address: 1 });
    e.execute('fix 1'); e.setParam('pan', 200); e.setLevel(100);
    e.setBlackout(true);
    const f = e.computeFrame(Date.now())[0];
    assert.deepStrictEqual([f[0], f[2]], [200, 0]);
  });

  await t('udp output (Art-Net + sACN unicast on loopback)', async () => {
    const got = { art: null, sacn: null };
    const mk = (kind) => new Promise((res) => {
      const s = dgram.createSocket('udp4');
      s.on('message', (m) => { if (!got[kind]) got[kind] = m; });
      s.bind(0, '127.0.0.1', () => res(s));
    });
    const sa = await mk('art'); const ss = await mk('sacn');
    const e = new Engine();
    e.updateSettings({ protocol: 'both', artnetDest: '127.0.0.1', sacnUnicast: '127.0.0.1', universes: 2 });
    e.settings.artnetPort = sa.address().port; e.settings.sacnPort = ss.address().port;
    e.execute('u2 7 @ full');
    e.start();
    await new Promise((r) => setTimeout(r, 400));
    e.shutdown(); sa.close(); ss.close();
    assert.ok(got.art, 'artnet received'); assert.ok(got.sacn, 'sacn received');
    assert.strictEqual(got.art.toString('ascii', 0, 7), 'Art-Net');
    assert.strictEqual(got.sacn.toString('ascii', 4, 13), 'ASC-E1.17');
    assert.ok(e.stats.packets > 0);
  });

  console.log(`\n${n} test groups passed`);
  process.exit(process.exitCode || 0);
})();
