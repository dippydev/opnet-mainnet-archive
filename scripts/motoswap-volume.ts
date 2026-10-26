/**
 * MotoSwap volume and fee revenue, rebuilt from the archived events.
 *
 * Usage: node scripts/motoswap-volume.ts [events.jsonl.gz] [--out dir]
 *
 * Every number is valued in BTC using prices observed on chain, not an external feed:
 * MOTO's price in sats comes from NativeSwap BTC->MOTO trades, NativeSwap BTC->PILL trades
 * (converted through the MOTO/PILL pool) and the MOTO/sBTC pool. Each swap uses the median
 * of the 15 observations nearest to it in block height. USD uses monthly average BTC/USD.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ArchivedEvent, addr, label, monthOf, payload, ratio, readAll, uint, word } from './lib.ts';

const MOTO = '0xc3d18f9d7db3f26ed107a9f4a4c65eef14c1ca73db5684ef9789fdd4fbb3ea9a';
const PILL = '0xc6c3674b1c6c4ca3d4b3652d1d6fc2b197f45c4ad1eda90d37952472719d1c05';
const SBTC = '0x3552e35d64924320b6856b5972233c858ff5b7ef193b3ad4325ea59bfbbf61f2';
const STAKING = '0xab99e31ebb30b8e596d5be1bd1e501ee8e7b7e5ec9dc7ee880f4937b0c929dcb';
const FACTORY = '0x6b5e5d3cd163c9d7757afcb358413039d040b143b3a23ddd05a83506d3682bf3';
const NATIVE = '0xbaf131d22120efe459586eb9eda2590f78044851bfcda49365ed1c1dbc863ee4';
const LP_FEE = 0.003;
const STAKER_FEE = 0.002;

/** Monthly average BTC/USD, CoinGecko daily closes (fetched 2026-10-26). */
const BTC_USD: Record<string, number> = {
    '2026-03': 69431, '2026-04': 73404, '2026-05': 78071, '2026-06': 63507, '2026-07': 63731, '2026-08': 68980,
};

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? args[outIdx + 1] : null;
const eventsPath = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1)) ?? 'archive/events-to-964814.jsonl.gz';

const units = (x: bigint): number => ratio(x, 10n ** 18n);
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const quantile = (v: number[], q: number): number => [...v].sort((a, b) => a - b)[Math.floor(v.length * q)];

const events = await readAll<ArchivedEvent>(eventsPath);
const byTx = new Map<string, ArchivedEvent[]>();
for (const e of events) {
    const list = byTx.get(e.h);
    if (list) list.push(e);
    else byTx.set(e.h, [e]);
}

const pools = new Map<string, [string, string]>();
for (const e of events) {
    if (e.t === 'PoolCreated' && e.c === FACTORY) {
        const d = payload(e);
        pools.set(addr(d, 2), [addr(d, 0), addr(d, 1)]);
    }
}
const poolOf = (a: string, b: string): string => {
    for (const [p, [x, y]] of pools) if ((x === a && y === b) || (x === b && y === a)) return p;
    throw new Error(`no pool for ${label(a)}/${label(b)}`);
};
const MOTO_PILL = poolOf(MOTO, PILL);
const MOTO_SBTC = poolOf(MOTO, SBTC);

// NativeSwap: buyer, amountIn (u64 sats), amountOut, totalFees (token units)
interface NativeSwap { b: number; token: string | null; sats: bigint; out: bigint; fee: bigint }
const native: NativeSwap[] = [];
for (const e of events) {
    if (e.t !== 'SwapExecuted' || e.c !== NATIVE) continue;
    const d = payload(e);
    const tokens = new Set((byTx.get(e.h) ?? []).filter((x) => x.t === 'Transferred').map((x) => x.c));
    native.push({ b: e.b, token: tokens.size === 1 ? [...tokens][0] : null, sats: uint(d, 32, 8), out: uint(d, 40, 32), fee: uint(d, 72, 32) });
}

// Price observations: sats per whole MOTO.
const obs: Array<[number, number]> = [];
const motoPerPill: Array<[number, number]> = [];
for (const n of native) {
    if (n.token === MOTO && n.out + n.fee > 0n) obs.push([n.b, ratio(n.sats * 10n ** 18n, n.out + n.fee)]);
}
for (const e of events) {
    if (e.t !== 'Synced' || (e.c !== MOTO_PILL && e.c !== MOTO_SBTC)) continue;
    const d = payload(e);
    const r0 = word(d, 0), r1 = word(d, 1);
    if (r0 === 0n || r1 === 0n) continue;
    const motoIs0 = pools.get(e.c)![0] === MOTO;
    const other = motoIs0 ? r1 : r0, moto = motoIs0 ? r0 : r1;
    if (e.c === MOTO_PILL) motoPerPill.push([e.b, ratio(moto, other)]);
    else obs.push([e.b, ratio(other, moto) * 1e8]);
}
for (const n of native) {
    if (n.token !== PILL || n.out + n.fee === 0n) continue;
    let r: number | null = null;
    for (const [b, v] of motoPerPill) {
        if (b > n.b) break;
        r = v;
    }
    if (r) obs.push([n.b, ratio(n.sats * 10n ** 18n, n.out + n.fee) / r]);
}
obs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const satsPerMoto = (block: number): number => {
    let lo = 0, hi = obs.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (obs[mid][0] < block) lo = mid + 1;
        else hi = mid;
    }
    return median(obs.slice(Math.max(0, lo - 8), lo + 7).map(([, p]) => p));
};

