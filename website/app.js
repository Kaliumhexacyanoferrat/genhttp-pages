// The landing page: the tour of the editor, and the assistant that activates
// a repository through the backend of this site and writes the workflow.
// Links are relative, so this works wherever the page is served from.

import { ACTION, activationLine, convert } from './convert.js';

const $ = (id) => document.getElementById(id);

const PLACEHOLDER = 'gp-…';

let code = PLACEHOLDER;

function setStatus(element, text, kind) {
  element.textContent = text;
  element.className = 'status' + (kind ? ' ' + kind : '');
}

/* ---------- tabs: the tour ---------- */

function tabs(list, onSelect) {
  const all = [...list.querySelectorAll('[role="tab"]')];

  const select = (tab) => {
    for (const other of all) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      other.tabIndex = selected ? 0 : -1;
    }
    onSelect(tab);
  };

  all.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (step) {
        const next = all[(index + step + all.length) % all.length];
        select(next);
        next.focus();
        event.preventDefault();
      }
    });
  });
}

tabs(document.querySelector('.tour [role="tablist"]'), (tab) => {
  const shot = tab.dataset.shot;

  $('tour-dark').srcset = `editor/${shot}-dark.webp`;
  $('tour-img').src = `editor/${shot}-light.webp`;
  $('tour-img').alt = `The dashboard of a site: ${tab.textContent.toLowerCase()}. ${tab.dataset.say}`;
  $('tour-say').textContent = tab.dataset.say;
  $('tour-panel').setAttribute('aria-labelledby', tab.id);
  $('tour-full').href = `editor/${shot}-${scheme()}.webp`;
});

