import { concat, encodeAbiParameters, getAddress, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";
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
  if (typeof raw.claimContract !== "string" || !isAddress(raw.claimContract) ||
      raw.claimContract === zeroAddress || BigInt(raw.claimContract) === 1n) {
    throw new Error("claimContract must be a deployed contract address, not an example address");
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
export function validateSnapshot(config: ClaimPageConfig, readJson: (path: string) => unknown): void {
  const directory = `/snapshots/${config.snapshotId}`;
  const manifest = readJson(`${directory}/manifest.json`) as { root?: string; parameters?: { eventId?: string } } | undefined;
  if (manifest?.root?.toLowerCase() !== config.expectedRoot.toLowerCase() ||
      manifest?.parameters?.eventId?.toLowerCase() !== config.eventId.toLowerCase()) {
    throw new Error("Snapshot manifest does not match expectedRoot and eventId");
  }
  const eligible = parseEligibleFile(readJson(config.eligibleJsonUrl));
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
}
