# Recorded synthetic comparison inputs

These are **RECORDED SYNTHETIC TEST VECTORS**, not live observations, real
World ID proofs, or chain records. Generate them from the evaluator directory:

```sh
node_modules/.bin/tsx test/fixtures/generate.ts --comparison
```

The existing fixture generator creates signed observations, an observation
commitment and inclusion receipts, signed test credentials, and a synthetic
anchor-block mapping. Its default fixtures remain byte-for-byte unchanged.
All signing keys are derived from public test labels and must never hold funds.

- Honest attendees A, B and C each meet the other two in windows 1 and 2.
- Mallory controls M1, M2 and M3. The three phones meet only each other in the
  same two windows. Only M1 has a credential, representing one World ID;
  M2 and M3 have no credentials. Without the human check all three qualify.
  With both requirements none qualify, because M1 has no credentialed
  partners. Zero satisfies the scenario's limit of at most one record.
- The walk-in D has a credential and no observations or encounters. Venue
  check-in is a scenario assumption; this evaluator has no check-in input.

The rule requires two distinct qualifying partners and two windows per partner.
The case-to-address mapping and recorded-synthetic provenance are in
`params.json`. The [comparison report](../../../../docs/demo/comparison.md)
shows eligibility counts only. No comparison root is published or posted.
