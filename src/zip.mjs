// A small zip writer, so the action needs nothing but Node itself.
//
// Entries are deflated when that makes them smaller and stored otherwise
// (pictures and fonts are compressed already). Names are flagged as UTF-8.
// No zip64: a lambda's version is far below the four gigabytes it is for.

import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 2000-01-01 00:00, so the same files always pack to the same bytes
const DOS_TIME = 0;
const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1;

/**
 * Packs the given entries into a zip archive.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    let method = 0;
    let body = data;

    if (data.length > 64) {
      const deflated = deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);          // made by
    header.writeUInt16LE(20, 6);          // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);          // extra
    header.writeUInt16LE(0, 32);          // comment
    header.writeUInt16LE(0, 34);          // disk
    header.writeUInt16LE(0, 36);          // internal attributes
    header.writeUInt32LE(0, 38);          // external attributes
    header.writeUInt32LE(offset, 42);

    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((sum, b) => sum + b.length, 0);

  if (entries.length > 0xffff || offset > 0xffffffff) {
    throw new Error('The site has too many files or bytes for one archive.');
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

/**
 * Reads the files of a zip archive through its central directory: stored or
 * deflated entries, as GenHTTP Lambda packs a version. Folders are skipped.
 * @param {Buffer} archive
 * @returns {{ name: string, data: Buffer }[]}
 */
export function unzip(archive) {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = archive.lastIndexOf(signature);

  if (end < 0) {
    throw new Error('The archive the lambda answered with is not a zip.');
  }

  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);

  const files = [];

  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('The archive the lambda answered with is damaged.');
    }

    const flags = archive.readUInt16LE(at + 8);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x0800 ? 'utf8' : 'latin1');

    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) {
      continue;
    }

    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const body = archive.subarray(start, start + packed);

    let data;

    if (method === 0) {
      data = Buffer.from(body);
    } else if (method === 8) {
      data = inflateRawSync(body);
    } else {
      throw new Error(`'${name}' is packed in a way this action does not read (method ${method}).`);
    }

    if (crc32(data) !== crc) {
      throw new Error(`'${name}' arrived damaged.`);
    }

    files.push({ name, data });
  }

  return files;
}