// Walk pool events in order, tracking each token's spot price in MOTO (raw units per raw unit).
const reserves = new Map<string, [bigint, bigint]>();
const px = new Map<string, number>([[MOTO, 1]]);
const pxSource = new Map<string, string>();
const updatePx = (pool: string): void => {
    const [t0, t1] = pools.get(pool)!;
    const [r0, r1] = reserves.get(pool)!;
    if (r0 === 0n || r1 === 0n) return;
    for (const [a, b, ra, rb] of [[t0, t1, r0, r1], [t1, t0, r1, r0]] as const) {
        const quoteOk = b === MOTO || (b === PILL && a !== MOTO);
        if (!quoteOk || !px.has(b)) continue;
        if (b === MOTO || pxSource.get(a) !== MOTO) {
            px.set(a, ratio(rb, ra) * px.get(b)!);
            pxSource.set(a, b);
        }
    }
};
const toMoto = (token: string, amount: bigint): number | null => {
    const p = px.get(token);
    return p === undefined ? null : units(amount) * p;
};

interface Swap { b: number; h: string; pool: string; btc: number | null; stakerCutBtc: number }
const swaps: Swap[] = [];
const lpFeeObserved: number[] = [];
for (const e of events) {
    if (!pools.has(e.c)) continue;
    const d = payload(e);
    if (e.t === 'Synced') {
        reserves.set(e.c, [word(d, 0), word(d, 1)]);
        updatePx(e.c);
        continue;
    }
    if (e.t !== 'Swapped') continue;
    const [t0, t1] = pools.get(e.c)!;
    const a0i = word(d, 1), a1i = word(d, 2), a0o = word(d, 3), a1o = word(d, 4);
    const cut = new Map<string, bigint>();
    for (const x of byTx.get(e.h) ?? []) {
        if (x.t !== 'Transferred') continue;
        const xd = payload(x);
        if (addr(xd, 1) === e.c && addr(xd, 2) === STAKING) cut.set(x.c, (cut.get(x.c) ?? 0n) + word(xd, 3));
    }
    const c0 = cut.get(t0) ?? 0n, c1 = cut.get(t1) ?? 0n;

    // Events are Synced-then-Swapped, so pre-swap reserves are reconstructed from the post-swap sync.
    const [r0, r1] = reserves.get(e.c)!;
    if (a0i > 0n && a1i === 0n && r1 > 0n) lpFeeObserved.push(1 - ratio((a1o + c1) * (r0 - a0i + a0o + c0), a0i * r1));
    else if (a1i > 0n && a0i === 0n && r0 > 0n) lpFeeObserved.push(1 - ratio((a0o + c0) * (r1 - a1i + a1o + c1), a1i * r0));

    const spm = satsPerMoto(e.b);
    const [tin, ain, tout, aout, cout] = a0i > 0n ? [t0, a0i, t1, a1o, c1] : [t1, a1i, t0, a0o, c0];
    const legBtc = (token: string, amount: bigint): number | null => {
        if (token === SBTC) return units(amount);
        if (token === MOTO || token === PILL) {
            const m = toMoto(token, amount);
            return m === null ? null : (m * spm) / 1e8;
        }
        return null;
    };
    let btc = legBtc(tin, ain) ?? legBtc(tout, aout + cout);
    if (btc === null) {
        const m = toMoto(tin, ain);
        btc = m === null ? null : (m * spm) / 1e8;
    }
    let stakerCutBtc = 0;
    for (const [token, amount] of cut) stakerCutBtc += legBtc(token, amount) ?? 0;
    swaps.push({ b: e.b, h: e.h, pool: e.c, btc, stakerCutBtc });
}

const priced = swaps.filter((s): s is Swap & { btc: number } => s.btc !== null);
const usd = (s: { b: number }, btc: number): number => btc * BTC_USD[monthOf(s.b)];
const poolBtc = priced.reduce((a, s) => a + s.btc, 0);
const poolUsd = priced.reduce((a, s) => a + usd(s, s.btc), 0);
const seen = new Set<string>();
let txBtc = 0, txUsd = 0;
for (const s of priced) {
    if (seen.has(s.h) || s.btc <= 0) continue;
    seen.add(s.h);
    txBtc += s.btc;
    txUsd += usd(s, s.btc);
}
const cutRates = priced.filter((s) => s.stakerCutBtc > 0).map((s) => s.stakerCutBtc / s.btc);
const nativeBtc = native.reduce((a, n) => a + ratio(n.sats, 10n ** 8n), 0);
const nativeFee = (n: NativeSwap): number => (n.out + n.fee > 0n ? ratio(n.sats * n.fee, (n.out + n.fee) * 10n ** 8n) : 0);
const nativeFeeBtc = native.reduce((a, n) => a + nativeFee(n), 0);
const nativeUsd = native.reduce((a, n) => a + usd(n, ratio(n.sats, 10n ** 8n)), 0);
const nativeFeeUsd = native.reduce((a, n) => a + usd(n, nativeFee(n)), 0);

