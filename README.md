# OPNet Mainnet Archive

Every OPNet contract event and contract transaction from mainnet activation to shutdown.

OPNet mainnet ran on Bitcoin from block **941,396** (20 Mar 2026) to **964,814** (31 Aug 2026). Its nodes are gone, and OPNet never had an event-index RPC (no `eth_getLogs` equivalent), so this archive was built by walking every block over the JSON-RPC before shutdown. It captures **all events from all contracts**, not a filtered subset.

| File | Rows | Size |
|---|---|---|
| `events-to-964814.jsonl.gz` | 312,989 events | 15.0 MB |
| `txs-to-964814.jsonl.gz` | 184,690 transactions (184,350 interactions, 340 deployments) | 11.5 MB |

The last block with any OPNet transaction is 964,593. No contract activity occurred in the final 221 blocks.

## Download and verify

The data files are attached to the [latest release](../../releases/latest).

```sh
gh release download --repo dippydev/opnet-mainnet-archive --dir archive --pattern '*.gz'
(cd archive && shasum -a 256 -c ../SHA256SUMS)   # hashes only
node scripts/check.ts                           # hashes, row counts and block range (Node >= 23.6)
```

Before shutdown, 22 sampled blocks (including every scan crash/resume seam and the most recent blocks) were re-fetched from the live chain and matched the archive exactly. No block exhausted its retries.

## Format

Gzipped JSON Lines, one object per line, ordered by block and then by position within the block.

**`events`**

| Field | Meaning |
|---|---|
| `b` | Bitcoin block height |
| `h` | Transaction hash (hex) |
| `c` | Emitting contract identity (32-byte hex, lowercase) |
| `t` | Event name (e.g. `Transferred`, `Swapped`) |
| `d` | Event payload, **base64** |

**`txs`**

