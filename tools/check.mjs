// Compiles C# files against a lambda without saving anything.
// node tools/check.mjs <editor key> lambda.cs=path [name=path ...]
import { readFileSync } from 'node:fs';

const [key, ...pairs] = process.argv.slice(2);
const server = process.env.GENHTTP_SERVER ?? 'https://genhttp.dev';

const files = pairs.map(pair => {
  const [name, path] = pair.split('=');
  return { name, code: readFileSync(path, 'utf8') };
});

const response = await fetch(`${server}/api/v1/lambdas/${key}/code/check`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ files })
});

const result = await response.json();
console.log(result.success ? 'compiles' : 'does not compile');
for (const d of result.diagnostics ?? []) {
  console.log(`${d.file ?? ''}(${d.line},${d.column}) ${d.severity} ${d.id}: ${d.message}`);
}
process.exitCode = result.success ? 0 : 1;
