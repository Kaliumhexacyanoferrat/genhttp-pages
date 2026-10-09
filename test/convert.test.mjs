import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { convert } from '../website/convert.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

for (const name of ['static.yml', 'hugo.yml']) {
  test(`GitHub's starter workflow ${name} changes in its deploy step only`, () => {
    const before = fixture(name).replace(/\r\n/g, '\n');
    const { text, changed } = convert(before);

    assert.equal(changed, 1);
    assert.doesNotMatch(text, /actions\/deploy-pages/);

    const lines = text.split('\n');
    const at = lines.findIndex(l => l.includes('genhttp-pages@v1'));
    const uses = lines[at];

    // the same file with the uses line put back and the two lines taken out
    const restored = [...lines.slice(0, at), uses.replace('Kaliumhexacyanoferrat/genhttp-pages@v1', 'actions/deploy-pages@v5'), ...lines.slice(at + 3)];
    assert.equal(restored.join('\n'), before);

    // with: sits at the level of uses:, key: one further in
    assert.equal(lines[at + 1], ' '.repeat(uses.indexOf('uses:')) + 'with:');
    assert.equal(lines[at + 2], ' '.repeat(uses.indexOf('uses:') + 2) + 'key: ${{ secrets.GENHTTP_KEY }}');
  });
}

test('a step that has inputs already gets the key among them', () => {
  const { text } = convert([
    '    steps:',
    '      - name: Deploy',
    '        uses: actions/deploy-pages@v4',
    '        with:',
    '          artifact_name: site',
    '      - run: echo done'
  ].join('\n'));

  assert.equal(text, [
    '    steps:',
    '      - name: Deploy',
    '        uses: Kaliumhexacyanoferrat/genhttp-pages@v1',
    '        with:',
    '          key: ${{ secrets.GENHTTP_KEY }}',
    '          artifact_name: site',
    '      - run: echo done'
  ].join('\n'));
});

test('a step written as "- uses:" gets its inputs below it', () => {
  const { text } = convert('      - uses: actions/deploy-pages@v5 # deploy\n        id: deployment\n');

  assert.equal(text, '      - uses: Kaliumhexacyanoferrat/genhttp-pages@v1 # deploy\n        id: deployment\n        with:\n          key: ${{ secrets.GENHTTP_KEY }}\n');
});

test('a workflow without the step is left alone', () => {
  assert.equal(convert('jobs: {}').changed, 0);
});
