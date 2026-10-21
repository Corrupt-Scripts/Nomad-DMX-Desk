'use strict';
// Art-Net poll packets, shared by the desktop app and the iPad app (no Node-only modules in here).

function artPollPacket() {
  const b = Buffer.alloc(14);
  b.write('Art-Net\0', 0, 'ascii');
  b.writeUInt16LE(0x2000, 8); // OpPoll
  b.writeUInt16BE(14, 10);    // protocol version
  b[12] = 0;                  // TalkToMe: reply once to this poll
  b[13] = 0;
  return b;
}

const cstr = (buf, from, to) => {
  const s = buf.subarray(from, to);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString('latin1').trim();
};

// Returns null if the packet is not an ArtPollReply.
function parseArtPollReply(buf, rinfo) {
  if (buf.length < 207 || buf.toString('ascii', 0, 7) !== 'Art-Net' || buf.readUInt16LE(8) !== 0x2100) return null;
  const ip = `${buf[10]}.${buf[11]}.${buf[12]}.${buf[13]}`;
  const net = buf[18] & 0x7f;
  const sub = buf[19] & 0x0f;
  const numPorts = Math.min(4, buf.readUInt16BE(172));
  const outputs = [];
  for (let i = 0; i < numPorts; i++) {
    if (buf[174 + i] & 0x80) outputs.push((net << 8) | (sub << 4) | (buf[190 + i] & 0x0f)); // output-capable port
  }
  return {
    ip: ip === '0.0.0.0' && rinfo ? rinfo.address : ip,
    shortName: cstr(buf, 26, 44),
    longName: cstr(buf, 44, 108),
    outputs,                                   // Art-Net universes this node outputs
    mac: Array.from(buf.subarray(201, 207)).map((x) => x.toString(16).padStart(2, '0')).join(':'),
  };
}

module.exports = { artPollPacket, parseArtPollReply };
