// Turns a GitHub Pages workflow into one that publishes with GenHTTP Pages.

export const ACTION = 'Kaliumhexacyanoferrat/genhttp-pages@v1';
export const KEY_LINE = 'key: ${{ secrets.GENHTTP_KEY }}';

/**
 * Replaces actions/deploy-pages with GenHTTP Pages in a workflow and hands
 * it the key - keeping everything else as it was written.
 */
export function convert(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const found = /^(\s*)(-\s+)?uses:\s*["']?actions\/deploy-pages@[^\s"'#]+["']?(.*)$/;

  let changed = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = found.exec(lines[i]);

    if (!match) {
      continue;
    }

    changed++;

    const [, indent, dash = '', rest] = match;
    const keys = indent.length + dash.length; // where the keys of this step begin

    lines[i] = `${indent}${dash}uses: ${ACTION}${rest}`;

    // the rest of this step: lines indented at least as far as its keys
    let end = i + 1;
    let withLine = -1;

    while (end < lines.length) {
      const line = lines[end];

      if (line.trim() === '' || line.trim().startsWith('#')) {
        end++;
        continue;
      }

      const depth = line.length - line.trimStart().length;

      if (depth < keys || (depth === keys && line.trimStart().startsWith('- '))) {
        break;
      }

      if (depth === keys && /^with:\s*$/.test(line.trimStart())) {
        withLine = end;
      }

      end++;
    }

    // back up over trailing blank lines, which belong to what follows
    while (end > i + 1 && lines[end - 1].trim() === '') {
      end--;
    }

    if (withLine >= 0) {
      const next = lines.slice(withLine + 1).find(l => l.trim() !== '');
      const inner = next && next.length - next.trimStart().length > keys ? next.length - next.trimStart().length : keys + 2;
      const hasKey = lines.slice(withLine + 1, end).some(l => /^\s*key:/.test(l));

      if (!hasKey) {
        lines.splice(withLine + 1, 0, ' '.repeat(inner) + KEY_LINE);
      }
    } else {
      lines.splice(end, 0, ' '.repeat(keys) + 'with:', ' '.repeat(keys + 2) + KEY_LINE);
    }
  }

  return { text: lines.join('\n'), changed };
}