const f = (x: number, d = 4): string => x.toFixed(d);
const $ = (x: number): string => '$' + Math.round(x).toLocaleString('en-US');
console.log(`Archive: ${eventsPath} (${events.length.toLocaleString()} events)`);
console.log(`Measured LP fee:      p1 ${f(quantile(lpFeeObserved, 0.01) * 1e4, 2)} / p50 ${f(median(lpFeeObserved) * 1e4, 2)} / p99 ${f(quantile(lpFeeObserved, 0.99) * 1e4, 2)} bps (n=${lpFeeObserved.length})`);
console.log(`Measured staker cut:  p50 ${f(median(cutRates) * 100, 3)}% of swap value (n=${cutRates.length})`);
console.log(`Pool swaps: ${swaps.length} (${swaps.length - priced.length} unpriced) across ${new Set(swaps.map((s) => s.pool)).size} pools; ${seen.size} transactions`);
console.log(`Pool volume, per pool leg:  ${f(poolBtc)} BTC  ${$(poolUsd)}`);
console.log(`Pool volume, per tx:        ${f(txBtc)} BTC  ${$(txUsd)}`);
console.log(`LP fees (0.30%):            ${f(poolBtc * LP_FEE)} BTC  ${$(poolUsd * LP_FEE)}`);
console.log(`MOTO staker fees (0.20%):   ${f(poolBtc * STAKER_FEE)} BTC  ${$(poolUsd * STAKER_FEE)}`);
console.log(`NativeSwap: ${native.length} swaps, ${f(nativeBtc)} BTC in (${$(nativeUsd)}), fees ${f(nativeFeeBtc, 5)} BTC-equivalent (${$(nativeFeeUsd)})`);

const months = new Map<string, { swaps: number; btc: number; usd: number; nativeBtc: number; nativeUsd: number }>();
const month = (b: number) => {
    const k = monthOf(b);
    if (!months.has(k)) months.set(k, { swaps: 0, btc: 0, usd: 0, nativeBtc: 0, nativeUsd: 0 });
    return months.get(k)!;
};
for (const s of priced) {
    const m = month(s.b);
    m.swaps++;
    m.btc += s.btc;
    m.usd += usd(s, s.btc);
}
for (const n of native) {
    const m = month(n.b);
    m.nativeBtc += ratio(n.sats, 10n ** 8n);
    m.nativeUsd += usd(n, ratio(n.sats, 10n ** 8n));
}
console.log('\nBy month (pool volume per leg | NativeSwap):');
for (const [k, m] of [...months].sort()) console.log(`  ${k}  ${f(m.btc).padStart(9)} BTC ${$(m.usd).padStart(11)}  (${m.swaps} swaps) | ${f(m.nativeBtc)} BTC`);

const perPool = new Map<string, { swaps: number; btc: number; usd: number }>();
for (const s of priced) {
    const p = perPool.get(s.pool) ?? { swaps: 0, btc: 0, usd: 0 };
    p.swaps++;
    p.btc += s.btc;
    p.usd += usd(s, s.btc);
    perPool.set(s.pool, p);
}
const poolName = (p: string): string => pools.get(p)!.map(label).join('/');
const ranked = [...perPool].sort((a, b) => b[1].btc - a[1].btc);
console.log('\nTop pools:');
for (const [p, v] of ranked.slice(0, 10)) console.log(`  ${poolName(p).padEnd(24)} ${f(v.btc).padStart(9)} BTC  ${v.swaps} swaps`);

if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'motoswap-monthly.csv'), ['month,pool_swaps,pool_volume_btc,pool_volume_usd,lp_fees_usd,staker_fees_usd,nativeswap_btc,nativeswap_usd',
        ...[...months].sort().map(([k, m]) => [k, m.swaps, f(m.btc, 6), Math.round(m.usd), Math.round(m.usd * LP_FEE), Math.round(m.usd * STAKER_FEE), f(m.nativeBtc, 6), Math.round(m.nativeUsd)].join(','))].join('\n') + '\n');
    writeFileSync(join(outDir, 'motoswap-pools.csv'), ['pool,token0,token1,pair,swaps,volume_btc,volume_usd',
        ...ranked.map(([p, v]) => [p, ...pools.get(p)!, poolName(p), v.swaps, f(v.btc, 6), Math.round(v.usd)].join(','))].join('\n') + '\n');
    console.log(`\nWrote ${join(outDir, 'motoswap-monthly.csv')} and ${join(outDir, 'motoswap-pools.csv')}`);
}
