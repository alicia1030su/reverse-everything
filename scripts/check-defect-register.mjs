import { readFile } from 'node:fs/promises';

const files = ['docs/development/V007-DEFECT-REGISTER.md', 'docs/development/V008-DEFECT-REGISTER.md'];
const blocking = [];
let total = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  const rows = text.split('\n').filter(line => /^\|\s*V00[78]-\d+\s*\|/.test(line));
  if (!rows.length) throw new Error(`Defect register contains no entries: ${file}`);
  total += rows.length;
  for (const row of rows) {
    const columns = row.split('|').map(value => value.trim());
    const [, id, severity, , , , status] = columns;
    if ((severity === 'P0' || severity === 'P1') && !['FIXED', 'VERIFIED'].includes(status)) blocking.push(`${id} ${severity} ${status}`);
  }
}
if (blocking.length) throw new Error(`Uncleared P0/P1 defects: ${blocking.join(', ')}`);
console.log(`Defect register gate passed: ${total} entries, no OPEN/IN_PROGRESS P0/P1`);
