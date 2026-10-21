'use strict';
// Art-Net (ArtDMX) and sACN (E1.31) packet builders.
const crypto = require('crypto');

const CID = crypto.randomBytes(16); // stable for the life of the process

// wireUniverse is the number that goes on the wire (Art-Net: 0-32767).
function artnetPacket(wireUniverse, sequence, data) {
  const len = 512;
  const b = Buffer.alloc(18 + len);
  b.write('Art-Net\0', 0, 'ascii');
  b.writeUInt16LE(0x5000, 8);            // OpOutput / ArtDMX
  b.writeUInt16BE(14, 10);               // protocol version
  b[12] = sequence & 0xff;               // 0 = sequencing disabled
  b[13] = 0;                             // physical
  b.writeUInt16LE(wireUniverse & 0x7fff, 14); // SubUni (low) + Net (high)
  b.writeUInt16BE(len, 16);
  Buffer.from(data.buffer, data.byteOffset, Math.min(len, data.length)).copy(b, 18);
  return b;
}

// universe is 1-63999 on the wire.
function sacnPacket(universe, sequence, data, priority, sourceName) {
  const total = 126 + 512;
  const b = Buffer.alloc(total);
  // Root layer
  b.writeUInt16BE(0x0010, 0);
  b.writeUInt16BE(0x0000, 2);
  b.write('ASC-E1.17\0\0\0', 4, 'ascii');
  b.writeUInt16BE(0x7000 | (total - 16), 16);
  b.writeUInt32BE(0x00000004, 18);       // VECTOR_ROOT_E131_DATA
  CID.copy(b, 22);
  // Framing layer
  b.writeUInt16BE(0x7000 | (total - 38), 38);
  b.writeUInt32BE(0x00000002, 40);       // VECTOR_E131_DATA_PACKET
  b.write(String(sourceName || 'Nomad DMX Desk').slice(0, 63), 44, 'utf8');
  b[108] = Math.max(0, Math.min(200, priority == null ? 100 : priority));
  b.writeUInt16BE(0, 109);               // sync address
  b[111] = sequence & 0xff;
  b[112] = 0;                            // options
  b.writeUInt16BE(universe, 113);
  // DMP layer
  b.writeUInt16BE(0x7000 | (total - 115), 115);
  b[117] = 0x02;                         // VECTOR_DMP_SET_PROPERTY
  b[118] = 0xa1;
  b.writeUInt16BE(0, 119);
  b.writeUInt16BE(1, 121);
  b.writeUInt16BE(513, 123);
  b[125] = 0;                            // DMX start code
  Buffer.from(data.buffer, data.byteOffset, Math.min(512, data.length)).copy(b, 126);
  return b;
}

function sacnMulticastAddr(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

module.exports = { artnetPacket, sacnPacket, sacnMulticastAddr };
