# Canonical output baseline for graph regression coverage

`graph-baseline-a07469b.json` records the output of main commit
`a07469bd3692751a9738d166800fc4d841cf9794`, before the graph command was added.
It was generated from a separate `git archive` extract of that exact commit,
using its unchanged default fixture and evaluator source:

```sh
node --import tsx src/cli.ts evaluate --params test/fixtures/params.json --out <output-directory>
node --import tsx src/cli.ts verify --manifest <output-directory>/manifest.json
```

The fixture contains SHA-256 hashes of every byte in all 11 evaluation output
files (including archived inputs and proofs), plus both commands' exact stdout,
stderr and exit codes. The absolute output path in evaluate stdout is replaced
with `<OUTPUT_DIRECTORY>`; no file content or other receipt field is normalized.

`test/graph.test.ts` compares the current CLI against this baseline without
invoking Git, so a source archive or shallow checkout has the same coverage.
Do not regenerate this fixture from the implementation under test: its purpose
is to detect any change to the pinned canonical output.
