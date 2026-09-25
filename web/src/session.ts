import type { Address, Hex } from "viem";

const STORAGE_KEY = "mizar.claim.v1";

export type Pending =
  | { phase: "key"; state: string; nonce: Hex }
  | { phase: "claim"; state: string; recipient: Address; eventKeyAddress: Address };

export type Session = {
  eventKeyAddress?: Address;
  pending?: Pending;
  claim?: {
    recipient: Address;
    eventKeyAddress: Address;
    signature: Hex;
    compressedKey: Hex;
  };
};

export function loadSession(): Session {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return {};
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}
