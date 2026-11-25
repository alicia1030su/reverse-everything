import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const files = ['README.md', 'README.en.md'];
async function collect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collect(file);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path.relative(root, file).replaceAll(path.sep, '/'));
  }
}
await collect(path.join(root, 'docs'));
const errors = [];
const checked = new Set();
for (const file of files) {
  let text;
  try { text = await readFile(path.join(root, file), 'utf8'); } catch { continue; }
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    const clean = target.split('#')[0].split('?')[0];
    if (!clean) continue;
    const resolved = path.resolve(root, path.dirname(file), decodeURIComponent(clean));
    const key = `${file}:${target}`;
    if (checked.has(key)) continue;
    checked.add(key);
    try { await access(resolved); } catch { errors.push(`${file}: missing link ${target}`); }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked.size} local documentation links across ${files.length} Markdown files`);
}
