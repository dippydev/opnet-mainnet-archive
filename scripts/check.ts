/**
 * Integrity check: SHA-256 of each archive file against SHA256SUMS, then row counts and
 * block range against MANIFEST.txt.
 *
 * Usage: node scripts/check.ts [archive-dir]
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonlGz } from './lib.ts';

const dir = process.argv[2] ?? 'archive';
const sums = readFileSync('SHA256SUMS', 'utf8').trim().split('\n').map((l) => l.split(/\s+/) as [string, string]);
const manifest = readFileSync('MANIFEST.txt', 'utf8');
const expectedRows: Record<string, number> = {
    events: Number(/events\.jsonl\s+(\d+)/.exec(manifest)?.[1]),
    txs: Number(/txs\.jsonl\s+(\d+)/.exec(manifest)?.[1]),
};
const head = Number(/Head block:\s+(\d+)/.exec(manifest)?.[1]);

let failed = 0;
for (const [hash, name] of sums) {
    const path = join(dir, name);
    if (!existsSync(path)) {
        console.log(`MISSING  ${path}`);
        failed++;
        continue;
    }
    const h = createHash('sha256');
    for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
    const ok = h.digest('hex') === hash;
    if (!ok) failed++;

    let rows = 0, min = Infinity, max = -Infinity;
    for await (const r of readJsonlGz<{ b: number }>(path)) {
        rows++;
        if (r.b < min) min = r.b;
        if (r.b > max) max = r.b;
    }
    const kind = name.startsWith('events') ? 'events' : 'txs';
    const rowsOk = rows === expectedRows[kind];
    const rangeOk = max <= head;
    if (!rowsOk || !rangeOk) failed++;
    console.log(`${ok && rowsOk && rangeOk ? 'OK      ' : 'FAIL    '} ${name}  sha256 ${ok ? 'match' : 'MISMATCH'}  rows ${rows.toLocaleString()}/${expectedRows[kind].toLocaleString()}  blocks ${min}-${max}`);
}
if (sums.length === 0) failed++;
console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${sums.length} files verified.`);
process.exit(failed ? 1 : 0);
