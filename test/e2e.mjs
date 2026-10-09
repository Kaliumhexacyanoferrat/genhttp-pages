// Checks a published fixture the way a browser would see it on GitHub Pages.
// node test/e2e.mjs <page url> site|jekyll

import assert from 'node:assert/strict';

const [base, suite = 'site'] = process.argv.slice(2);

if (!base) {
  console.error('usage: node test/e2e.mjs <page url> site|jekyll');
  process.exit(2);
}

const url = (path) => new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : base + '/');

async function get(path, init = {}) {
  const response = await fetch(url(path), { redirect: 'manual', ...init });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const checks = {
  site: [
    ['the index of the root', async () => { const r = await get('/'); assert.equal(r.status, 200); assert.match(r.text, /fixture-index/); assert.match(r.headers.get('content-type'), /^text\/html/); }],
    ['a page without its extension', async () => assert.match((await get('/about')).text, /fixture-about/)],
    ['a folder without its slash is redirected', async () => { const r = await get('/docs?x=1'); assert.equal(r.status, 301); assert.match(r.headers.get('location'), /docs\/\?x=1$/); }],
    ['the index of a folder', async () => assert.match((await get('/docs/')).text, /fixture-docs/)],
    ['a page in a folder without its extension', async () => assert.match((await get('/docs/install')).text, /fixture-install/)],
    ['a name with spaces', async () => assert.match((await get('/file%20with%20spaces.txt')).text, /fixture-spaces/)],
    ['a name with other letters', async () => assert.match((await get('/caf%C3%A9.html')).text, /fixture-café/)],
    ['a file seven folders deep', async () => assert.match((await get('/deep/a/b/c/d/e/f/g.html')).text, /fixture-deep/)],
    ['a file without an extension', async () => assert.match((await get('/LICENSE')).text, /fixture-license/)],
    ['a hidden folder that was included', async () => assert.match((await get('/.well-known/security.txt')).text, /Contact/)],
    ['a post in deep folders', async () => assert.match((await get('/blog/2026/10/09/hello-world/')).text, /fixture-post/)],
    ['styles', async () => { const r = await get('/assets/style.css'); assert.match(r.headers.get('content-type'), /^text\/css/); }],
    ['modules', async () => { const r = await get('/assets/app.mjs'); assert.match(r.headers.get('content-type'), /javascript/); }],
    ['pictures', async () => { const r = await get('/assets/pixel.png'); assert.equal(r.headers.get('content-type'), 'image/png'); }],
    ['the 404 page of the site', async () => { const r = await get('/nope'); assert.equal(r.status, 404); assert.match(r.text, /fixture-404/); }],
    ['the site below the name of its repository', async () => assert.match((await get('/genhttp-pages/about')).text, /fixture-about/)],
    ['GitHub Pages headers', async () => { const r = await get('/'); assert.equal(r.headers.get('access-control-allow-origin'), '*'); assert.equal(r.headers.get('cache-control'), 'max-age=600'); }],
    ['an unchanged file is answered with 304', async () => {
      const tag = (await get('/about')).headers.get('etag');
      assert.ok(tag && !tag.includes(','), `one entity tag, got ${tag}`);
      assert.equal((await get('/about', { headers: { 'If-None-Match': tag } })).status, 304);
    }],
    ['other methods are refused', async () => assert.equal((await get('/', { method: 'POST' })).status, 405)]
  ],
  jekyll: [
    ['the index rendered from Markdown', async () => { const r = await get('/'); assert.equal(r.status, 200); assert.match(r.text, /<h1[^>]*>jekyll-index<\/h1>/); }],
    ['a page rendered from Markdown', async () => assert.match((await get('/about')).text, /<h1[^>]*>jekyll-about<\/h1>/)],
    ['a post at its permalink', async () => assert.match((await get('/2026/10/09/hello.html')).text, /jekyll-post/)],
    ['the sources are not published', async () => assert.equal((await get('/_config.yml')).status, 404)]
  ]
};

let failed = 0;

for (const [name, check] of checks[suite]) {
  try {
    await check();
    console.log(`✔ ${name}`);
  } catch (error) {
    failed++;
    console.log(`✘ ${name}: ${error.message}`);
  }
}

console.log(`${checks[suite].length - failed} of ${checks[suite].length} passed at ${base}`);
process.exitCode = failed ? 1 : 0;
