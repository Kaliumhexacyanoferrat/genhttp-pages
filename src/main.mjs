// GenHTTP Pages: publishes a static site into a GenHTTP lambda.
//
// The composite action (action.yml) fetches the site - the Pages artifact of
// the run, a folder, or a branch built with Jekyll - and hands it to this
// script, which puts it into the lambda through the REST API of GenHTTP
// Lambda.
//
// A push replaces the site and nothing else. The lambda is also changed in its
// editor, by its agent or by the owner's agent through MCP - an API beside the
// site, a database - and that stays: the newest version is read, the files the
// site owns are swapped, and the rest is saved with them as the next version.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as gha from './gha.mjs';
import { LambdaApi, ApiError } from './api.mjs';
import { collect, siteFiles, merge, same, basePaths } from './site.mjs';
import { zip, unzip } from './zip.mjs';
import { resolveKey, KeyMissing } from './credentials.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION = join(HERE, '..');
const VERSION = JSON.parse(readFileSync(join(ACTION, 'package.json'), 'utf8')).version;
const ASSISTANT = 'https://pages.genhttp.run/';

const env = process.env;

async function main() {
  const server = gha.input('server', 'https://genhttp.dev');

  let key;
  let via;

  try {
    ({ key, via } = await resolveKey());
  } catch (error) {
    if (error instanceof KeyMissing) {
      missingKey(error.message);
      return;
    }
    throw error;
  }

  const api = new LambdaApi({
    server,
    key,
    timeout: Number(gha.input('timeout', '600000')) || 600000,
    userAgent: `genhttp-pages/${VERSION} (+https://github.com/Kaliumhexacyanoferrat/genhttp-pages)`
  });

  const lambda = await api.getLambda();

  if (!lambda) {
    throw new Error(via === 'oidc'
      ? `The lambda this repository was activated for is gone - free lambdas nobody uses are removed. Activate the repository again at ${ASSISTANT}#setup.`
      : `The editor key does not open a lambda on ${server}. Check the secret (GENHTTP_KEY), or activate the repository at ${ASSISTANT}#setup.`);
  }

  if (lambda.tier === 'Demo') {
    throw new Error(`'${lambda.publicKey}' is a demo, which nobody can deploy to. Activate the repository at ${ASSISTANT}#setup.`);
  }

  gha.log(`Publishing to the lambda '${lambda.publicKey}' (${lambda.tier} tier) on ${server}.`);

  // the site
  const { folder, hidden } = locateSite();
  const site = collect(folder, { hidden });

  if (site.length === 0) {
    throw new Error(`There are no files to publish in '${folder}'.`);
  }

  const repository = env.GITHUB_REPOSITORY ?? '';
  const commit = env.GITHUB_SHA ?? '';
  const githubServer = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = repository && env.GITHUB_RUN_ID ? `${githubServer}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  const bases = basePaths(gha.input('base_path', 'auto'), repository, site.some(f => f.path === 'CNAME'));

  const { files: served, stats } = siteFiles({ site, basePaths: bases, repository });

  gha.log(`The site has ${stats.pages} files (${size(stats.siteBytes)}); ${stats.mapped} of them are stored under another name, since a lambda cannot hold theirs.`);

  if (bases.length > 0) {
    gha.log(`It is also served below ${bases.join(', ')}, where GitHub Pages would have served it.`);
  }

  const backend = backendFiles();

  const push = {
    site: served,
    handler: { name: 'pages/PagesSite.cs', data: readFileSync(join(ACTION, 'lambda', 'PagesSite.cs')) },
    entry: { name: 'lambda.cs', data: readFileSync(join(ACTION, 'lambda', 'lambda.cs')) },
    notes: { name: 'docs/pages.md', data: Buffer.from(notes({ repository, githubServer, backend: gha.input('backend') }), 'utf8') },
    product: { name: 'docs/product.md', data: Buffer.from(product({ repository, githubServer }), 'utf8') },
    backend
  };

  const shortSha = commit.slice(0, 7);
  const change = repository ? `Published ${repository}${shortSha ? '@' + shortSha : ''} with GenHTTP Pages` : 'Published with GenHTTP Pages';
  const specification = [
    'Published by the GenHTTP Pages GitHub Action: the site was replaced, everything else kept (docs/pages.md).',
    repository && `Repository: ${githubServer}/${repository}`,
    commit && `Commit: ${commit}`,
    runUrl && `Run: ${runUrl}`
  ].filter(Boolean).join('\n');

  if (gha.flag('preview')) {
    await publishPreview(api, lambda, push, { change, specification, server });
    return;
  }

  // what the lambda is now - the agent's routes, the owner's migrations - with the site swapped
  const existing = lambda.latestVersion ? unzip(await api.getVersionZip(lambda.latestVersion)) : [];
  const { files, entryReplaced, kept } = merge(existing, push);

  if (kept.length > 0) {
    gha.log(`Kept from the lambda: ${kept.slice(0, 8).join(', ')}${kept.length > 8 ? ` and ${kept.length - 8} more` : ''}.`);
  }

  if (entryReplaced) {
    gha.log('lambda.cs did not serve the site yet; it does now.');
  }

  await checkSize(api, lambda, files.reduce((sum, f) => sum + f.data.length, 0));

  const unchanged = same(existing, files);

  let deployedVersion;
  let address;

  if (unchanged) {
    if (lambda.activeVersion === lambda.latestVersion) {
      gha.log(`Nothing changed since version ${lambda.latestVersion}, which is online.`);
      deployedVersion = lambda.latestVersion;
      address = lambda.address;
    } else {
      gha.log(`Nothing changed since version ${lambda.latestVersion}; putting it online.`);
      const outcome = await api.deploy(lambda.latestVersion);
      ensureDeployed(outcome, lambda.latestVersion);
      deployedVersion = lambda.latestVersion;
      address = outcome.lambda?.address ?? lambda.address;
    }
  } else {
    const archive = zip(files);

    gha.log(`Uploading ${files.length} files (${size(archive.length)} packed).`);

    const saved = await api.saveVersion(archive, { deploy: true, change, specification });

    ensureDeployed(saved.deployment, saved.version);

    deployedVersion = saved.version;
    address = saved.deployment.lambda?.address ?? lambda.address;

    gha.log(`Version ${saved.version} is online.`);
  }

  const pageUrl = address.endsWith('/') ? address : address + '/';

  gha.output('page_url', pageUrl);
  gha.output('version', String(deployedVersion));

  gha.notice(`Published to ${pageUrl}`);

  gha.summary([
    '### 🚀 Published with GenHTTP Pages',
    '',
    `**${pageUrl}**`,
    '',
    '| | |',
    '|---|---|',
    `| Lambda | \`${lambda.publicKey}\` (${lambda.tier}) |`,
    `| Version | ${deployedVersion}${unchanged ? ' (unchanged)' : ''} |`,
    `| Files | ${stats.pages} (${size(stats.siteBytes)}) |`,
    bases.length ? `| Also below | ${bases.map(b => '`' + b + '/`').join(', ')} |` : '',
    ''
  ].filter(line => line !== '').join('\n') + '\n');
}

