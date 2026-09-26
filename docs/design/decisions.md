# Design decisions

A running log of how Mizar's design was reached during ETHGlobal Tokyo 2026, including options that were considered and dropped. Newest decisions are appended at the end. Status is one of **decided**, **proposed** (awaiting a maintainer decision), or **open**.

Terms used below:

- **Evidence layer**: the pre-existing system that collects signed BLE observations from attendees' phones, batches them into Merkle commitments, anchors the commitment digests on Sepolia, and serves the signed observations with inclusion proofs.
- **Event key**: a secp256k1 key derived per device per event. It signs that device's observations and stays the same for the whole event, but it is not a permanent identity.
- **RPID**: a rotating BLE identifier. An observation says "my RPID was X, and I heard RPIDs Y, Z in time window W".
- **Time window (ENIN)**: a numbered slot of fixed length (300 s by default), declared by the observing device.
- **Reciprocal relation**: within one time window, A heard B and B heard A. The evidence layer already defines a deterministic derivation for this.

---

## D1. Mizar is a separate layer and a separate repository (decided, 2026-09-25)

**Context.** The evidence layer states that it does not decide whether an observation is true, score attendance, or issue anything.

**Decision.** Mizar lives in its own repository and reads the evidence only through public interfaces: the commitment registry on Sepolia and the published verification data. Per-person checks live in a second repository, [Alcor](https://github.com/levarac/alcor), because they concern a different subject (one person at claim or join time) from Mizar's (a rule over everyone's evidence).

**Why.** Evidence and interpretation are different layers. Keeping interpretation out of the evidence layer lets other evaluators, with other rules and other rewards, be built on the same evidence. It also keeps all hackathon code in public repositories, as the event rules require for new work.

**Dropped.** Putting the evaluator inside the evidence layer's repository. That would mix the layers, and publishing that repository would first need a full history review.

## D2. License: MIT (decided, 2026-09-25)

**Options.** MIT, Apache-2.0 (adds an explicit patent grant and a patent-retaliation clause), MPL-2.0, AGPL-3.0. BUSL-1.1 was excluded because it is not an open-source license.

**Decision.** MIT for both Mizar and Alcor.

**Why.** The team's existing public SDK is MIT, so one license keeps later code moves simple. Identity and attestation infrastructure is overwhelmingly MIT in practice: OpenZeppelin Contracts, ENS contracts, EAS contracts, World ID contracts and IDKit, and Semaphore all use it. Apache-2.0's patent terms matter most for projects with their own patents or many outside contributors, which does not apply here yet.

## D3. What a claim gives the claimant (decided, 2026-09-26)

**Options.**
- (A) A non-transferable participation record, one per person per event.
- (B) A share of a reward pool, sized by evaluation.
- (C) Pairwise "we met" records.

**Decision.** (A).

**Why.** It is the smallest step from an evidence layer that deliberately issues nothing. It also keeps the evaluation a yes/no question. (B) raises the incentive to cheat and demands stricter checks. (C) publishes pairwise meetings by design. A reward can be layered on top of (A) later.

## D4. What the record claims, and what it does not (decided, 2026-09-26)

**Decision.** The record claims: *"a verified distinct human who had reciprocal observations with at least N other verified humans, each across at least B time windows, at event X"*. It is not called proof of attendance or proof of presence.

**Why.** Observations are signed by software, and time windows are self-declared, so a device can claim anything about itself. BLE can be relayed. The evidence layer itself states that a reciprocal relation proves neither truth, proximity, presence, attendance, unique hardware, nor a unique person. The name must not promise more than the evidence supports.

## D5. The evaluation rule (proposed, 2026-09-26)

This decision took two rounds.

**Round 1 options.**
1. At least N distinct reciprocal partners.
2. As in 1, plus at least M distinct time windows.
3. A human-gated graph: only edges whose ends are both verified humans count.
4. Trust seeded from physical anchors and propagated over edges (SybilRank-like).
5. Optimistic settlement with a challenge game.

**Round 1 outcome: a human-gated 2-core.** Vertices are event keys that passed the distinct-human check. Edges are reciprocal relations mapped to keys. Vertices with fewer than 2 partners are removed repeatedly. Two independent reviews agreed on the core insight: event keys can be generated in software and time windows are self-declared, so options 1 and 2 give no sybil resistance by themselves, and all of it comes from the human gate. Option 4 was dropped for this build: venue broadcasts do not appear in participants' published evidence, the venue device holds no key, and a static signed broadcast can be replayed.

**Round 2: switch to a per-counterpart threshold, not iterative.** An eligible key needs at least N distinct verified partner keys, and each of those partners must reciprocate in at least B distinct time windows. No iterative removal.

**Why round 2 changed the answer.**
- **False negatives are the launch-blocking metric.** Field measurements from earlier pilots (3 real events, 43 devices) put the honest pass rate at 81 / 72 / 65 / 51 / 44 % for N = 1..5. The dominant causes were app permissions, UX, and a silent reporting layer, not radio: one device was detected 75 times by others but never reported. Iterative removal cascades: an honest person whose partner fails is removed, which can remove more honest people. It buys almost nothing against colluding groups, which pass either way.
- **Time windows raise relay cost even though they do not stop sybils.** In a relay attack, one end is an honest phone that declares honest time windows. The relay therefore has to be held with each counterpart across B windows. Counting windows in total rather than per counterpart was rejected earlier for this reason: it lets a lone relay qualify for roughly B + (N − 1) windows.
- **B is a parameter.** Every measured pass rate is at B = 1. For the demo the event definition uses a shorter window (for example 60 s) so that B = 2 fits in minutes, and a B = 1 definition is kept as a fallback.

**Extra rule: RPID squatting.** The reciprocal derivation pairs RPIDs, not keys. A fake key could sign someone else's RPID as its own and inherit their relations. Any RPID that more than one key signs as its own is dropped before mapping relations to keys.

**Parameters are fixed before the event** (N, B, the evidence cutoff block, and the claim window), so they cannot be tuned after seeing the data.

## D6. The distinct-human gate (decided, 2026-09-26)

**Decision.** Alcor binds one World ID to one event key per event at join time and publishes a signed credential. The proof's signal is bound to (eventId, eventKeyAddress, challenge). At evaluation, Mizar checks the published credential list as of the snapshot cutoff block's timestamp and accepts only the first-verified key per World ID nullifier. The gate is an interface: a desk-issued credential over the event key is an alternative gate with a different trust point.

**Why.** Checking at join lets credentialed participants count as partners even if they never claim, avoiding claim-dependent false negatives.

**Known limit.** World ID 4.0 has no on-chain verifier on Ethereum Sepolia, so a third party cannot re-verify the proofs Alcor accepted, and Alcor is a trusted attester in this build. Mitigations: bind the signal to the event key, publish the proof bundles, and sign each verification result. **Open:** the legacy World ID router that exists on Sepolia could verify on-chain but assumes Orb-level credentials. Whether it is usable for the demo is unchecked.

**Why World and the evidence layer complement each other.** World ID provides uniqueness, one human, but no context: where the person was and whom they met. The evidence layer provides context, who reciprocally observed whom in which time window, but cannot tell one person with N phones from N people. Uniqueness also removes the evidence layer's cold-start problem, because even a small event gets sybil resistance without relying on crowd size. In return, the evidence raises the cost of using a borrowed World ID remotely, since that needs relayed BLE sessions with honest attendees.

## D7. Settlement and verification (proposed, 2026-09-26)

**Decision.**
- After the claim window closes, a deterministic, versioned off-chain program evaluates the rule.
- The event's registered authority posts the eligible Merkle root and the digest of the input manifest to a claim contract on Sepolia.
- Each eligible person claims with a Merkle proof and a signature by their event key over (eventId, recipient, claim contract, chainId). The contract then calls EAS directly. The schema has no resolver and is non-revocable, so the claim contract is the attester and the recipient is the claimant's wallet.
- A public CLI and CI job recompute the result from the published inputs and return a receipt: PASS, FAIL (root mismatch, invalid signature, or threshold miscalculation), or UNAVAILABLE.

**Why.** This makes the result publicly auditable within the time available. It is not trustless: a Merkle proof shows membership in the posted root, not that the root was computed honestly. Recomputation is what catches a dishonest root. A challenge game or an on-chain dispute mechanism would only add protection if it were enforceable, so it is left for later.

## D8. Privacy (proposed, 2026-09-26)

**Tension.** Public recomputation needs the event-key-to-wallet link for every claimant. Reciprocal relations between event keys are already public in the evidence layer, so publishing this link also reveals who met whom among claimants' wallets.

**Proposal.** Claiming is opt-in with an explicit notice of what becomes public, and the claim flow recommends a fresh wallet used only for claims. Anonymous claiming, which proves "my key is in the eligible set" without revealing which key (Semaphore v4 is deployed on Sepolia), is future work. It needs separate commitment enrollment and removal of the public wallet-to-key link.

## Out of scope for the hackathon build

- Relief for honest attendees whose own reports are silent but who were observed by others. This needs a binding from RPID to owner key that does not exist yet. It would be issued as a separate, clearly marked class.
- Trust propagation from venue anchors.
- A challenge game, bonds, or bounties.
- On-chain World ID verification.
- Anonymous claims.

## D9. Claim leaf and the app-side signing entry point (proposed, 2026-09-26)

**Context.** The event key exists only inside the attendee's app. Both the distinct-human binding and the claim need a signature by that key, so the app needs a new entry point that an external web page can call.

**Proposal.**
- **Typed, not blind, signing.** A single app link handler accepts exactly two typed purposes: binding a distinct-human check to the event key, and authorising a claim to a recipient on a given chain and claim contract. The handler shows a plain-language confirmation that includes the full recipient address. A generic "sign these bytes" entry point was rejected because it is blind signing: the app could not show what is being authorised, and the most damaging attack, a claim redirected to an attacker's wallet, is stopped only when the person reads the recipient.
- **Domain-separated digest.** The app signs `SHA256(0xFF || "beid/event-key-sign/v1" || 0x00 || purpose || eventId || body)` with the existing event-key signing call. The leading `0xFF` and the tag keep these signatures from ever parsing as observations. EIP-712 is not possible without changing the SDK, because the SDK signs a SHA-256 of bytes. The contract therefore recovers the signer with ECDSA over this SHA-256 digest.
- **Results go back only to fixed callbacks.** Each purpose returns its result to one compiled-in https callback. Callers cannot choose where results go, and nothing is placed on the clipboard.
- **The leaf is key-only.** The eligible Merkle leaf is the event key's Ethereum address. The recipient is authorised at claim time by the signature. The contract marks `(eventId, eventKeyAddress)` as spent. This replaces the earlier idea of putting the recipient in the leaf, which would have required every recipient to be known before evaluation.

**Side effect on privacy (D8).** With key-only leaves, the published inputs to the recomputation need no wallets. The link from event key to wallet appears only when a person chooses to claim.

**Facts found while reading the app code.**
- The event key is derived per event *code string*, not per registry event ID. A phone that joins the same event by two routes gets two keys, and the RPID-to-key mapping must expect this.
- The device secret is stored in ordinary app preferences, not in hardware. Deleting the app loses the ability to claim.

**Scope.** iOS first. Android devices still contribute observations, but cannot claim in the hackathon build.

**Open.** The two callback URLs; which registry event the demo evaluates. The only registered test event ends exactly at the submission deadline, so claims after the claim window cannot be shown on that event unless Mizar's evaluation window is set independently of the event's validity.

## D10. Feedback during the event: live progress and rolling settlement (proposed, 2026-09-26)

**Problem.** D7 settled once, after the claim window closed. An attendee would not learn that they qualified until after the event, and the only registered test event ends at the submission deadline, so a post-window claim could not be demonstrated in time.

**Key property.** The per-counterpart rule in D5 is monotone in its inputs. Adding observations or verified partners never turns a pass into a fail. The one exception is the RPID-squatting rule: a later conflicting claim on an RPID can remove relations.

**Proposal.** Three levels of feedback.
1. **Live progress (minutes).** A small Mizar service evaluates the not-yet-anchored evidence and shows each attendee only their own progress, for example "verified partners 1/2, windows 2/2". It says "reached" the moment the rule is met. This is provisional and never used for claims.
2. **Rolling settlement (for example every 30 minutes).** The evaluator snapshots the evidence anchored up to a block, computes eligibility, and posts the root with that cutoff. Anyone in a posted root can claim immediately. The record reads "met the rule on evidence anchored up to block X", and each snapshot can be recomputed independently. Because each snapshot is evaluated against its own cutoff, a later squatting claim cannot revoke an earlier eligibility.
3. **Final settlement** after the event ends, so late qualifiers are included.

**Effect on the timing issue in D9.** Rolling snapshots during the test event's validity let the claim be demonstrated before submission, with no new event registration.

**To verify.** How often the evidence layer anchors commitments; this bounds the latency of level 2. Level 1 needs reciprocity data from the evidence layer's live feed, so Mizar runs as a small always-on service as well as a CLI.

## D11. Evidence verification without the committed bundle bytes (decided for the hackathon build, 2026-09-26)

**Problem.** The evidence layer's public verification data returns `bundle: null` for each commitment. Its documentation says a verifier rebuilds the bundle from the observation bytes, but its reference verifier rejects `bundle: null`. The committed bundle also carries delegation certificates, which are not in the observation list, so the committed bundle digest cannot be rebuilt from this response alone.

**Decision.** Mizar verifies what it needs without the bundle bytes:
- the operator's signature on each commitment
- the commitment's on-chain anchor binding
- each observation's Merkle inclusion against the commitment's signed Merkle root
- each observation's own signature

An observation counts for a credentialed event key only when its signature recovers that same key. An observation whose signer is not a credentialed key is `not_credentialed` and cannot contribute to the credentialed graph. Observations carry the signing key but no separately claimed subject key, and the public data carries no delegation certificates, so Mizar cannot tell a delegated signer from an ordinary uncredentialed one. It emits `delegation_unsupported` only when the input explicitly claims a different subject or a delegation path without a verifiable certificate; otherwise delegation status is unknown and not reported. The bundle digest check is out of scope for this build. (Refined the same morning after the implementation coordinator pointed out that the first wording invented a classification the data cannot support.)

**Why this is enough for Mizar.** Delegation certificates prove which keys may sign on behalf of others in the evidence layer. Mizar does not rely on that: an event key counts only after the distinct-human gate has bound it (D6), and relations are built only from observations those keys signed themselves.

**Follow-up for the evidence layer.** Either return the bundle bytes, or state in its documentation that `bundle: null` cannot prove delegated provenance. This mismatch is reported to the evidence-layer maintainers.
