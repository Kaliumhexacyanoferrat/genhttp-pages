// The setup assistant: creates a lambda through the backend of this site,
// and writes the workflow for the way a site is published today.
// Links are relative, so this works wherever the page is served from.

import { ACTION, KEY_LINE, convert } from './convert.js';

const $ = (id) => document.getElementById(id);

/* ---------- step 1: create a lambda ---------- */

const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

let checkTimer;
let checkedName = null;

function setStatus(element, text, kind) {
  element.textContent = text;
  element.className = 'status' + (kind ? ' ' + kind : '');
}

$('name').addEventListener('input', () => {
  const name = $('name').value.trim().toLowerCase();
  const status = $('name-status');

  clearTimeout(checkTimer);
  checkedName = null;

  if (!name) {
    setStatus(status, 'Left empty, the lambda gets a random address.');
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

      if (!response.ok) {
        setStatus(status, answer.message ?? 'The address could not be checked.', 'bad');
      } else if (answer.available) {
        checkedName = name;
        setStatus(status, `${answer.publicKey}.genhttp.run is free.`, 'good');
      } else {
        setStatus(status, answer.reason ?? `${answer.publicKey}.genhttp.run is taken.`, 'bad');
      }
    } catch {
      setStatus(status, 'The address could not be checked. It is checked again when you create the lambda.');
    }
  }, 350);
});

setStatus($('name-status'), 'Left empty, the lambda gets a random address.');

$('create').addEventListener('submit', async (event) => {
  event.preventDefault();

  const error = $('create-error');
  const button = $('create-button');
  const name = $('name').value.trim().toLowerCase();

  error.hidden = true;

  if (!$('terms').checked) {
    error.textContent = 'Accept the terms to create a lambda.';
    error.hidden = false;
    $('terms').focus();
    return;
  }

  if (name && !KEY_PATTERN.test(name)) {
    error.textContent = 'Choose another address, or leave it empty.';
    error.hidden = false;
    $('name').focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Creating…';

  try {
    const response = await fetch('api/lambdas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: name || null, acceptedTerms: true })
    });

    const answer = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(answer.message ?? `The lambda could not be created (${response.status}).`);
    }

    showCreated(answer);
  } catch (failure) {
    error.textContent = failure.message || 'The lambda could not be created. Try again in a moment.';
    error.hidden = false;
    button.disabled = false;
    button.textContent = 'Create lambda';
  }
});

function showCreated(lambda) {
  $('create').hidden = true;

  const address = $('created-address');
  address.href = lambda.address;
  address.textContent = lambda.address;

  $('created-key').textContent = lambda.privateKey;
  $('created-editor').href = lambda.editor;

  $('created').hidden = false;
  $('step-create').classList.add('done');

  const push = $('push-address');
  push.querySelector('a').href = lambda.address;
  push.querySelector('a').textContent = lambda.address;
  push.hidden = false;

  $('created-key').closest('.key').querySelector('button').focus();
}

/* ---------- step 2: the secret ---------- */

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

function repository() {
  let value = $('repo').value.trim();

  // a pasted address of the repository
  value = value.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');

  return REPO_PATTERN.test(value) ? value : null;
}

$('repo').addEventListener('input', () => {
  const repo = repository();
  const link = $('secret-link');

  if (repo) {
    link.href = `https://github.com/${repo}/settings/secrets/actions/new`;
    link.textContent = `Open the secrets of ${repo}`;
    $('gh-command').textContent = `gh secret set GENHTTP_KEY --repo ${repo}`;
  } else {
    link.href = 'https://docs.github.com/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository';
    link.textContent = 'Open the secrets of the repository';
    $('gh-command').textContent = 'gh secret set GENHTTP_KEY';
  }
});

/* ---------- step 3: the workflow ---------- */

const tabs = [...document.querySelectorAll('[role="tab"]')];

function select(tab) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute('aria-selected', String(selected));
    other.tabIndex = selected ? 0 : -1;
    $(other.getAttribute('aria-controls')).hidden = !selected;
  }
}

tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (step) {
      const next = tabs[(index + step + tabs.length) % tabs.length];
      select(next);
      next.focus();
      event.preventDefault();
    }
  });
});

$('workflow-in').addEventListener('input', () => {
  const input = $('workflow-in').value;
  const status = $('workflow-status');
  const wrap = $('workflow-out-wrap');

  if (!input.trim()) {
    setStatus(status, '');
    wrap.hidden = true;
    return;
  }

  const { text, changed } = convert(input);

  if (changed === 0) {
    setStatus(status, 'This workflow has no actions/deploy-pages step. Is it the one that publishes the site?', 'bad');
    wrap.hidden = true;
    return;
  }

  setStatus(status, changed === 1 ? 'Changed the deploy step. Replace the file with this:' : `Changed ${changed} deploy steps. Replace the file with this:`, 'good');
  $('workflow-out').textContent = text;
  wrap.hidden = false;
});

function branchWorkflow(branch, folder) {
  return `name: Publish to GenHTTP Lambda

on:
  push:
    branches: [${yamlString(branch)}]
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: genhttp-pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - id: deployment
        uses: ${ACTION}
        with:
          ${KEY_LINE}
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

permissions:
  contents: read

concurrency:
  group: genhttp-pages
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # build the site here, if it needs building
      - id: deployment
        uses: ${ACTION}
        with:
          ${KEY_LINE}
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

$('branch').addEventListener('input', renderBranch);
$('folder').addEventListener('change', renderBranch);
$('path').addEventListener('input', renderFolder);

renderBranch();
renderFolder();

/* ---------- copying ---------- */

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = $(button.dataset.copy).textContent;

    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      // without the clipboard, select it for the keyboard
      const range = document.createRange();
      range.selectNodeContents($(button.dataset.copy));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      button.textContent = 'Selected';
    }

    setTimeout(() => { button.textContent = 'Copy'; }, 1800);
  });
}
