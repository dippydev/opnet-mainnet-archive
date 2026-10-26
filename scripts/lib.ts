import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';

export interface ArchivedEvent {
    b: number;
    h: string;
    c: string;
    t: string;
    d: string;
}

export interface ArchivedTx {
    b: number;
    h: string;
    y: 'Interaction' | 'Deployment';
    c: string | null;
    cp: string | null;
    f: string | null;
    fl: string | null;
    g: string | null;
}

export async function* readJsonlGz<T>(path: string): AsyncGenerator<T> {
    const input = createReadStream(path);
    const lines = createInterface({ input: path.endsWith('.gz') ? input.pipe(createGunzip()) : input, crlfDelay: Infinity });
    for await (const line of lines) {
        if (line) yield JSON.parse(line) as T;
    }
}

export async function readAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for await (const row of readJsonlGz<T>(path)) out.push(row);
    return out;
}

export const payload = (e: ArchivedEvent): Buffer => Buffer.from(e.d, 'base64');

/** 32-byte big-endian word `i` as an unsigned integer. */
export const word = (d: Buffer, i: number): bigint => {
    const hex = d.subarray(32 * i, 32 * i + 32).toString('hex');
    return hex ? BigInt('0x' + hex) : 0n;
};

/** 32-byte word `i` as a lowercase 0x-hex address (contract or account identity). */
export const addr = (d: Buffer, i: number): string => '0x' + d.subarray(32 * i, 32 * i + 32).toString('hex');

/** Arbitrary byte range as an unsigned integer (for u64/u128 fields that are not word-sized). */
export const uint = (d: Buffer, start: number, len: number): bigint => BigInt('0x' + (d.subarray(start, start + len).toString('hex') || '0'));

/** Ratio of two bigints as a float, without converting either operand past 2^53 first. */
export const ratio = (num: bigint, den: bigint): number => {
    if (den === 0n) return NaN;
    const SCALE = 10n ** 18n;
    return Number((num * SCALE) / den) / 1e18;
};

export const KNOWN: Record<string, string> = {
    '0xbaf131d22120efe459586eb9eda2590f78044851bfcda49365ed1c1dbc863ee4': 'NativeSwap',
    '0x6b5e5d3cd163c9d7757afcb358413039d040b143b3a23ddd05a83506d3682bf3': 'MotoSwap Factory',
    '0xa291c5f3093af34bd81499a0c78f857646a65dd16f3348b2926a2344351277d2': 'MotoSwap Router',
    '0xab99e31ebb30b8e596d5be1bd1e501ee8e7b7e5ec9dc7ee880f4937b0c929dcb': 'MotoSwap Staking',
    '0xc3d18f9d7db3f26ed107a9f4a4c65eef14c1ca73db5684ef9789fdd4fbb3ea9a': 'MOTO',
    '0xc6c3674b1c6c4ca3d4b3652d1d6fc2b197f45c4ad1eda90d37952472719d1c05': 'PILL',
    '0x3552e35d64924320b6856b5972233c858ff5b7ef193b3ad4325ea59bfbbf61f2': 'sBTC',
    '0x9a6d3d464f6fc3781e4df506ef3595f63121bf8fba48cd27f8b730c4ca14a549': 'SLOHM',
    '0xa325f4a88591cd8382a6a0188dbf89ccb1943e20bb4b2991cbc3edd852ee7aea': 'ySLOHM',
    '0xe62ed19905db8179a26cb4d980a6eb8c27716c97ac9140d21d003d5b4ad9c1fa': 'SATL',
};

export const label = (a: string): string => KNOWN[a] ?? a.slice(0, 10);

/** First block of each calendar month (UTC), from Bitcoin block timestamps via mempool.space. */
export const MONTH_STARTS: ReadonlyArray<[number, string]> = [
    [938781, '2026-03'],
    [943130, '2026-04'],
    [947349, '2026-05'],
    [951914, '2026-06'],
    [956141, '2026-07'],
    [960482, '2026-08'],
];

export const monthOf = (block: number): string => {
    let m = MONTH_STARTS[0][1];
    for (const [start, name] of MONTH_STARTS) if (block >= start) m = name;
    return m;
};
