import { getAddress, type Address, type Hex } from "viem";

/**
 * Example configuration only. Every value is a placeholder.
 * Replace them for a real event; do not deploy from these defaults.
 */
export const claimPageConfig = {
  chainId: 1,
  chainName: "Example Chain",
  rpcUrl: "http://127.0.0.1:8545",
  claimContract: getAddress("0x0000000000000000000000000000000000000001"),
  eventId: `0x${"11".repeat(32)}` as Hex,
  eligibleJsonUrl: "https://example.invalid/eligible.json",
  snapshotId: 0,
} as const;

export type ClaimPageConfig = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  claimContract: Address;
  eventId: Hex;
  eligibleJsonUrl: string;
  snapshotId: number;
};
