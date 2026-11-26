import { readFile } from 'node:fs/promises';

const file = 'docs/development/V007-DEFECT-REGISTER.md';
const text = await readFile(file, 'utf8');
const rows = text.split('\n').filter(line => /^\|\s*V007-\d+\s*\|/.test(line));
const blocking = [];
for (const row of rows) {
  const columns = row.split('|').map(value => value.trim());
  const [, id, severity, , , , status] = columns;
  if ((severity === 'P0' || severity === 'P1') && !['FIXED', 'VERIFIED'].includes(status)) blocking.push(`${id} ${severity} ${status}`);
}
if (!rows.length) throw new Error('Defect register contains no entries');
if (blocking.length) throw new Error(`Uncleared P0/P1 defects: ${blocking.join(', ')}`);
console.log(`Defect register gate passed: ${rows.length} entries, no OPEN/IN_PROGRESS P0/P1`);
