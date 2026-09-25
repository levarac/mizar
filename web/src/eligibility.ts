import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

export type EligibleKey = {
  eventKeyAddress: Address;
  partners: Address[];
  windows: number[];
};

export type EligibleFile = {
  snapshotId?: number;
  keys: EligibleKey[];
};

export type ProofFile = {
  proof: Hex[];
};

export function proofsUrlFor(eligibleJsonUrl: string, address: Address): string {
  const url = new URL(eligibleJsonUrl);
  const slash = url.pathname.lastIndexOf("/");
  const dir = slash >= 0 ? url.pathname.slice(0, slash) : "";
  url.pathname = `${dir}/proofs/${getAddress(address)}.json`;
  return url.toString();
}

export function parseEligibleFile(value: unknown): EligibleFile {
  if (!value || typeof value !== "object" || !Array.isArray((value as { keys?: unknown }).keys)) {
    throw new Error("eligible.json must contain a keys array");
  }
  const raw = value as { snapshotId?: unknown; keys: unknown[] };
  const keys = raw.keys.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("eligible key entry is not an object");
    const row = entry as { eventKeyAddress?: unknown; partners?: unknown; windows?: unknown };
    if (typeof row.eventKeyAddress !== "string" || !isAddress(row.eventKeyAddress)) {
      throw new Error("eligible key is missing eventKeyAddress");
    }
    const partners = Array.isArray(row.partners) ? row.partners : [];
    const windows = Array.isArray(row.windows) ? row.windows : [];
    return {
      eventKeyAddress: getAddress(row.eventKeyAddress),
      partners: partners.map((partner) => {
        if (typeof partner !== "string" || !isAddress(partner)) throw new Error("partner is not an address");
        return getAddress(partner);
      }),
      windows: windows.map((window) => {
        if (typeof window !== "number" || !Number.isInteger(window)) throw new Error("window is not an integer");
        return window;
      }),
    };
  });
  return {
    snapshotId: typeof raw.snapshotId === "number" ? raw.snapshotId : undefined,
    keys,
  };
}

export function findEligible(file: EligibleFile, address: Address): EligibleKey | undefined {
  const wanted = getAddress(address);
  return file.keys.find((key) => key.eventKeyAddress === wanted);
}

export function parseProofFile(value: unknown): Hex[] {
  const proof = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { proof?: unknown }).proof)
      ? (value as { proof: unknown[] }).proof
      : null;
  if (!proof) throw new Error("proof file must be a bytes32 array or { proof: bytes32[] }");
  return proof.map((item) => {
    if (typeof item !== "string" || !isHex(item) || item.length !== 66) {
      throw new Error("proof item is not bytes32");
    }
    return item;
  });
}
