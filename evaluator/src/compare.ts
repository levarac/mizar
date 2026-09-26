import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { evaluateRule, type CredentialList, type EvaluationOptions, type Parameters } from "./evaluate.js";
import { verifyEvidence, type Envelope } from "./evidence.js";
import { digestBytes } from "./io.js";

type Case = { label: string; addresses: string[] };
type ComparisonParameters = Parameters & {
  comparison?: { provenance?: "recorded-synthetic"; cases: Case[] };
};
const rules: Array<{ label: string; options: EvaluationOptions }> = [
  { label: "No human check", options: { humanGate: false } },
  { label: "No encounter rule", options: { encounterRequirement: false } },
  { label: "Full rule", options: {} },
];

// Comparison has a local-file-only reader and never enters the live input path.
function localPath(source: unknown, base: string): string {
  if (typeof source !== "string" || !source || /^[a-z][a-z\d+.-]*:|^[/\\]{2}/i.test(source))
    throw new Error("compare accepts local recorded inputs only");
  return resolve(base, source);
}
const cell = (text: string) => text.replace(/[|`<>\\\r\n]/g, " ");

export async function compare(paramsFile: string, out: string): Promise<void> {
  const paramsPath = localPath(paramsFile, process.cwd()), base = dirname(paramsPath);
  const paramsBytes = await readFile(paramsPath);
  const params = JSON.parse(paramsBytes.toString()) as ComparisonParameters;
  if (params.rpcUrl !== undefined) throw new Error("compare accepts local recorded inputs only");
  // Validate every location before reading any evidence or credentials.
  const paths = [params.evidenceSource, params.credentialsSource, params.anchorBlocksSource]
    .map(source => localPath(source, base));
  const [evidenceBytes, credentialBytes, anchorBytes] = await Promise.all(paths.map(path => readFile(path)));
  const parsed = JSON.parse(evidenceBytes.toString()) as Envelope | Envelope[];
  const evidence = verifyEvidence(Array.isArray(parsed) ? parsed : [parsed], params.eventId,
    params.snapshot.cutoffBlock, JSON.parse(anchorBytes.toString()));
  const credentials = JSON.parse(credentialBytes.toString()) as CredentialList;
  const results = rules.map(rule => evaluateRule(params, evidence, credentials, rule.options));
  const addresses = [...results[0].eligible, ...results[0].rejected].map(entry => entry.address);
  const cases = params.comparison?.cases ?? addresses.map(address => ({ label: address, addresses: [address] }));
  const seen = new Set<string>(), known = new Set(addresses.map(address => address.toLowerCase()));
  if (!Array.isArray(cases)) throw new Error("comparison cases must be an array");
  for (const group of cases) {
    if (!group || typeof group.label !== "string" || !group.label.trim() ||
        !Array.isArray(group.addresses) || group.addresses.length === 0)
      throw new Error("comparison cases need a label and addresses");
    for (const address of group.addresses) {
      if (typeof address !== "string" || !known.has(address.toLowerCase()) || seen.has(address.toLowerCase()))
        throw new Error("comparison cases must name each evaluated address exactly once");
      seen.add(address.toLowerCase());
    }
  }
  if (seen.size !== known.size) throw new Error("comparison cases must name each evaluated address exactly once");
  const rows = cases.map(group => {
    const members = new Set(group.addresses.map(address => address.toLowerCase()));
    const counts = results.map(result =>
      `${result.eligible.filter(entry => members.has(entry.address.toLowerCase())).length} / ${members.size}`);
    return `| ${cell(group.label)} | ${counts.join(" | ")} |`;
  });
  const provenance = params.comparison?.provenance === "recorded-synthetic"
    ? "RECORDED SYNTHETIC test inputs; not live."
    : "RECORDED LOCAL inputs; provenance not independently verified. Not a live run.";
  const inputs = { parameters: paramsBytes, envelopes: evidenceBytes, credentials: credentialBytes,
    "anchor blocks": anchorBytes };
  const report = [
    "# NON-CANONICAL rule comparison", "", provenance, "",
    "Eligibility counts only. Not a live snapshot; not posted. Roots and claim proofs are omitted.", "",
    `N = ${params.minPartners} distinct partners; B = ${params.minWindowsPerPartner} windows per partner; ` +
      `cutoff block = ${params.snapshot.cutoffBlock}; cutoff timestamp = ${params.snapshot.cutoffTimestamp}.`, "",
    `| NON-CANONICAL case | ${rules.map(rule => rule.label).join(" | ")} |`,
    "| --- | --- | --- | --- |", ...rows, "",
    "Each cell is eligible event keys / case event keys, not issued records.", "",
    "No human check disables the credential requirement for candidates and partners. " +
      "No encounter rule disables the partner/window threshold. Full rule uses the default requirements. " +
      "All three reuse the same verified observations, credentials, parameters and cutoff.", "",
    "| NON-CANONICAL input | SHA-256 of recorded file bytes |", "| --- | --- |",
    ...Object.entries(inputs).map(([name, bytes]) => `| ${name} | ${digestBytes(bytes)} |`), "",
    `Invalid observations: ${evidence.invalid.length}. ` +
      `Invalid credentials: ${results[2].invalidCredentials.length}.`, "",
  ].join("\n");
  const dir = localPath(out, process.cwd());
  await mkdir(dir, { recursive: true });
  if ((await readdir(dir)).length) throw new Error("compare requires an empty output directory");
  await writeFile(join(dir, "comparison.md"), report, { flag: "wx" });
  process.stdout.write(report);
}
