import { getAddress, type Address, type Hex } from "viem";

const STORAGE_KEY = "mizar.claim.v1";

export type Pending = {
  state: string;
  recipient: Address;
};

export type StoredClaim = {
  recipient: Address;
  eventKeyAddress: Address;
  signature: Hex;
  compressedKey: Hex;
};

export type Session = {
  eventKeyAddress?: Address;
  pending?: Pending;
  claim?: StoredClaim;
};

export function loadSession(): Session {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Session;
    if (parsed.pending && "phase" in parsed.pending) return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/** Drop a stored claim that belongs to a different event key or recipient. */
export function clearClaimIfDifferent(
  session: Session,
  incoming: { eventKeyAddress?: Address; recipient?: Address },
): Session {
  if (!session.claim) return session;
  const keyDiffers = incoming.eventKeyAddress !== undefined && session.claim.eventKeyAddress !== getAddress(incoming.eventKeyAddress);
  const recipientDiffers = incoming.recipient !== undefined && session.claim.recipient !== getAddress(incoming.recipient);
  if (!keyDiffers && !recipientDiffers) return session;
  return { ...session, claim: undefined, eventKeyAddress: undefined };
}