function scheme() {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

$('tour-full').href = `editor/overview-${scheme()}.webp`;
$('change-full').href = `editor/change-${scheme()}.webp`;

// the pictures of the other tabs, so switching does not wait for them
addEventListener('load', () => {
  for (const tab of document.querySelectorAll('.tour [data-shot]')) {
    new Image().src = `editor/${tab.dataset.shot}-${scheme()}.webp`;
  }
});

/* ---------- step 1: activate ---------- */

const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

let checkTimer;
let ownLambda = false;

function repository() {
  const value = $('repo').value.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');

  return REPO_PATTERN.test(value) ? value : null;
}

$('name').addEventListener('input', () => {
  const name = $('name').value.trim().toLowerCase();
  const status = $('name-status');

  clearTimeout(checkTimer);

  if (!name) {
    setStatus(status, 'Left empty, the site gets a random address.');
    return;
  }

  if (!KEY_PATTERN.test(name)) {
    setStatus(status, 'Use lowercase letters, digits and dashes, not at the start or the end.', 'bad');
    return;
  }

  setStatus(status, 'Checking…');

  checkTimer = setTimeout(async () => {
    try {
      const response = await fetch('api/keys/' + encodeURIComponent(name));
      const answer = await response.json();

      if ($('name').value.trim().toLowerCase() !== name) {
        return;
      }

      if (response.ok && answer.available) {
        setStatus(status, `${answer.publicKey}.genhttp.run is free.`, 'good');
      } else {
        setStatus(status, answer.reason ?? answer.message ?? `${name}.genhttp.run is taken.`, 'bad');
      }
    } catch {
      setStatus(status, 'The address could not be checked; it is checked again when you activate.');
    }
  }, 350);
});

setStatus($('name-status'), 'Left empty, the site gets a random address.');

// the address follows the repository's name until somebody types one: "blog"
// for octo/blog, "octo" for octo/octo.github.io, and "octo-blog" where that is taken

let addressTyped = false;

$('name').addEventListener('input', (event) => {
  if (event.isTrusted) {
    addressTyped = $('name').value.trim() !== '';
  }
});

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

function suggestions(repo) {
  const [owner, name] = repo.split('/');
  const own = /\.github\.io$/i.test(name) ? slug(owner) : slug(name);

  return [...new Set([own, slug(`${owner}-${own}`)])].filter(key => KEY_PATTERN.test(key));
}

function suggest(address) {
  $('name').value = address;
  $('name').dispatchEvent(new Event('input'));
}

let suggestTimer;

$('repo').addEventListener('input', () => {
  clearTimeout(suggestTimer);

  const repo = repository();

  if (!repo || addressTyped || ownLambda) {
    return;
  }

  suggestTimer = setTimeout(async () => {
    const candidates = suggestions(repo);

    for (const candidate of candidates) {
      if (addressTyped || repository() !== repo) {
        return;
      }

      try {
        const answer = await (await fetch('api/keys/' + encodeURIComponent(candidate))).json();

        if (answer.available) {
          suggest(candidate);
          return;
        }
      } catch {
        break;
      }
    }

    // nothing free: show the first, and the check below it says it is taken
    if (candidates.length && !addressTyped && repository() === repo) {
      suggest(candidates[0]);
    }
  }, 400);
});

$('toggle-own').addEventListener('click', () => {
  ownLambda = !ownLambda;
  $('own-lambda').hidden = !ownLambda;
  $('new-lambda').hidden = ownLambda;
  $('toggle-own').textContent = ownLambda ? 'Make a new site instead' : 'My site is on GenHTTP already';
  (ownLambda ? $('own-key') : $('name')).focus();
});

function fail(message, focus) {
  const error = $('activate-error');
  error.textContent = message;
  error.hidden = false;
  focus?.focus();
}

$('activate').addEventListener('submit', async (event) => {
  event.preventDefault();

  $('activate-error').hidden = true;

  const repo = repository();
  const name = $('name').value.trim().toLowerCase();
  const ownKey = $('own-key').value.trim().replace(/^.*\/editor\//, '').replace(/[/?#].*$/, '');

  if (!repo) {
    return fail('Name the repository as owner/repository.', $('repo'));
  }

  if (ownLambda && !ownKey) {
    return fail('Paste the dashboard link of your site, or make a new one.', $('own-key'));
  }

  if (!ownLambda && name && !KEY_PATTERN.test(name)) {
    return fail('Choose another address, or leave it empty.', $('name'));
  }

  if (!$('terms').checked) {
    return fail('Accept the terms to activate.', $('terms'));
  }

  const button = $('activate-button');
  button.disabled = true;
  button.textContent = 'Activating…';

  try {
    const response = await fetch('api/activations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repository: repo,
        publicKey: ownLambda ? null : name || null,
        privateKey: ownLambda ? ownKey : null,
        acceptedTerms: true
      })
    });

    const answer = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(answer.message ?? `The repository could not be activated (${response.status}).`);
    }

    activated(answer);
  } catch (failure) {
    fail(failure.message || 'The repository could not be activated. Try again in a moment.');
    button.disabled = false;
    button.textContent = 'Activate';
  }
});

function activated(answer) {
  $('activate').hidden = true;

  $('editor-link').href = answer.editor;
  $('site-link').href = answer.address;
  $('site-link').textContent = answer.address;

  $('activated').hidden = false;
  $('step-activate').classList.add('done');

  code = answer.activation;
  renderAll();

  remember({
    repository: answer.repository,
    address: answer.address,
    editor: answer.editor,
    activation: answer.activation,
    activated: new Date().toISOString()
  });

  $('editor-link').focus();
}

/* ---------- what this browser activated ---------- */

// The editor link is the only way into the editor, and the broker cannot
// hand it out again. So the browser that activated keeps it, as a bookmark
// would: in this site's own storage, which no other lambda's page can read.

const RECENT = 'genhttp-pages-activations';

function recent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT) ?? '[]');
    return Array.isArray(list) ? list.filter(e => e && typeof e.editor === 'string' && e.editor.startsWith('https://')) : [];
  } catch {
    return [];
  }
}

function store(list) {
  try {
    localStorage.setItem(RECENT, JSON.stringify(list));
  } catch {
    // private windows and blocked storage: the link is still on the page
  }
}

function remember(entry) {
  store([entry, ...recent().filter(e => e.activation !== entry.activation)].slice(0, 20));
  renderRecent();
}

function forget(activation) {
  store(recent().filter(e => e.activation !== activation));
  renderRecent();
}