/**
 * Where the site is, as the composite action laid it out.
 */
function locateSite() {
  const mode = env.GENHTTP_PAGES_MODE ?? 'artifact';
  const source = env.GENHTTP_PAGES_SOURCE ?? '';
  const hidden = gha.flag('include_hidden_files');

  if (mode === 'path' || mode === 'branch') {
    return { folder: source, hidden };
  }

  // an artifact made by actions/upload-pages-artifact holds artifact.tar,
  // which already left out what it was told to
  const tar = join(source, 'artifact.tar');

  if (!existsSync(tar)) {
    if (existsSync(source) && readdirSync(source).length > 0) {
      gha.warning(`The artifact has no artifact.tar, as actions/upload-pages-artifact makes it; publishing its files as they are.`);
      return { folder: source, hidden: true };
    }

    throw new Error(`The artifact '${gha.input('artifact_name', 'github-pages')}' holds no site. Upload it with actions/upload-pages-artifact before this step, or name a folder with 'path'.`);
  }

  const folder = mkdtempSync(join(env.RUNNER_TEMP ?? tmpdir(), 'genhttp-pages-site-'));

  execFileSync('tar', ['-xf', 'artifact.tar', '-C', folder], { cwd: source, stdio: ['ignore', 'ignore', 'inherit'] });

  return { folder, hidden: true };
}

