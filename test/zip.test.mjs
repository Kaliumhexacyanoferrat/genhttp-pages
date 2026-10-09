import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as nodeCrc32 } from 'node:zlib';

import { zip, crc32, unzip } from '../src/zip.mjs';

const unzipped = (archive) => new Map(unzip(archive).map(f => [f.name, f.data]));

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

  const files = unzipped(zip(entries));

  assert.deepEqual([...files.keys()], entries.map(e => e.name));

  for (const entry of entries) {
    assert.deepEqual(files.get(entry.name), entry.data);
  }
});

test('the same files pack to the same bytes', () => {
  const entries = [{ name: 'a.txt', data: Buffer.from('a'.repeat(500)) }];

  assert.deepEqual(zip(entries), zip(entries));
});
