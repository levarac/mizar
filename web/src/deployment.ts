import { concat, encodeAbiParameters, getAddress, keccak256, sha256, toBytes, type Address, type Hex } from "viem";
import { assertProofRoot, findEligible, parseEligibleFile, parseProofFile } from "./eligibility";

export type ClaimPageConfig = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  claimContract: Address;
  eventId: Hex;
  eligibleJsonUrl: string;
  expectedRoot: Hex;
  snapshotId: number;
};

const eventId = "0xccb8770a524f4145e04b3c97d8ffe2f7301ce65b4041d80e419bafdd803b2ee1";
const claimContract = "0xC54b23Ce524ea22D41A65c2EfceEc5e483f2F0fC";
const publicRpc = "https://ethereum-sepolia-rpc.publicnode.com";

export function parseDeploymentConfig(value: unknown): ClaimPageConfig {
  if (!value || typeof value !== "object") throw new Error("Missing deployment configuration");
  const raw = value as Record<string, unknown>;
  const pending = Object.keys(raw).filter((key) => typeof raw[key] === "string" && raw[key].startsWith("REPLACE_"));
  if (pending.length) throw new Error(`Unresolved deployment values: ${pending.join(", ")}`);
  if (raw.chainId !== 11155111) throw new Error("chainId must be 11155111 (Sepolia)");
  if (raw.chainName !== "Sepolia") throw new Error("chainName must be Sepolia");
  if (raw.eventId !== eventId) throw new Error("eventId must identify the live demo event");
  if (raw.rpcUrl !== publicRpc) throw new Error("rpcUrl must be the configured public Sepolia endpoint");
  if (raw.claimContract !== claimContract) {
    throw new Error(`claimContract must be the pinned Sepolia contract ${claimContract}`);
  }
  if (typeof raw.expectedRoot !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw.expectedRoot) ||
      /^0x0{64}$/.test(raw.expectedRoot)) throw new Error("expectedRoot must be a nonzero bytes32 root");
  if (typeof raw.snapshotId !== "number" || !Number.isSafeInteger(raw.snapshotId) || raw.snapshotId < 0) {
    throw new Error("snapshotId must be a nonnegative safe integer");
  }
  if (raw.eligibleJsonUrl !== `/snapshots/${raw.snapshotId}/eligible.json`) {
    throw new Error("eligibleJsonUrl must be /snapshots/<snapshotId>/eligible.json on this origin");
  }
  return { ...raw, claimContract: getAddress(raw.claimContract) } as ClaimPageConfig;
}

/** Check the files that Vite will copy into the static-assets deployment. */
export function validateSnapshot(config: ClaimPageConfig, readJson: (path: string) => unknown, proofPaths: readonly string[]): void {
  const directory = `/snapshots/${config.snapshotId}`;
  const manifest = readJson(`${directory}/manifest.json`) as {
    root?: string;
    parameters?: { eventId?: string; chainId?: number };
    outputDigests?: { eligible?: string };
  } | undefined;
  if (manifest?.root?.toLowerCase() !== config.expectedRoot.toLowerCase() ||
      manifest?.parameters?.eventId?.toLowerCase() !== config.eventId.toLowerCase()) {
    throw new Error("Snapshot manifest does not match expectedRoot and eventId");
  }
  if (manifest?.parameters?.chainId !== 11155111) throw new Error("Snapshot manifest chainId must be 11155111");
  const rawEligible = readJson(config.eligibleJsonUrl);
  const eligible = parseEligibleFile(rawEligible);
  // Match the evaluator's digest of JSON.stringify(parsed eligible.json), not its pretty-printed file bytes.
  const digest = sha256(toBytes(JSON.stringify(rawEligible))).slice(2);
  if (manifest.outputDigests?.eligible !== digest) throw new Error("eligible.json digest does not match the snapshot manifest");
  for (const address of eligible.addresses) {
    if (!findEligible(eligible, address)) throw new Error("eligible.json is missing an address explanation");
    const file = parseProofFile(readJson(`${directory}/proofs/${address.toLowerCase()}.json`));
    if (file.address !== address) throw new Error("Snapshot proof address mismatch");
    assertProofRoot(file, config.expectedRoot);
    // OpenZeppelin StandardMerkleTree double-hashes the ABI-encoded address leaf.
    let node = keccak256(keccak256(encodeAbiParameters([{ type: "address" }], [address])));
    for (const sibling of file.proof) {
      node = keccak256(concat(BigInt(node) < BigInt(sibling) ? [node, sibling] : [sibling, node]));
    }
    if (node.toLowerCase() !== config.expectedRoot.toLowerCase()) throw new Error("Invalid snapshot membership proof");
  }
  const lists = new Map([[directory, new Set(eligible.addresses)]]);
  for (const path of proofPaths) {
    const match = /^(\/snapshots\/[^/]+)\/proofs\/(0x[0-9a-f]{40})\.json$/.exec(path);
    if (!match) throw new Error(`Unlisted proof path: ${path}`);
    const [, snapshotDirectory, address] = match;
    if (!lists.has(snapshotDirectory)) {
      lists.set(snapshotDirectory, new Set(parseEligibleFile(readJson(`${snapshotDirectory}/eligible.json`)).addresses));
    }
    if (!lists.get(snapshotDirectory)!.has(getAddress(address))) throw new Error(`Unlisted proof: ${path}`);
    if (parseProofFile(readJson(path)).address !== getAddress(address)) throw new Error(`Snapshot proof address mismatch: ${path}`);
  }
}
