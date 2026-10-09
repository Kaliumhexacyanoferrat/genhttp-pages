import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { isResourceName, place, basePaths, build, collect, MANIFEST } from '../src/site.mjs';

const file = (path, text = path) => ({ path, data: Buffer.from(text) });

test('names a lambda can hold stay where they are', () => {
  for (const name of ['site/index.html', 'site/assets/app.min.js', 'site/a/b/c/d/e.css', 'site/Read_Me-1.md']) {
    assert.ok(isResourceName(name), name);
  }
});

test('names a lambda cannot hold are recognised', () => {
  for (const name of ['site/with space.html', 'site/LICENSE', 'site/.well-known/x.txt', 'site/a/b/c/d/e/f.html',
    'site/café.html', 'site/file.', 'site/' + 'x'.repeat(61) + '.html', 'site/' + 'a/'.repeat(4) + 'x'.repeat(110) + '.js', 'site/a+b.js']) {
    assert.equal(isResourceName(name), false, name);
  }
});

test('files that do not fit are stored by their content', () => {
  const { entries, resources, mapped } = place([file('LICENSE'), file('index.html'), file('with space.txt')]);

  assert.equal(entries.get('index.html')[0], 'site/index.html');
  assert.match(entries.get('LICENSE')[0], /^blobs\/[0-9a-f]{32}\.bin$/);
  assert.match(entries.get('with space.txt')[0], /^blobs\/[0-9a-f]{32}\.txt$/);
  assert.equal(mapped, 2);
  assert.equal(resources.size, 3);
});

test('names that differ only by case do not collide', () => {
  const { entries, resources } = place([file('Foo.html', 'upper'), file('foo.html', 'lower')]);

  assert.equal(entries.get('Foo.html')[0], 'site/Foo.html');
  assert.match(entries.get('foo.html')[0], /^blobs\//);
  assert.equal(resources.get(entries.get('foo.html')[0]).toString(), 'lower');
});

test('a file and a folder of the same name in another case do not collide', () => {
  const { entries } = place([file('A.css/x.css'), file('a.css')]);

  assert.equal(entries.get('A.css/x.css')[0], 'site/A.css/x.css');
  assert.match(entries.get('a.css')[0], /^blobs\//);
});

test('the same content stored under a neutral name is stored once', () => {
  const { entries, resources } = place([file('a b.txt', 'same'), file('c d.txt', 'same')]);

  assert.equal(entries.get('a b.txt')[0], entries.get('c d.txt')[0]);
  assert.equal(resources.size, 1);
});

test('a project page is also served below the name of its repository', () => {
  assert.deepEqual(basePaths('auto', 'octo/docs', false), ['/docs']);
  assert.deepEqual(basePaths('auto', 'octo/octo.github.io', false), []);
  assert.deepEqual(basePaths('auto', 'octo/docs', true), []);
  assert.deepEqual(basePaths('none', 'octo/docs', false), []);
  assert.deepEqual(basePaths('', 'octo/docs', false), []);
  assert.deepEqual(basePaths('/a/, b', 'octo/docs', false), ['/a', '/b']);
});

test('the version starts with lambda.cs and holds the manifest', () => {
  const version = build({
    site: [file('index.html')],
    program: [{ name: 'pages/PagesSite.cs', data: Buffer.from('//') }, { name: 'lambda.cs', data: Buffer.from('return PagesSite.Create();') }],
    basePaths: ['/repo'],
    product: '# x'
  });

  assert.equal(version.files[0].name, 'lambda.cs');

  const manifest = JSON.parse(version.files.find(f => f.name === MANIFEST).data);

  assert.equal(manifest.digest, version.digest);
  assert.deepEqual(manifest.basePaths, ['/repo']);
  assert.equal(manifest.files['index.html'][0], 'site/index.html');
  assert.ok(version.files.some(f => f.name === 'resources/site/index.html'));
});

test('the digest ignores where the site came from, not what it is', () => {
  const make = (commit, text) => build({
    site: [file('index.html', text)],
    program: [{ name: 'lambda.cs', data: Buffer.from('x') }],
    source: { commit },
    product: commit
  }).digest;

  assert.equal(make('a', 'same'), make('b', 'same'));
  assert.notEqual(make('a', 'one'), make('a', 'two'));
});

test('the fixture site is collected without hidden files unless asked', () => {
  const root = fileURLToPath(new URL('./fixtures/site', import.meta.url));

  assert.ok(!collect(root).some(f => f.path.startsWith('.well-known/')));
  assert.ok(collect(root, { hidden: true }).some(f => f.path === '.well-known/security.txt'));
});
