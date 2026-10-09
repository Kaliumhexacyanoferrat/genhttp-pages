import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync, crc32 as nodeCrc32 } from 'node:zlib';

import { zip, crc32 } from '../src/zip.mjs';

// reads an archive back through its central directory
function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const packed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');

    const localName = archive.readUInt16LE(offset + 26);
    const localExtra = archive.readUInt16LE(offset + 28);
    const body = archive.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + packed);
    const data = method === 8 ? inflateRawSync(body) : body;

    assert.equal(crc32(data), crc, name);
    files.set(name, data);
    at += 46 + nameLength;
  }

  return files;
}

test('crc32 matches the one zlib computes', { skip: !nodeCrc32 }, () => {
  for (const text of ['', 'a', 'The quick brown fox jumps over the lazy dog', 'é'.repeat(1000)]) {
    assert.equal(crc32(Buffer.from(text)), nodeCrc32(Buffer.from(text)));
  }
});

test('an archive holds what was packed', () => {
  const entries = [
    { name: 'lambda.cs', data: Buffer.from('return PagesSite.Create();') },
    { name: 'resources/site/index.html', data: Buffer.from('<p>' + 'hello '.repeat(200) + '</p>') },
    { name: 'resources/blobs/x.bin', data: Buffer.from([0, 1, 2, 255]) },
    { name: 'docs/café.md', data: Buffer.alloc(0) }
  ];

  const files = unzip(zip(entries));

  assert.deepEqual([...files.keys()], entries.map(e => e.name));

  for (const entry of entries) {
    assert.deepEqual(files.get(entry.name), entry.data);
  }
});

test('the same files pack to the same bytes', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('a'.repeat(500)) }];

  assert.deepEqual(zip(entries), zip(entries));
});
