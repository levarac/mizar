# Mizar

Mizar evaluates mutual proximity observations and settles participation claims in batch on-chain.

An existing evidence layer already records, as ordered commitments on Sepolia, that devices observed each other at a real-world event. Mizar is a separate layer on top of that evidence: it decides which mutual observations count as participation, and it lets participants claim the result in one batch. The evidence layer itself does not score attendance or issue anything; that interpretation lives here, so other evaluators can be built on the same evidence.

Per-claimant checks (for example, confirming that each claimant is a distinct person) live in the sibling repository [Alcor](https://github.com/levarac/alcor).

## Status

Built during ETHGlobal Tokyo 2026 (hacking started 2026-09-25 21:00 JST). Work in progress.

## Pre-existing work

This repository was created after the hackathon started, and everything in it was written during the event. It builds on pre-existing work by the same team, which is not part of this repository:

- A mobile app that records and signs BLE proximity observations between attendees.
- An operator service and Solidity contracts on Sepolia that collect signed observations and anchor ordered commitment digests, with Merkle inclusion proofs per observation.
- [Barnard](https://github.com/levarac/barnard), a public MIT-licensed BLE sensing SDK.

Mizar reads that evidence through its public interfaces: the commitment registry contract on Sepolia and the published verification data.

## License

[MIT](LICENSE)
