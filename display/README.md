# Parallax encounters display

A big-screen and phone view of the demo event: each event key as a friendly
tag, mutual encounters appearing slot by slot, who passed the human check, the
rule status per key, and commitments landing in the Sepolia registry. It is a
presentation page, labelled **NON-CANONICAL** like the graph export it is built on.

## Where the data comes from

`feed.ts` runs the evaluator's own code; it has no decoder or rule of its own.

1. **Parallax operator**: observations, signed commitments and inclusion
   receipts, paged by `loadEnvelopes` (`evaluator/src/io.ts`).
2. **Alcor**: the signed human-check credential list, read with `readSource`.
3. **Sepolia**: `checkAdmissionRegistries` and `readAnchorsFromRegistry`
   (`evaluator/src/chain.ts`) check the event registration and definition and
   map every commitment to its registry block.
4. `verifyEvidence` and `evaluateRule` verify and evaluate; the unchanged
   `graph` exporter (`evaluator/src/graph.ts`) produces one frame per 5-minute
   slot.
5. `lib/compact.mjs` keeps only the change points of those frames and fails the
   refresh unless replaying them reproduces every exported frame exactly.

The page (`public/`) is static, with no external requests, and only replays
the change points in `live.json`.

For the live preview the cutoff is the registry block of the newest commitment
the operator serves, and the evaluator's completeness check runs at that block.
Commitments recorded on chain after it are listed as *awaiting evidence*: only
their sequence, block and commit time come from the registry log, filtered to
the event's registered operator as in the evaluator.

## Run it

Requires Node.js 22+ and pnpm. From the repository root:

```sh
(cd evaluator && pnpm install --frozen-lockfile)
cd display
npm run build              # dist/: page, fonts, recorded snapshot 1 feed
npm test                   # round trips against the evaluator's exporter
npm run live -- --host 0.0.0.0
```

The `build`, `feed`, `live` and `test` scripts run the evaluator's tsx
(`../evaluator/node_modules/.bin/tsx`), so install the evaluator first.

`npm run live` refreshes `dist/live.json` every 120 seconds (about a minute per
refresh, mostly registry reads) and serves `dist/` on port 4180. `--host 0.0.0.0`
makes it reachable from a phone on the same network; the default is
`127.0.0.1`. A failed refresh keeps the last good feed and writes the reason
to `dist/status.json`; the page then says the feed is behind. Proxy variables
in the environment can break the public endpoints; unset them if requests fail.

Other `feed.ts` options: `--snapshot <evaluation dir>` (recorded, offline),
`--params <file>` (default `docs/demo/params-0xccb8770a.json`), `--out <file>`,
`--rpc <url | env:NAME>` (default `SEPOLIA_RPC_URL` or the public Sepolia RPC),
`--from-block`, `--confirmations` (default 5), `--min-log-span`,
`--max-log-calls`, `--watch <seconds>`, `--serve`, `--host`, `--port`.

## Views

- `/` follows `live.json`: the live preview when `npm run live` is running,
  otherwise the recorded snapshot the build placed there.
- `/?view=snapshot1`: the posted snapshot 1, recorded, for a still at 1920×1080.
- `?theme=light` for bright rooms; `?autoplay=5` replays the slots after five
  idle minutes.
- **Replay** or Space plays the slots with encounters; **Live** or `L` returns;
  the slider and arrow keys step through slots.

## What the labels mean

- **Minutes behind.** An observation appears only after its commitment is
  anchored and the operator publishes the evidence. The header says how long ago
  the newest shown slot ended.
- **Keys and time slots only.** No names, no locations. Tags (colour, animal,
  first four hex digits) are derived from the event-key address; full addresses
  and human-check times are not shown.
- **Preview versus posted.** A live rule status is computed at a recent block and
  is not posted. Only snapshot 1 is posted; its archive is read from
  `web/public/snapshots/1`, and in live mode its `RootPosted` event is read back
  and compared with the archive's root, cutoff and manifest digest.
- **Human check** is as of the cutoff, as in the exporter: replayed slots show a
  key's final credential state.
- **NON-CANONICAL.** The exporter's notice is shown verbatim.

## Data shipped to the browser

`live.json` and `snapshot-1.json` carry full event-key addresses
(`keys[].address`, `pairs[].a` and `b`, `outcome.eligible`, `posted.eligible`)
and each pair's slot indices. The screen shows only the tag and four hex digits,
but anyone can read the addresses from the JSON. This adds no new exposure: each
signed observation in the operator's evidence carries its event key, the Alcor
credential list names the address of every human-checked key, and the published
snapshot's `eligible.json` lists its keys; the slot indices can be recomputed
from the same evidence. Human-check times are not in the feed.

## Static hosting

- The CSP and security headers come from `serve.mjs`. A plain static host drops
  them, so a deployment must add equivalent headers, for example a `_headers`
  file as `site/try` does.
- A static copy of `dist/` serves whatever `live.json` it was given; the page
  labels recorded data and flags a live feed older than eight minutes.

## Limits

- Slot times are window index × 300 seconds, the slot length in the claim page
  configuration. In the snapshot 1 archive every observation was signed at or
  after the start of its window, which is consistent with that length.
- A key that appears right after someone completes the human check could be
  linked to that person by a bystander. The display adds no timing beyond the
  public lists, but it does make them easy to watch.
- Two keys can share an animal; the colour and the four hex digits tell them apart.
