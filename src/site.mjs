// Turns a folder of static files into the files of a lambda version.
//
// A lambda serves what it ships below resources/, under stricter names than a
// web site may use: letters, digits, dashes, underscores and dots, an
// extension, nothing starting with a dot, six folders deep and 120 characters
// at most, and no two names that differ only by case. Files that fit are
// stored where they are (resources/site/<path>), so the editor shows the site
// as it is; the rest under a name made from their content
// (resources/blobs/<hash>.<ext>). resources/pages.json maps every path of the
// site to what it was stored as, and lambda/PagesSite.cs serves through it.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SITE = 'site/';
export const BLOBS = 'blobs/';
export const MANIFEST = 'resources/pages.json';

const RESOURCE_MAX_LENGTH = 120;
const RESOURCE_MAX_SEGMENTS = 6;
const SEGMENT_MAX_LENGTH = 60;

/**
 * Reads every file below a folder, as a list sorted by path.
 * @param {string} root
 * @param {{ hidden?: boolean }} options include files and folders starting with a dot (never .git or .github)
 * @returns {{ path: string, data: Buffer }[]}
 */
export function collect(root, { hidden = false } = {}) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`There is no folder at '${root}' to publish.`);
  }

  const files = [];
  const seen = new Set();

  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = entry.name;

      if (name === '.git' || name === '.github') {
        continue;
      }

      if (!hidden && name.startsWith('.')) {
        continue;
      }

      const full = join(folder, name);

      // follow links, as upload-pages-artifact does with --dereference
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue; // a dangling link
      }

      if (stats.isDirectory()) {
        const real = `${stats.dev}:${stats.ino}`;
        if (seen.has(real)) {
          continue; // a link back up the tree
        }
        seen.add(real);
        walk(full);
      } else if (stats.isFile()) {
        files.push({ path: relative(root, full).split(sep).join('/'), data: readFileSync(full) });
      }
    }
  };

  walk(root);

  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Whether a lambda can hold a resource under this name (without resources/).
 */
export function isResourceName(rest) {
  if (!rest || rest.length > RESOURCE_MAX_LENGTH || rest.startsWith('/') || rest.endsWith('/')) {
    return false;
  }

  const segments = rest.split('/');

  if (segments.length > RESOURCE_MAX_SEGMENTS) {
    return false;
  }

  for (const segment of segments) {
    if (segment.length === 0 || segment.length > SEGMENT_MAX_LENGTH || segment.startsWith('.')) {
      return false;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(segment)) {
      return false;
    }
  }

  const last = segments[segments.length - 1];
  const dot = last.lastIndexOf('.');

  // an extension of at least one character
  return dot > 0 && dot < last.length - 1;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function blobName(path, hash) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  let extension = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';

  if (!/^[a-z0-9]{1,16}$/.test(extension)) {
    extension = 'bin';
  }

  return `${BLOBS}${hash.slice(0, 32)}.${extension}`;
}

/**
 * Decides where each file of the site is stored.
 * @param {{ path: string, data: Buffer }[]} files sorted by path
 * @returns {{ entries: Map<string, [string, string]>, resources: Map<string, Buffer>, mapped: number }}
 *   entries: path of the site -> [stored name below resources/, entity tag];
 *   resources: stored name below resources/ -> content
 */
export function place(files) {
  const entries = new Map();
  const resources = new Map();

  // what is taken, in lower case: a lambda's file system may not tell case apart
  const takenFiles = new Set();
  const takenFolders = new Set();

  let mapped = 0;

  for (const { path, data } of files) {
    const hash = sha256(data);
    const tag = hash.slice(0, 20);

    let stored = SITE + path;

    if (!fits(stored, takenFiles, takenFolders)) {
      stored = blobName(path, hash);
      mapped++;
    }

    if (!resources.has(stored)) {
      resources.set(stored, data);
      take(stored, takenFiles, takenFolders);
    }

    entries.set(path, [stored, tag]);
  }

  return { entries, resources, mapped };
}

function fits(name, files, folders) {
  if (!isResourceName(name)) {
    return false;
  }

  const lower = name.toLowerCase();

  if (files.has(lower) || folders.has(lower)) {
    return false;
  }

  for (let slash = lower.indexOf('/'); slash > 0; slash = lower.indexOf('/', slash + 1)) {
    if (files.has(lower.slice(0, slash))) {
      return false;
    }
  }

  return true;
}

function take(name, files, folders) {
  const lower = name.toLowerCase();

  files.add(lower);

  for (let slash = lower.indexOf('/'); slash > 0; slash = lower.indexOf('/', slash + 1)) {
    folders.add(lower.slice(0, slash));
  }
}

/**
 * The folders a site is also served below, when it was built for a project
 * page: https://owner.github.io/repo/ links to /repo/..., which the lambda
 * answers at its root as well.
 * @param {string} setting 'auto', '' or 'none' for none, or paths separated by commas
 * @param {string} repository owner/name
 * @param {boolean} hasCname whether the site has a CNAME file, which GitHub serves at the root of its domain
 */
export function basePaths(setting, repository, hasCname) {
  const value = (setting ?? 'auto').trim();

  if (value === '' || value.toLowerCase() === 'none' || value === '/') {
    return [];
  }

  if (value.toLowerCase() !== 'auto') {
    return value.split(',').map(p => '/' + p.trim().replace(/^\/+|\/+$/g, '')).filter(p => p !== '/');
  }

  const name = (repository ?? '').split('/')[1] ?? '';

  // a user or organization page is served at the root of its domain, and so
  // is any site with a domain of its own
  if (!name || name.toLowerCase().endsWith('.github.io') || hasCname) {
    return [];
  }

  return ['/' + name];
}

/**
 * Puts together the files of the version: the program, what is written about
 * it, and the site.
 * @returns {{ files: { name: string, data: Buffer }[], digest: string, stats: object }}
 */
export function build({ site, program, backend = [], basePaths: bases = [], source = {}, product }) {
  const { entries, resources, mapped } = place(site);

  const manifestBody = {
    version: 1,
    generator: source.generator ?? 'genhttp-pages',
    source: { repository: source.repository, commit: source.commit, run: source.run },
    basePaths: bases,
    files: Object.fromEntries(entries)
  };

  const code = [
    ...program,
    ...backend,
    { name: 'docs/product.md', data: Buffer.from(product, 'utf8') }
  ];

  // lambda.cs has to come first
  code.sort((a, b) => (a.name === 'lambda.cs' ? -1 : b.name === 'lambda.cs' ? 1 : 0));

  const served = [...resources].map(([name, data]) => ({ name: 'resources/' + name, data }));

  // what identifies this deployment: every file but the manifest, and the
  // manifest without where it came from (a new commit with the same site is
  // the same site)
  const hash = createHash('sha256');
  for (const file of [...code.filter(f => f.name !== 'docs/product.md'), ...served]) {
    hash.update(file.name).update('\0').update(sha256(file.data)).update('\0');
  }
  hash.update(JSON.stringify({ ...manifestBody, source: undefined, generator: undefined }));
  const digest = hash.digest('hex');

  const manifest = { digest, ...manifestBody };

  const files = [
    ...code,
    { name: MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') },
    ...served
  ];

  const bytes = files.reduce((sum, f) => sum + f.data.length, 0);

  return {
    files,
    digest,
    stats: { pages: entries.size, stored: resources.size, mapped, bytes, siteBytes: site.reduce((s, f) => s + f.data.length, 0) }
  };
}
