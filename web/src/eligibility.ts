import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

export type EligiblePartner = {
  address: Address;
  windows: number[];
};

export type EligibleKey = {
  address: Address;
  partners: EligiblePartner[];
};

export type EligibleFile = {
  addresses: Address[];
  explanations: EligibleKey[];
};

export type ProofFile = {
  address: Address;
  root: Hex;
  proof: Hex[];
};

export function proofsUrlFor(eligibleJsonUrl: string, address: Address): string {
  const url = new URL(eligibleJsonUrl);
  const slash = url.pathname.lastIndexOf("/");
  const dir = slash >= 0 ? url.pathname.slice(0, slash) : "";
  url.pathname = `${dir}/proofs/${getAddress(address).toLowerCase()}.json`;
  return url.toString();
}

function readAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new Error(`${label} is not an address`);
  return getAddress(value);
}

function readWindows(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error("windows must be an array");
  return value.map((window) => {
    if (typeof window !== "number" || !Number.isInteger(window)) throw new Error("window is not an integer");
    return window;
  });
}

/** eligible.json as written by the evaluator: checksummed addresses plus explanations. */
export function parseEligibleFile(value: unknown): EligibleFile {
  if (!value || typeof value !== "object") throw new Error("eligible.json must be an object");
  const raw = value as { addresses?: unknown; explanations?: unknown };
  if (!Array.isArray(raw.addresses) || !Array.isArray(raw.explanations)) {
    throw new Error("eligible.json must contain addresses and explanations");
  }
  const addresses = raw.addresses.map((item) => readAddress(item, "address"));
  const explanations = raw.explanations.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("explanation is not an object");
    const row = entry as { address?: unknown; partners?: unknown };
    if (!Array.isArray(row.partners)) throw new Error("explanation is missing partners");
    return {
      address: readAddress(row.address, "explanation address"),
      partners: row.partners.map((partner) => {
        if (!partner || typeof partner !== "object") throw new Error("partner is not an object");
        const item = partner as { address?: unknown; windows?: unknown };
        return { address: readAddress(item.address, "partner"), windows: readWindows(item.windows) };
      }),
    };
  });
  return { addresses, explanations };
}

export function findEligible(file: EligibleFile, address: Address): EligibleKey | undefined {
  const wanted = getAddress(address);
  if (!file.addresses.includes(wanted)) return undefined;
  return file.explanations.find((key) => key.address === wanted);
}

export function parseProofFile(value: unknown): ProofFile {
  if (!value || typeof value !== "object") throw new Error("proof file must be an object");
  const raw = value as { address?: unknown; root?: unknown; proof?: unknown };
  if (typeof raw.root !== "string" || !isHex(raw.root) || raw.root.length !== 66) {
    throw new Error("proof root is not bytes32");
  }
  if (!Array.isArray(raw.proof)) throw new Error("proof file is missing proof");
  const proof = raw.proof.map((item) => {
    if (typeof item !== "string" || !isHex(item) || item.length !== 66) {
      throw new Error("proof item is not bytes32");
    }
    return item;
  });
  return { address: readAddress(raw.address, "proof address"), root: raw.root, proof };
}

export function assertProofRoot(file: ProofFile, expectedRoot: Hex): void {
  if (file.root.toLowerCase() !== expectedRoot.toLowerCase()) {
    throw new Error(`Proof root ${file.root} does not match the configured root ${expectedRoot}.`);
  }
}
