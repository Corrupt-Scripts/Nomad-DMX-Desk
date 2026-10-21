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

  const disc = require('../engine/discovery');

  await t('ArtPollReply parsing', () => {
    const b = Buffer.alloc(239);
    b.write('Art-Net\0', 0, 'ascii'); b.writeUInt16LE(0x2100, 8);
    [192, 168, 4, 1].forEach((x, i) => { b[10 + i] = x; });
    b.write('BoulderBox', 26, 'latin1'); b.write('Boulder Box wireless DMX', 44, 'latin1');
    b[18] = 0; b[19] = 2; b.writeUInt16BE(2, 172); b[174] = 0x80; b[175] = 0x80; b[190] = 1; b[191] = 3;
    [1, 2, 3, 4, 5, 6].forEach((x, i) => { b[201 + i] = x; });
    const n = disc.parseArtPollReply(b, { address: '9.9.9.9' });
    assert.strictEqual(n.ip, '192.168.4.1'); assert.strictEqual(n.shortName, 'BoulderBox');
    assert.strictEqual(n.longName, 'Boulder Box wireless DMX');
    assert.deepStrictEqual(n.outputs, [0x21, 0x23]); assert.strictEqual(n.mac, '01:02:03:04:05:06');
    assert.strictEqual(disc.parseArtPollReply(Buffer.alloc(300), null), null);
    assert.strictEqual(disc.artPollPacket().length, 14);
  });

  await t('Art-Net scan finds a node (loopback)', async () => {
    const node = dgram.createSocket('udp4');
    await new Promise((r) => node.bind(0, '127.0.0.1', r));
    let polled = 0;
    node.on('message', (m, rinfo) => {
      if (m.readUInt16LE(8) !== 0x2000) return;
      polled++;
      const b = Buffer.alloc(239); b.write('Art-Net\0', 0, 'ascii'); b.writeUInt16LE(0x2100, 8);
      [127, 0, 0, 1].forEach((x, i) => { b[10 + i] = x; });
      b.write('TestNode', 26, 'latin1'); b.writeUInt16BE(1, 172); b[174] = 0x80; b[190] = 0;
      node.send(b, rinfo.port, '127.0.0.1');
    });
    const nodes = await disc.artnetScan({ port: node.address().port, listenPort: 0, targets: ['127.0.0.1'], timeoutMs: 900 });
    node.close();
    assert.ok(polled >= 1, 'node was polled');
    assert.strictEqual(nodes.length, 1); assert.strictEqual(nodes[0].shortName, 'TestNode'); assert.deepStrictEqual(nodes[0].outputs, [0]);
  });

  await t('Wi-Fi output parsers + profile', () => {
    const netsh = 'Interface name : Wi-Fi \r\nThere are 3 networks currently visible.\r\n\r\nSSID 1 : BoulderBox\r\n    Network type            : Infrastructure\r\n    Authentication          : Open\r\n    Encryption              : None\r\n    BSSID 1                 : aa:bb:cc:dd:ee:ff\r\n         Signal             : 81%\r\n         Radio type         : 802.11n\r\nSSID 2 : Home WiFi\r\n    Authentication          : WPA2-Personal\r\n    BSSID 1                 : 11:22:33:44:55:66\r\n         Signal             : 40%\r\n    BSSID 2                 : 11:22:33:44:55:67\r\n         Signal             : 72%\r\nSSID 3 : \r\n    Authentication          : Open\r\n';
    const nets = disc.parseNetsh(netsh);
    assert.deepStrictEqual(nets.map((x) => [x.ssid, x.security, x.signal]), [['BoulderBox', 'open', 81], ['Home WiFi', 'secured', 72]]);
    const mac = disc.parseMacProfiler({ SPAirPortDataType: [{ spairport_airport_interfaces: [{
      spairport_current_network_information: { _name: 'Home', spairport_security_mode: 'spairport_security_mode_wpa2_personal', spairport_signal_noise: '-50 dBm / -90 dBm' },
      spairport_airport_other_local_wireless_networks: [{ _name: 'BoulderBox', spairport_security_mode: 'spairport_security_mode_none', spairport_signal_noise: '-60 dBm / -90 dBm' }, { _name: '<redacted>' }] }] }] });
    assert.deepStrictEqual(mac.networks.map((x) => [x.ssid, x.security, x.current]), [['Home', 'secured', true], ['BoulderBox', 'open', false]]);
    assert.strictEqual(mac.redacted, true);
    const x = disc.winProfile('My "Net" & Co', 'pa<ss>word1');
    assert.ok(x.includes('My &quot;Net&quot; &amp; Co') && x.includes('pa&lt;ss&gt;word1') && x.includes('WPA2PSK'));
    assert.ok(disc.winProfile('Open', '').includes('<authentication>open</authentication>'));
  });

  await t('Art-Net first-universe offset + BLE settings', () => {
    const e = new Engine();
    e.updateSettings({ artnetFirst: 5, bleFormat: 'PLAIN', bleUniverse: 2, bleFormat2: 'x' });
    assert.strictEqual(e.settings.artnetFirst, 5); assert.strictEqual(e.settings.bleFormat, 'PLAIN'); assert.strictEqual(e.settings.bleUniverse, 2);
    e.updateSettings({ bleFormat: 'junk' }); assert.strictEqual(e.settings.bleFormat, 'PLAIN');
  });

  console.log(`\n${n} test groups passed`);
  process.exit(process.exitCode || 0);
})();