function renderRecent() {
  const list = $('recent-list');
  const entries = recent();

  list.replaceChildren();
  $('recent').hidden = entries.length === 0;

  for (const entry of entries) {
    const item = document.createElement('li');

    const what = document.createElement('div');
    what.className = 'recent-what';

    const name = document.createElement('strong');
    name.textContent = entry.repository;

    const site = document.createElement('a');
    site.href = entry.address;
    site.target = '_blank';
    site.rel = 'noopener';
    site.textContent = entry.address.replace(/^https:\/\//, '').replace(/\/$/, '');

    what.append(name, site);

    const actions = document.createElement('div');
    actions.className = 'recent-actions';

    const open = document.createElement('a');
    open.className = 'copy';
    open.href = entry.editor;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = 'Open dashboard';

    const use = document.createElement('button');
    use.type = 'button';
    use.className = 'copy';
    use.textContent = 'Use its code';
    use.addEventListener('click', () => {
      code = entry.activation;
      renderAll();
      $('step-workflow').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'link';
    drop.textContent = 'Forget';
    drop.addEventListener('click', () => forget(entry.activation));

    actions.append(open, use, drop);
    item.append(what, actions);
    list.append(item);
  }
}

renderRecent();

/* ---------- step 2: the workflow ---------- */

function renderAll() {
  for (const slot of document.querySelectorAll('.code-slot')) {
    slot.textContent = code;
  }

  $('step-diff').textContent = `        uses: ${ACTION}\n        with:\n          ${activationLine(code)}`;

  renderConverted();
  renderBranch();
  renderFolder();
}

function renderConverted() {
  const input = $('workflow-in').value;
  const status = $('workflow-status');
  const wrap = $('workflow-out-wrap');

  if (!input.trim()) {
    setStatus(status, '');
    wrap.hidden = true;
    return;
  }

  const { text, changed } = convert(input, activationLine(code));

  if (changed === 0) {
    setStatus(status, 'This workflow has no actions/deploy-pages step. Is it the one that publishes the site?', 'bad');
    wrap.hidden = true;
    return;
  }

  setStatus(status, 'Replace the file with this:', 'good');
  $('workflow-out').textContent = text;
  wrap.hidden = false;
}

const HEADER = `permissions:
  contents: read
  id-token: write

concurrency:
  group: genhttp-pages
  cancel-in-progress: false`;

function branchWorkflow(branch, folder) {
  return `name: Publish to GenHTTP Lambda

on:
  push:
    branches: [${yamlString(branch)}]
  workflow_dispatch:

${HEADER}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTION}
        with:
          ${activationLine(code)}
          branch: ${yamlString(branch)}
          folder: ${folder}
`;
}

function folderWorkflow(path) {
  return `name: Publish to GenHTTP Lambda

on:
  push:
    branches: [main]
  workflow_dispatch:

${HEADER}

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # build the site here, if it needs building
      - uses: ${ACTION}
        with:
          ${activationLine(code)}
          path: ${yamlString(path)}
`;
}

function yamlString(value) {
  return /^[A-Za-z0-9._\/-]+$/.test(value) ? value : JSON.stringify(value);
}

function renderBranch() {
  $('branch-out').textContent = branchWorkflow($('branch').value.trim() || 'gh-pages', $('folder').value);
}

function renderFolder() {
  $('folder-out').textContent = folderWorkflow($('path').value.trim() || '.');
}

$('workflow-in').addEventListener('input', renderConverted);
$('branch').addEventListener('input', renderBranch);
$('folder').addEventListener('change', renderBranch);
$('path').addEventListener('input', renderFolder);

renderAll();

/* ---------- copying ---------- */

for (const button of document.querySelectorAll('[data-copy], [data-copy-href]')) {
  button.addEventListener('click', async () => {
    const source = $(button.dataset.copy ?? button.dataset.copyHref);
    const text = button.dataset.copy ? source.textContent : source.href;
    const label = button.textContent;

    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(source);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = 'Selected';
    }

    setTimeout(() => { button.textContent = label; }, 1800);
  });
}
