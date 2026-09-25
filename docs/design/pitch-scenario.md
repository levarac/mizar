# Pitch scenario

Finalist format: 4 minutes of demo, then 3 minutes of Q&A. Judging criteria: Technicality, Originality, Practicality, Usability, WOW factor.

## Claim we can defend

**Evidence of sustained encounters with distinct verified people**, recomputable by anyone. This is not another proof that someone entered a venue.

- World ID tells us *who is one human*, but not whom they met.
- The observation evidence tells us *who reciprocally met whom, across time windows*, but not how many people are behind the phones.

The record needs both.

Tagline candidate: *One real person, real encounters, a record anyone can check.*

## Scenario (v2)

**0:00 Hook (20 s).** Some rewards should go to people who actually took part, not to people who only passed the door. Examples are a networking-session reward, a follow-up event invite, or a builders' grant for teams that formed on site. Door check-ins cannot express this, and a device farm can fake any count-based rule.

**0:20 Live evidence (40 s).** Two phones on stage observe each other. Their signed observation appears in the evidence feed, and its commitment is anchored on Sepolia. All older traces are labeled as recorded evidence, including the attack traces and the two-time-window history. They are inputs to the same verifier, not screenshots.

**1:00 One rule, two counterfactuals (80 s).** Run the same verifier over the same signed data, with the rule's parameters (N, B, cutoff) and input hashes shown on screen.

| Participant | Full rule | Without the World gate | Without the encounter requirement (World ID + venue check-in baseline) |
|---|---|---|---|
| Honest attendees | pass | pass | pass |
| Mallory: one verified human, three phones meeting each other | 1 record at most | **3 records** (the farm wins) | 1 record |
| Drive-by: verified and checked in, met nobody | **fail** | fail | **pass** |

"Without World, one person becomes three. Without encounters, walking in is enough. The rule needs both."

**2:20 The verifier is the centerpiece (60 s).** It shows the checks it makes:
- signatures
- the event-key-to-World binding
- distinct-partner counting
- per-partner time windows
- Merkle inclusion
- root recomputation

It also rejects a duplicated observation and a replayed one on screen. The recomputed root matches the one on Sepolia.

**3:20 WOW: the judge edits the rule (30 s).** A judge changes N, or excludes a suspect observation, then reruns the verifier and watches eligibility change. Then one eligible person claims a non-transferable EAS record to a fresh wallet. It is shown last, as publication, not as proof.

**3:50 Limits in one line (10 s).** BLE relay and colluding verified humans are not stopped. The rule makes farming costly and makes the result auditable; it is not called unfarmable.

## What changed from v1, and why

v1 compared three columns: evidence only, World only (check-in), and both. It also used a "Rob" who held a real World ID but stayed home. An independent review, written from the point of view of a skeptical judge who knows the prior World ID attendance projects, found:

- **The World-only column was a straw man.** A staffed World ID check-in would reject a remote person, so "Rob passes with World only" collapses in Q&A. v2 replaces it with a fair baseline, World ID plus a venue check-in, and a drive-by attendee who beats that baseline but fails the encounter rule.
- **Prerecorded groups presented as live do not convince.** v2 keeps two live phones and labels every other trace as recorded input to the same verifier.
- **Six phones completing two time windows inside four minutes is not credible.** The two-window history is recorded evidence.
- **An EAS record on a block explorer proves publication, not the encounters.** v2 moves the claim to the end and makes the verifier the centerpiece.
- **The stake has to be something where meeting people matters.** A bare attendance badge is too weak. v2 frames the use as rewards for real participation.
- **The WOW factor comes from letting a judge change the rule and rerun it**, not from a badge appearing.

## Questions to prepare for

- "HackPass and WiFiProof already combine World ID with check-in or venue proof. What is new?" Sustained encounters with distinct verified humans, counted per partner across time windows, and recomputable by anyone. Neither prior project evaluates an encounter graph.
- "Can't people relay BLE, or collude?" Yes. Relaying must be held per partner across B windows, which raises its cost. Colluding verified humans are out of scope, and we say so.
- "Why trust Alcor?" In this build it is a trusted attester, because World ID 4.0 has no on-chain verifier on Sepolia. Proofs are bound to event keys, published, and signed by Alcor. The gate is replaceable.
- "Privacy: you just showed who met whom." Claiming is opt-in, a fresh wallet is recommended, and anonymous claims with Semaphore are the next step.