/**
 * C# of the repository's own, from the 'backend' input: its lambda.cs
 * replaces the lambda's, its resources/ join the lambda's, and the rest is
 * backend/ - all owned by the repository from then on.
 */
function backendFiles() {
  const folder = gha.input('backend');

  if (!folder) {
    return { entry: null, files: [] };
  }

  const found = collect(folder, { hidden: true }).filter(f => !/(^|\/)(bin|obj|node_modules)\//.test(f.path));

  let entry = null;
  const files = [];

  for (const file of found) {
    if (file.path === 'lambda.cs') {
      entry = { name: 'lambda.cs', data: file.data };
    } else if (file.path.startsWith('resources/')) {
      // what the backend reads while it runs, its migrations among them
      if (/^resources\/(site\/|blobs\/|pages\.json$)/.test(file.path)) {
        throw new Error(`The backend may not bring '${file.path}': resources/site/, resources/blobs/ and resources/pages.json are the site's.`);
      }
      files.push({ name: file.path, data: file.data });
    } else {
      files.push({ name: 'backend/' + file.path, data: file.data });
    }
  }

  gha.log(`Adding the backend in '${folder}': ${found.length} files${entry ? ', with its own lambda.cs' : ''}.`);

  return { entry, files };
}

/**
 * docs/pages.md: what a push replaces and what it keeps - for whoever changes
 * the lambda in its editor next, the agent first of all, which reads docs/.
 */
function notes({ repository, githubServer, backend }) {
  const from = repository ? `[${repository}](${githubServer}/${repository})` : 'a repository';

  return [
    '# Published from GitHub',
    '',
    `This lambda serves the static site of ${from}, published by the [GenHTTP Pages](${ASSISTANT}) GitHub Action on every push.`,
    '',
    '## What a push replaces',
    '',
    '- `resources/site/`, `resources/blobs/` and `resources/pages.json`: the site, as the repository builds it.',
    '- `pages/PagesSite.cs`: serves the site the way GitHub Pages does.',
    backend ? `- \`lambda.cs\`, \`backend/\` and the resources of \`${backend}/\`: they come from the repository's \`${backend}/\` folder.` : null,
    '- this page.',
    '',
    'Change these in the repository: a change made to them here is gone with the next push.',
    '',
    '## What stays',
    '',
    backend
      ? 'Everything else: other C# files, migrations, the documentation and the tests.'
      : 'Everything else: `lambda.cs`, routes in other C# files, migrations in `resources/migrations/`, the documentation and the tests.',
    '',
    'An API beside the site is a route in front of it in `lambda.cs`, which keeps serving the site last:',
    '',
    '```csharp',
    'return Layout.Create()',
    '             .Add("api", api)',
    '             .Add(PagesSite.Create());',
    '```',
    '',
    'A `lambda.cs` without `PagesSite.Create()` is replaced by the next push. The pages of the site call the API with relative paths (`fetch(\'api/...\')`); a page that needs a form or a button for it is changed in the repository.',
    ''
  ].filter(line => line !== null).join('\n');
}

/** docs/product.md, for a lambda that has none: the lambda's own from then on. */
function product({ repository, githubServer }) {
  const name = repository ? repository.split('/')[1] : 'A static site';
  const from = repository ? `[${repository}](${githubServer}/${repository})` : 'a repository';

  return [
    `# ${name}`,
    '',
    `The website of ${from}, published from GitHub with GenHTTP Pages. [pages.md](pages.md) says what comes from the repository and what is kept here.`,
    ''
  ].join('\n');
}

async function checkSize(api, lambda, bytes) {
  if (lambda.tier !== 'Free') {
    return;
  }

  let allowed;

  try {
    allowed = (await api.getSystem())?.buildBytes;
  } catch {
    return;
  }

  if (allowed && bytes > allowed) {
    throw new Error(`The site comes to ${size(bytes)}, and a lambda of the free tier may hold ${size(allowed)}. `
      + `Leave out what the site does not need (source maps, originals of pictures), or ask for the premium tier.`);
  }
}

function ensureDeployed(outcome, version) {
  if (outcome?.success) {
    return;
  }

  for (const d of outcome?.diagnostics ?? []) {
    const where = d.file ? `${d.file}(${d.line},${d.column}): ` : '';
    gha.error(`${where}${d.id ?? ''} ${d.message}`);
  }

  throw new Error(`Version ${version} was saved but could not be put online; what was online before stays online. See the errors above.`);
}

async function publishPreview(api, lambda, push, { change, specification, server }) {
  if (!lambda.latestVersion) {
    throw new Error('A preview is made from the site online. Deploy without preview once first.');
  }

  const name = previewName();

  const features = await api.listFeatures();

  let feature = features.find(f => f.name === name);

  if (!feature) {
    feature = await api.createFeature(name, specification);
    gha.log(`Started the feature '${name}' for the preview.`);
  }

  // the feature holds what the lambda held when it started, and what was changed in it since
  const { files } = merge(unzip(await api.getFeatureZip(feature.key)), push);

  const saved = await api.saveFeature(feature.key, zip(files), { change, specification });

  if (!saved.preview?.success) {
    for (const d of saved.preview?.diagnostics ?? []) {
      gha.error(`${d.file ? `${d.file}(${d.line},${d.column}): ` : ''}${d.message}`);
    }
    throw new Error('The preview was saved but could not be put online.');
  }

  const path = saved.preview.feature?.previewPath ?? saved.feature.previewPath;
  const pageUrl = new URL(path.endsWith('/') ? path : path + '/', server + '/').href;

  gha.output('page_url', pageUrl);
  gha.notice(`Preview online at ${pageUrl}`);
  gha.summary(`### 🔍 GenHTTP Pages preview\n\n**${pageUrl}**\n\nThe preview is the feature \`${name}\` of \`${lambda.publicKey}\`; delete it in the editor once it is no longer needed.\n`);
}

function previewName() {
  const pull = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '');

  if (pull) {
    return `preview-pr-${pull[1]}`;
  }

  const branch = (env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || 'preview').replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 40);

  return `preview-${branch}`;
}

function missingKey(reason) {
  gha.error(reason);

  gha.summary([
    '### 🔑 GenHTTP Pages does not know where to publish',
    '',
    reason,
    '',
    `1. Activate the repository at **[${ASSISTANT}](${ASSISTANT}#setup)** - one click, no account. You get the link to its editor and an activation code.`,
    '2. Hand the code to this step once, and keep `id-token: write` in the permissions of the job, as Pages workflows have it:',
    '',
    '```yaml',
    '- uses: Kaliumhexacyanoferrat/genhttp-pages@v1',
    '  with:',
    '    activation: gp-xxxxx-xxxxx-xxxxx-xxxxx',
    '```',
    '',
    '3. Run the workflow again.'
  ].join('\n') + '\n');

  process.exitCode = 1;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch(error => {
  gha.error(error instanceof ApiError || error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
