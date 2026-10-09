// Finds the editor key to publish with: given as an input or in the
// environment, or - without one - exchanged for the run's GitHub OIDC token
// at the broker, for a repository that was activated there.
//
// The OIDC way needs "permissions: id-token: write", which every Pages
// workflow already has for actions/deploy-pages.

import * as gha from './gha.mjs';

export const BROKER = 'https://pages.genhttp.run';

export class KeyMissing extends Error {
  constructor(message, { activate = true } = {}) {
    super(message);
    this.activate = activate;
  }
}

/**
 * @returns {Promise<{ key: string, via: 'key' | 'oidc' }>}
 */
export async function resolveKey() {
  const given = gha.input('key') || process.env.GENHTTP_KEY || '';

  if (given) {
    gha.mask(given);
    return { key: given, via: 'key' };
  }

  const broker = gha.input('broker', BROKER).replace(/\/+$/, '');
  const activation = gha.input('activation');

  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new KeyMissing(activation
      ? `The workflow may not ask GitHub for an OIDC token. Add "permissions: id-token: write" to the job, as Pages workflows have it.`
      : `There is no key to publish with. Activate the repository at ${broker}/#setup, or pass an editor key with 'key'.`);
  }

  const token = await oidcToken(requestUrl, requestToken, broker);

  gha.mask(token);

  let response;

  try {
    response = await fetch(`${broker}/api/oidc/key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token, activation: activation || null }),
      signal: AbortSignal.timeout(60000)
    });
  } catch (error) {
    throw new Error(`Could not reach ${broker} to exchange the run's token for the key: ${error?.cause?.code ?? error.message}.`);
  }

  const answer = await response.json().catch(() => ({}));

  if (response.status === 401 || response.status === 403) {
    throw new KeyMissing(answer.message ?? 'The repository is not activated.');
  }

  if (!response.ok || !answer.privateKey) {
    throw new Error(`${broker} could not hand out the key (${response.status}): ${answer.message ?? response.statusText}`);
  }

  gha.mask(answer.privateKey);

  gha.log(`The run of ${answer.repository} was recognised by its GitHub token.`);

  return { key: answer.privateKey, via: 'oidc' };
}

async function oidcToken(requestUrl, requestToken, audience) {
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(`GitHub did not issue an OIDC token for the run (${response.status}).`);
  }

  const { value } = await response.json();

  if (!value) {
    throw new Error('GitHub answered without an OIDC token.');
  }

  return value;
}
