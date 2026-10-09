// Checks that a push keeps what was added to the lambda in its editor - as
// an agent would add an API beside the site.
//
//   node test/kept.mjs prepare <editor key>   saves a version with a route of its own, as the editor would
//   node test/kept.mjs check <page url>       after the action ran: the route and the site both answer

import assert from 'node:assert/strict';

const [step, argument] = process.argv.slice(2);

const token = `kept-${Date.now()}`;

if (step === 'prepare') {
  const files = [
    {
      name: 'lambda.cs',
      code: 'return Layout.Create()\n             .Add("api", Kept.Api())\n             .Add(PagesSite.Create());\n'
    },
    {
      name: 'Kept.cs',
      code: `// added "in the editor" by the CI, to see that a push keeps it\npublic static class Kept\n{\n    public static IHandlerBuilder Api() => Inline.Create().Get("kept", () => "${token}");\n}\n`
    }
  ];

  const response = await fetch(`https://genhttp.dev/api/v1/lambdas/${encodeURIComponent(argument)}/versions/changes?deploy=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, change: 'An API beside the site, as an agent would add it' })
  });

  const answer = await response.json();

  assert.equal(response.status, 201, answer.message);
  assert.ok(answer.deployment?.success, JSON.stringify(answer.deployment?.diagnostics));

  console.log(`Saved version ${answer.version} with api/kept answering ${token}`);
  console.log(`token=${token}`);
} else if (step === 'check') {
  const base = argument.endsWith('/') ? argument : argument + '/';

  const api = await fetch(new URL('api/kept', base));
  const text = await api.text();

  assert.equal(api.status, 200, 'api/kept is gone after the push');
  assert.match(text, /^kept-\d+$/, `api/kept answers ${text}`);

  const site = await fetch(base);
  assert.match(await site.text(), /fixture-index/);

  console.log(`✔ api/kept still answers ${text}, and the site is the pushed one`);
} else {
  console.error('usage: node test/kept.mjs prepare <editor key> | check <page url>');
  process.exitCode = 2;
}
