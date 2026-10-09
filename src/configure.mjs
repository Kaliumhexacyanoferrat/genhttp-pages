// GenHTTP Pages - configure: what actions/configure-pages answers, for a lambda.

import * as gha from './gha.mjs';
import { LambdaApi } from './api.mjs';
import { resolveKey, KeyMissing, BROKER } from './credentials.mjs';

async function main() {
  let key;

  try {
    ({ key } = await resolveKey());
  } catch (error) {
    if (error instanceof KeyMissing) {
      gha.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const api = new LambdaApi({ server: gha.input('server', 'https://genhttp.dev'), key, timeout: 60000 });

  const lambda = await api.getLambda();

  if (!lambda) {
    throw new Error(`The editor key does not open a lambda. Check the secret (GENHTTP_KEY), or activate the repository again at ${BROKER}/#setup.`);
  }

  const address = new URL(lambda.address);
  const baseUrl = address.href.replace(/\/+$/, '');

  if (gha.input('static_site_generator')) {
    gha.notice(`'static_site_generator' is not applied: the site answers at the root of ${address.origin}, so there is no base path to set. Configure static output (for Next.js: output: 'export') in the generator itself.`);
  }

  gha.output('base_url', baseUrl);
  gha.output('origin', address.origin);
  gha.output('host', address.host);
  gha.output('base_path', address.pathname.replace(/\/+$/, ''));

  gha.log(`The site will answer at ${baseUrl}/.`);
}

main().catch(error => {
  gha.error(error.message);
  process.exitCode = 1;
});