| Field | Meaning |
|---|---|
| `b`, `h` | Block height, transaction hash |
| `y` | `Interaction` or `Deployment` (plain Bitcoin payments are not included) |
| `c` | Contract address, `op1…` bech32 |
| `cp` | Contract identity, 32-byte hex (the form used inside event payloads) |
| `f` | Sender identity (hash of the sender's ML-DSA key), hex |
| `fl` | Sender's legacy (secp256k1) key, hex |
| `g` | Gas used, hex |

Contract identities (`cp`, event `c`, addresses inside payloads) and `op1…` addresses are **not** interconvertible. Use deployment rows in `txs` to map between them.

### Decoding payloads

Payload fields are 32-byte big-endian words unless noted. Addresses are 32-byte identities.

| Event | Layout |
|---|---|
| `Transferred` (OP20/OP721) | operator, from, to, amount \| tokenId |
| `Minted` | to, amount |
| `Burned` | from, amount |
| `Approved` | owner, spender, amount |
| `PoolCreated` (MotoSwap Factory) | token0, token1, pool |
| `Synced` (MotoSwap pool) | reserve0, reserve1 — emitted **before** `Swapped` in the same tx |
| `Swapped` (MotoSwap pool) | sender, amount0In, amount1In, amount0Out, amount1Out, to |
| `SwapExecuted` (NativeSwap) | buyer (32), amountIn sats (**u64, 8 bytes**), amountOut (32), totalFees (32) — 104 bytes |

`scripts/lib.ts` has a streaming reader and word decoders:

```ts
import { readJsonlGz, payload, word, addr, type ArchivedEvent } from './scripts/lib.ts';

for await (const e of readJsonlGz<ArchivedEvent>('archive/events-to-964814.jsonl.gz')) {
    if (e.t !== 'Transferred') continue;
    const d = payload(e);
    console.log(e.b, e.c, addr(d, 1), '->', addr(d, 2), word(d, 3));
}
```

## Key contracts

| Contract | Identity | Address | Deployed |
|---|---|---|---|
| NativeSwap | `0xbaf131d22120efe459586eb9eda2590f78044851bfcda49365ed1c1dbc863ee4` | `op1sqzjrvunc39nahkr6a0d4vx7rjdfjfc7qtqhp9wks` | 941,396 |
| PILL | `0xc6c3674b1c6c4ca3d4b3652d1d6fc2b197f45c4ad1eda90d37952472719d1c05` | `op1sqz0f729q22dv6trrvhn9msl9enqqaazy5cjy4ej6` | 941,398 |
| MOTO | `0xc3d18f9d7db3f26ed107a9f4a4c65eef14c1ca73db5684ef9789fdd4fbb3ea9a` | `op1sqrxd0p3kd234wc5n2z7pl4hs82y8kpk4fqj9h78a` | 941,400 |
| MotoSwap Staking | `0xab99e31ebb30b8e596d5be1bd1e501ee8e7b7e5ec9dc7ee880f4937b0c929dcb` | `op1sqze4wwznpdev5t2h8pfmyfewhdfzlfxjeqm9alsp` | 941,926 |
| MotoSwap Factory | `0x6b5e5d3cd163c9d7757afcb358413039d040b143b3a23ddd05a83506d3682bf3` | `op1sqpud62qd6gewyz4vd8x6lyrtwv6dkrd8n56j5ujw` | 943,133 |
| MotoSwap Router | `0xa291c5f3093af34bd81499a0c78f857646a65dd16f3348b2926a2344351277d2` | `op1sqp3wc55qyy7wgq3lyykjhrv4k04qc0y2u5v4mmre` | 943,133 |
| SATL | `0xe62ed19905db8179a26cb4d980a6eb8c27716c97ac9140d21d003d5b4ad9c1fa` | `op1sqpj0sretknw3nwgnr5pa6d8zr247j3f995nem73h` | 947,318 |
| SLOHM | `0x9a6d3d464f6fc3781e4df506ef3595f63121bf8fba48cd27f8b730c4ca14a549` | `op1sqptkqrfe4lwyjxns8lu3jn4an4gy7v75hcszqxaq` | 949,028 |
| ySLOHM | `0xa325f4a88591cd8382a6a0188dbf89ccb1943e20bb4b2991cbc3edd852ee7aea` | `op1sqpxnhm0uztmuw4yl7ckg9mk38p5ctt9c75z65z40` | 949,028 |
| sBTC | `0x3552e35d64924320b6856b5972233c858ff5b7ef193b3ad4325ea59bfbbf61f2` | `op1sqpagxdwtcycs299d4wxgmyp3n65qlthynq82pyxq` | 955,332 |

All MotoSwap pools are listed by the Factory's 37 `PoolCreated` events.

## MotoSwap volume and fees

`node scripts/motoswap-volume.ts --out out` rebuilds these from the events. Outputs are also attached to the release as CSVs.

| | BTC | USD |
|---|---|---|
| Pool volume (each pool leg of a routed swap) | 87.13 | $6.37M |
| Pool volume (each transaction counted once) | 83.11 | $6.07M |
| NativeSwap volume (BTC paid in) | 5.02 | $368K |
| LP fees — 0.30% | 0.261 | $19.1K |
| MOTO staker fees — 0.20% | 0.174 | $12.7K |
| NativeSwap fees (paid in tokens) | 0.035 | $2.6K |

4,875 pool swaps across 31 pools; 501 NativeSwap swaps. 70.6 BTC of pool volume (81%) was in April 2026.

**Method.**
- **Fee rates are measured, not assumed.** Pre-swap reserves are rebuilt from each `Synced` event. Every swap shows a 0.30% LP fee, plus 0.20% of output transferred from the pool to MotoSwap Staking.
- **Prices come from the chain itself, not an external feed.** MOTO is priced in sats from NativeSwap BTC→MOTO trades, NativeSwap BTC→PILL trades (converted through the MOTO/PILL pool) and the MOTO/sBTC pool. Each swap uses the median of the 15 nearest observations.
- **USD** uses monthly average BTC/USD from CoinGecko.

**Caveats.**
- **Late-period prices are rough.** NativeSwap MOTO trades are dense through April and May and sparse after, so June–August prices rest on fewer observations.
- **MOTO/PILL is 66.4 BTC of the 87.1 BTC.** Much of it is repeated identical small swaps.
- **NativeSwap's BTC-side fees are not included.** The reservation and priority-queue fees were paid as Bitcoin outputs, not OPNet events, so they are not in this archive.
- **12 pool swaps are unpriced.** Their tokens had no MOTO or PILL price path at the time.

## What is not in the archive

- **Raw calldata and plain Bitcoin outputs** — only events and transaction metadata were kept.
- **Contract storage.** Balances can be replayed from `Transferred`/`Minted`/`Burned`, but rebasing tokens (ySLOHM) cannot be reconstructed exactly from events.
- **Off-chain records** (presale, bridge or server databases).

## License

Data: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) — public chain data, no rights reserved. Scripts: MIT, see `LICENSE`.
