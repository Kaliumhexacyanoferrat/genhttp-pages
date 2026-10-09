import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { isResourceName, place, basePaths, siteFiles, merge, same, collect, MANIFEST } from '../src/site.mjs';

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


test('the fixture site is collected without hidden files unless asked', () => {
  const root = fileURLToPath(new URL('./fixtures/site', import.meta.url));

  assert.ok(!collect(root).some(f => f.path.startsWith('.well-known/')));
  assert.ok(collect(root, { hidden: true }).some(f => f.path === '.well-known/security.txt'));
});test('the site owns the manifest and its files, and nothing in them names the commit', () => {
  const { files } = siteFiles({ site: [file('index.html')], basePaths: ['/repo'], repository: 'octo/docs' });

  const manifest = JSON.parse(files.find(f => f.name === MANIFEST).data);

  assert.deepEqual(manifest.basePaths, ['/repo']);
  assert.equal(manifest.files['index.html'][0], 'site/index.html');
  assert.ok(files.some(f => f.name === 'resources/site/index.html'));

  // the same site makes the same files
  const again = siteFiles({ site: [file('index.html')], basePaths: ['/repo'], repository: 'octo/docs' }).files;
  assert.ok(same(files, again));
});

const named = (name, text) => ({ name, data: Buffer.from(text) });

const push = (siteText = 'site', extra = {}) => ({
  site: siteFiles({ site: [file('index.html', siteText)], repository: 'octo/docs' }).files,
  handler: named('pages/PagesSite.cs', '// handler'),
  entry: named('lambda.cs', 'return PagesSite.Create();'),
  notes: named('docs/pages.md', '# notes'),
  product: named('docs/product.md', '# product'),
  ...extra
});

test('a push swaps the site and keeps what an agent added', () => {
  const existing = [
    named('lambda.cs', 'return Layout.Create().Add("api", Signups.Api()).Add(PagesSite.Create());'),
    named('Signups.cs', 'class Signups {}'),
    named('resources/migrations/V1__Create_signups.sql', 'CREATE TABLE signups (email TEXT);'),
    named('docs/product.md', '# written by the agent'),
    named('pages/PagesSite.cs', '// old handler'),
    named(MANIFEST, '{}'),
    named('resources/site/old.html', 'gone')
  ];

  const { files, entryReplaced } = merge(existing, push());
  const byName = new Map(files.map(f => [f.name, f.data.toString()]));

  assert.equal(files[0].name, 'lambda.cs');
  assert.match(byName.get('lambda.cs'), /Signups/);
  assert.equal(entryReplaced, false);
  assert.ok(byName.has('Signups.cs'));
  assert.ok(byName.has('resources/migrations/V1__Create_signups.sql'));
  assert.equal(byName.get('docs/product.md'), '# written by the agent');
  assert.equal(byName.get('pages/PagesSite.cs'), '// handler');
  assert.ok(byName.has('resources/site/index.html'));
  assert.ok(!byName.has('resources/site/old.html'));
});

test('a lambda.cs that does not serve the site is replaced', () => {
  const { files, entryReplaced } = merge([named('lambda.cs', 'return Inline.Create().Get(() => "Hello");')], push());

  assert.equal(files[0].data.toString(), 'return PagesSite.Create();');
  assert.equal(entryReplaced, true);
  assert.ok(files.some(f => f.name === 'docs/product.md'));
});

test('a backend from the repository owns lambda.cs and backend/', () => {
  const existing = [
    named('lambda.cs', 'return Layout.Create().Add(PagesSite.Create());'),
    named('backend/Old.cs', 'class Old {}'),
    named('Agent.cs', 'class Agent {}')
  ];

  const backend = { entry: named('lambda.cs', 'return Layout.Create().Add("api", Api.Create()).Add(PagesSite.Create());'), files: [named('backend/Api.cs', 'class Api {}')] };

  const names = merge(existing, push('site', { backend })).files.map(f => f.name);

  assert.ok(names.includes('backend/Api.cs'));
  assert.ok(!names.includes('backend/Old.cs'));
  assert.ok(names.includes('Agent.cs'));
});

test('the same site pushed onto what it made changes nothing', () => {
  const first = merge([named('lambda.cs', 'return Inline.Create();')], push()).files;

  // as the lambda hands the version back: copies, in another order
  const stored = first.map(f => ({ name: f.name, data: Buffer.from(f.data) })).reverse();

  assert.ok(same(stored, merge(stored, push()).files));
  assert.ok(!same(stored, merge(stored, push('changed')).files));
});

test('the fixture site is collected without hidden files unless asked', () => {
  const root = fileURLToPath(new URL('./fixtures/site', import.meta.url));

  assert.ok(!collect(root).some(f => f.path.startsWith('.well-known/')));
  assert.ok(collect(root, { hidden: true }).some(f => f.path === '.well-known/security.txt'));
});
