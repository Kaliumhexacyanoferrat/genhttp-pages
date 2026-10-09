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
  $('tour-img').alt = `The editor of a site: ${tab.textContent.toLowerCase()}. ${tab.dataset.say}`;
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

$('toggle-own').addEventListener('click', () => {
  ownLambda = !ownLambda;
  $('own-lambda').hidden = !ownLambda;
  $('new-lambda').hidden = ownLambda;
  $('toggle-own').textContent = ownLambda ? 'Make a new lambda instead' : 'I have a lambda already';
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
    return fail('Paste the editor key of your lambda, or make a new one.', $('own-key'));
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

  $('editor-link').focus();
}

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
