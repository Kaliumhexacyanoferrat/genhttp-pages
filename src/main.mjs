// GenHTTP Pages: publishes a static site into a GenHTTP lambda.
//
// The composite action (action.yml) fetches the site - the Pages artifact of
// the run, a folder, or a branch built with Jekyll - and hands it to this
// script, which packs it as a lambda version and puts it online through the
// REST API of GenHTTP Lambda.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as gha from './gha.mjs';
import { LambdaApi, ApiError } from './api.mjs';
import { collect, build, basePaths, MANIFEST } from './site.mjs';
import { zip } from './zip.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTION = join(HERE, '..');
const VERSION = JSON.parse(readFileSync(join(ACTION, 'package.json'), 'utf8')).version;
const ASSISTANT = 'https://pages.genhttp.run/';

const env = process.env;

async function main() {
  const key = gha.input('key') || env.GENHTTP_KEY || '';
  const server = gha.input('server', 'https://genhttp.dev');

  if (!key) {
    missingKey();
    return;
  }

  gha.mask(key);

  const api = new LambdaApi({
    server,
    key,
    timeout: Number(gha.input('timeout', '600000')) || 600000,
    userAgent: `genhttp-pages/${VERSION} (+https://github.com/Kaliumhexacyanoferrat/genhttp-pages)`
  });

  const lambda = await api.getLambda();

  if (!lambda) {
    throw new Error(`The editor key does not open a lambda on ${server}. Check the secret (GENHTTP_KEY), or create a lambda at ${ASSISTANT}.`);
  }

  if (lambda.tier === 'Demo') {
    throw new Error(`'${lambda.publicKey}' is a demo, which nobody can deploy to. Create a lambda of your own at ${ASSISTANT}.`);
  }

  gha.log(`Publishing to the lambda '${lambda.publicKey}' (${lambda.tier} tier) on ${server}.`);

  // the site
  const { folder, hidden } = locateSite();
  const site = collect(folder, { hidden });

  if (site.length === 0) {
    throw new Error(`There are no files to publish in '${folder}'.`);
  }

  // the program around it
  const program = programFiles();
  const backend = backendFiles();

  const repository = env.GITHUB_REPOSITORY ?? '';
  const commit = env.GITHUB_SHA ?? '';
  const githubServer = env.GITHUB_SERVER_URL ?? 'https://github.com';
  const runUrl = repository && env.GITHUB_RUN_ID ? `${githubServer}/${repository}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  const bases = basePaths(gha.input('base_path', 'auto'), repository, site.some(f => f.path === 'CNAME'));

  const version = build({
    site,
    program: backend.entry ? program.filter(f => f.name !== 'lambda.cs').concat(backend.entry) : program,
    backend: backend.files,
    basePaths: bases,
    source: { generator: `genhttp-pages@${VERSION}`, repository, commit, run: runUrl },
    product: product({ repository, commit, githubServer, runUrl, backend: backend.files.length > 0 || !!backend.entry })
  });

  const { stats } = version;

  gha.log(`The site has ${stats.pages} files (${size(stats.siteBytes)}); ${stats.mapped} of them are stored under another name, since a lambda cannot hold theirs.`);

  if (bases.length > 0) {
    gha.log(`It is also served below ${bases.join(', ')}, where GitHub Pages would have served it.`);
  }

  await checkSize(api, lambda, stats.bytes);

  const archive = zip(version.files.map(f => ({ name: f.name, data: f.data })));

  const shortSha = commit.slice(0, 7);
  const change = repository ? `Published ${repository}${shortSha ? '@' + shortSha : ''} with GenHTTP Pages` : 'Published with GenHTTP Pages';
  const specification = [
    'Deployed by the GenHTTP Pages GitHub Action. The next deployment replaces every file, so change the site in its repository rather than here.',
    repository && `Repository: ${githubServer}/${repository}`,
    commit && `Commit: ${commit}`,
    runUrl && `Run: ${runUrl}`
  ].filter(Boolean).join('\n');

  if (gha.flag('preview')) {
    await publishPreview(api, lambda, archive, { change, specification, server });
    return;
  }

  // the same site as the newest version, which is online: nothing to do
  const unchanged = await sameAsNewest(api, lambda, version.digest);

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
    gha.log(`Uploading ${version.files.length} files (${size(archive.length)} packed).`);

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
 * The program every site gets: lambda.cs and the handler.
 */
function programFiles() {
  return [
    { name: 'lambda.cs', data: readFileSync(join(ACTION, 'lambda', 'lambda.cs')) },
    { name: 'pages/PagesSite.cs', data: readFileSync(join(ACTION, 'lambda', 'PagesSite.cs')) }
  ];
}

/**
 * C# of the site's own, from the 'backend' input: its lambda.cs replaces the
 * one that only serves the site, and the rest go to backend/.
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
    } else {
      files.push({ name: 'backend/' + file.path, data: file.data });
    }
  }

  gha.log(`Adding the backend in '${folder}': ${found.length} files${entry ? ', with its own lambda.cs' : ''}.`);

  return { entry, files };
}

function product({ repository, commit, githubServer, runUrl, backend }) {
  const lines = [
    `# ${repository ? repository.split('/')[1] : 'A static site'} on GenHTTP Pages`,
    '',
    `The static site of ${repository ? `[${repository}](${githubServer}/${repository})` : 'a repository'}, published by the [GenHTTP Pages](${ASSISTANT}) GitHub Action`
      + `${commit ? ` from commit \`${commit.slice(0, 7)}\`` : ''}${runUrl ? ` ([run](${runUrl}))` : ''}.`,
    '',
    'Every deployment replaces all files of this lambda, so a change made here is gone with the next push. Change the repository instead.',
    '',
    '- `resources/site/` holds the site, and `resources/blobs/` the files whose names a lambda cannot hold.',
    '- `resources/pages.json` maps every path of the site to where it is stored.',
    '- `pages/PagesSite.cs` serves it the way GitHub Pages does.',
    backend ? '- `lambda.cs` and `backend/` come from the repository: the routes it adds beside the site.' : '- `lambda.cs` returns the site.',
    ''
  ];

  return lines.join('\n');
}

async function sameAsNewest(api, lambda, digest) {
  if (!lambda.latestVersion) {
    return false;
  }

  try {
    const [newest] = await api.getVersions();

    // a version saved in the editor or by an agent since is not ours to keep
    if (!newest || newest.version !== lambda.latestVersion || (newest.origin ?? '').toLowerCase() !== 'api') {
      return false;
    }

    const [manifest] = await api.getVersionFiles(lambda.latestVersion, MANIFEST);

    if (!manifest || manifest.name !== MANIFEST) {
      return false;
    }

    const text = manifest.encoding === 'base64' ? Buffer.from(manifest.code, 'base64').toString('utf8') : manifest.code;

    return JSON.parse(text).digest === digest;
  } catch {
    return false;
  }
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

async function publishPreview(api, lambda, archive, { change, specification, server }) {
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

  const saved = await api.saveFeature(feature.key, archive, { change, specification });

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

function missingKey() {
  const repository = env.GITHUB_REPOSITORY;
  const secrets = repository ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/settings/secrets/actions/new` : 'the settings of the repository';

  gha.error(`GenHTTP Pages needs the editor key of a lambda to publish to. Create one at ${ASSISTANT}, store it as the secret GENHTTP_KEY (${secrets}) and pass it with 'key: \${{ secrets.GENHTTP_KEY }}'.`);

  gha.summary([
    '### 🔑 GenHTTP Pages needs a key',
    '',
    'The site is ready, but there is no lambda to publish it to yet.',
    '',
    `1. Create a lambda at **[${ASSISTANT}](${ASSISTANT})** — one click, no account.`,
    `2. Store its editor key as the repository secret \`GENHTTP_KEY\`: [${secrets}](${secrets})`,
    '3. Hand it to this step:',
    '',
    '```yaml',
    '- uses: Kaliumhexacyanoferrat/genhttp-pages@v1',
    '  with:',
    '    key: ${{ secrets.GENHTTP_KEY }}',
    '```',
    '',
    '4. Run the workflow again.'
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
