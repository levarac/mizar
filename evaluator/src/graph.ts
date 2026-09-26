import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { eventKeyAddress, fromHex } from "./codec.js";
import { deriveRelations, evaluateRule, verifyCredentials, type CredentialList, type Parameters } from "./evaluate.js";
import { verifyEvidence, type Envelope, type EvidenceResult } from "./evidence.js";

type GraphParameters = Parameters & {
  comparison?: { provenance?: string; cases: Array<{ label: string; addresses: string[] }> };
};
type Status = "passed" | "credentialed_not_passed" | "excluded_duplicate" |
  "not_credentialed" | "no_qualifying_partner";
const lower = (value: string) => value.toLowerCase();
const addressOf = (key: string) => eventKeyAddress(fromHex(key, 33));
function localPath(source: unknown, base = process.cwd()): string {
  if (typeof source !== "string" || !source || /^[a-z][a-z\d+.-]*:|^[/\\]{2}/i.test(source))
    throw new Error("graph accepts local recorded inputs only");
  return resolve(base, source);
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

// This is a presentation sidecar. Canonical evaluate/verify never read or write it.
export async function graph(source: { params?: string; snapshot?: string }, out: string): Promise<void> {
  const base = source.snapshot ? localPath(source.snapshot) : dirname(localPath(source.params));
  const params = await json(source.snapshot ? join(base, "inputs/params.json") : localPath(source.params)) as GraphParameters;
  if (params.rpcUrl !== undefined) throw new Error("graph accepts local recorded inputs only");
  // Archived sources are hints, never locations to fetch. Only fixed local files are read.
  const paths = source.snapshot
    ? ["inputs/envelopes.json", "inputs/credentials.json", "inputs/anchor-blocks.json"].map(p => join(base, p))
    : [params.evidenceSource, params.credentialsSource, params.anchorBlocksSource].map(p => localPath(p, base));
  const [parsed, credentials, anchors] = await Promise.all(paths.map(json)) as
    [Envelope | Envelope[], CredentialList, Record<string, number>];
  const evidence = verifyEvidence(Array.isArray(parsed) ? parsed : [parsed], params.eventId,
    params.snapshot.cutoffBlock, anchors);
  const final = evaluateRule(params, evidence, credentials);
  const finalPassed = new Set(final.eligible.map(node => node.address));
  if (source.snapshot) {
    const [eligible, rejected] = await Promise.all(["eligible.json", "rejected.json"].map(p => json(join(base, p))));
    const expectedEligible = { addresses: final.eligible.map(n => n.address), explanations: final.eligible };
    const expectedRejected = { keys: final.rejected, rpidConflicts: final.rpidConflicts,
      invalidObservations: final.invalidObservations, invalidCredentials: final.invalidCredentials };
    if (JSON.stringify(eligible) !== JSON.stringify(expectedEligible) || JSON.stringify(rejected) !== JSON.stringify(expectedRejected))
      throw new Error("snapshot outputs differ from recomputed local inputs");
  }
  const { accepted, invalid } = verifyCredentials(credentials, params);
  const duplicate = new Set(invalid.filter(n => n.reason === "duplicate_nullifier_or_key").map(n => lower(n.address)));
  const addresses = [...final.eligible, ...final.rejected].map(n => n.address).sort((a, b) => lower(a).localeCompare(lower(b)));
  const cases = params.comparison?.cases ?? [];
  if (!Array.isArray(cases)) throw new Error("graph cases must be an array");
  const membership = new Map<string, { group: string; member: number }>();
  for (const group of cases) {
    if (!group || typeof group.label !== "string" || !Array.isArray(group.addresses)) throw new Error("invalid graph case");
    for (const [index, address] of group.addresses.entries()) {
      if (typeof address !== "string" || !addresses.some(a => lower(a) === lower(address)) || membership.has(lower(address)))
        throw new Error("invalid graph case membership");
      membership.set(lower(address), { group: group.label, member: index + 1 });
    }
  }
  const frame = (slot: number | null) => {
    const prefix: EvidenceResult = { ...evidence,
      observations: evidence.observations.filter(o => slot !== null && o.enin <= slot) };
    const evaluated = evaluateRule(params, prefix, credentials);
    const relations = deriveRelations(prefix.observations);
    const edges = [...relations.pairs].map(([pair, windows]) => {
      const [source, target] = pair.split(":").map(addressOf).sort((a, b) => lower(a).localeCompare(lower(b)));
      return { source, target, windows: [...windows].sort((a, b) => a - b),
        counted: accepted.has(lower(source)) && accepted.has(lower(target)) };
    }).sort((a, b) => lower(a.source + a.target).localeCompare(lower(b.source + b.target)));
    const nodes = addresses.map(address => {
      const credentialed = accepted.has(lower(address));
      const reached = evaluated.eligible.find(n => n.address === address);
      // Counters follow the replay prefix, but late conflicts must never turn
      // a final rejection into an earlier PASS in this snapshot presentation.
      const pass = reached && finalPassed.has(address);
      const reject = evaluated.rejected.find(n => n.address === address) ??
        final.rejected.find(n => n.address === address);
      const mutual = edges.filter(e => e.source === address || e.target === address);
      const partnerCount = reached?.partners.length ?? reject?.partnerCount ?? 0;
      const qualifyingPartners = reached?.partners.filter(p => p.windows.length >= params.minWindowsPerPartner).length ??
        reject?.qualifyingPartners ?? 0;
      const status: Status = pass ? "passed" : !credentialed
        ? duplicate.has(lower(address)) ? "excluded_duplicate" : "not_credentialed"
        : mutual.length === 0 ? "no_qualifying_partner" : "credentialed_not_passed";
      return { address, ...membership.get(lower(address)), credentialed, status,
        partnerCount, qualifyingPartners, reason: pass ? null : reject?.reason ?? "not_credentialed" };
    });
    return { slot, nodes, edges };
  };
  const windows = [...new Set(evidence.observations.map(o => o.enin))].sort((a, b) => a - b);
  const first = windows[0] ?? 0, last = windows.at(-1) ?? -1;
  // Bound a presentation export rather than allocating an unbounded replay from hostile indices.
  if (last - first > 4095) throw new Error("graph replay exceeds 4096 slots");
  const frames = [frame(null)];
  for (let slot = first; slot <= last; slot++) frames.push(frame(slot));
  const ending = frames.at(-1)!;
  const data = { version: 1, kind: "NON-CANONICAL",
    provenance: params.comparison?.provenance === "recorded-synthetic" ? "recorded-synthetic" : "recorded-local",
    notice: "Presentation only. No chain verification, root, manifest or claim proofs. Credentials are fixed at the snapshot cutoff; observation windows replay in order.",
    eventId: params.eventId,
    rule: { minPartners: params.minPartners, minWindowsPerPartner: params.minWindowsPerPartner, slotSeconds: 300 },
    nodes: ending.nodes, edges: ending.edges, frames,
    diagnostics: { invalidObservations: evidence.invalid.length, invalidCredentials: invalid.length } };
  const output = localPath(out);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("graph requires an empty output directory");
  await writeFile(join(output, "graph.json"), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
  console.log(`NON-CANONICAL graph: ${data.nodes.length} keys, ${data.edges.length} mutual pairs, ${frames.length - 1} slots`);
}
