import {
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  isAddress,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { claimAbi, claimAppLink, groupAddress, keyReadLink, parseCallbackFragment, assertCallbackState } from "./codec";
import { claimPageConfig } from "./config";
import { findEligible, parseEligibleFile, parseProofFile, proofsUrlFor, type EligibleKey } from "./eligibility";
import { loadSession, saveSession, type Session } from "./session";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const eventKeyEl = document.querySelector<HTMLElement>("#event-key")!;
const eligibilityEl = document.querySelector<HTMLElement>("#eligibility")!;
const recipientInput = document.querySelector<HTMLInputElement>("#recipient")!;
const recipientGrouped = document.querySelector<HTMLElement>("#recipient-grouped")!;
const readKeyButton = document.querySelector<HTMLButtonElement>("#read-key")!;
const signButton = document.querySelector<HTMLButtonElement>("#sign")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit")!;
const signatureEl = document.querySelector<HTMLElement>("#signature")!;

const chain = defineChain({
  id: claimPageConfig.chainId,
  name: claimPageConfig.chainName,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [claimPageConfig.rpcUrl] } },
});

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function randomHex(bytes: number): Hex {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
}

function render(session: Session, eligible?: EligibleKey | null): void {
  eventKeyEl.textContent = session.eventKeyAddress
    ? groupAddress(session.eventKeyAddress)
    : "Not read yet.";
  if (!session.eventKeyAddress) {
    eligibilityEl.textContent = "Waiting for an event key.";
  } else if (eligible === undefined) {
    eligibilityEl.textContent = "Checking the published list.";
  } else if (eligible === null) {
    eligibilityEl.textContent = "This event key is not in the published eligible list.";
  } else {
    const partners = eligible.partners.length === 0 ? "none listed" : eligible.partners.map(groupAddress).join(", ");
    const windows = eligible.windows.length === 0 ? "none listed" : eligible.windows.join(", ");
    eligibilityEl.textContent = `Eligible. Partners: ${partners}. Windows: ${windows}. A published explanation is not a live progress result.`;
  }
  signatureEl.textContent = session.claim
    ? `Signature stored for ${groupAddress(session.claim.recipient)}.`
    : "No claim signature yet.";
  signButton.disabled = !session.eventKeyAddress || eligible === undefined || eligible === null;
  submitButton.disabled = !session.claim;
}

function readRecipient(): Address | null {
  const value = recipientInput.value.trim();
  if (!isAddress(value)) return null;
  return getAddress(value);
}

function showRecipient(): void {
  const recipient = readRecipient();
  recipientGrouped.textContent = recipient ? groupAddress(recipient) : "";
}

async function loadEligibility(address: Address): Promise<EligibleKey | null> {
  const response = await fetch(claimPageConfig.eligibleJsonUrl);
  if (!response.ok) throw new Error(`eligible.json returned ${response.status}`);
  const file = parseEligibleFile(await response.json());
  return findEligible(file, address) ?? null;
}

async function loadProof(address: Address): Promise<Hex[]> {
  const response = await fetch(proofsUrlFor(claimPageConfig.eligibleJsonUrl, address));
  if (!response.ok) throw new Error(`proof file returned ${response.status}`);
  return parseProofFile(await response.json());
}

function openLink(url: string): void {
  window.location.assign(url);
}

readKeyButton.addEventListener("click", () => {
  const session = loadSession();
  const state = randomHex(16);
  const nonce = randomHex(32);
  saveSession({ ...session, pending: { phase: "key", state, nonce } });
  openLink(keyReadLink({ eventId: claimPageConfig.eventId, nonce, state }));
});

signButton.addEventListener("click", () => {
  const session = loadSession();
  const recipient = readRecipient();
  if (!session.eventKeyAddress || !recipient) {
    setStatus("Enter a recipient address first.", true);
    return;
  }
  const state = randomHex(16);
  saveSession({
    ...session,
    pending: { phase: "claim", state, recipient, eventKeyAddress: session.eventKeyAddress },
  });
  openLink(
    claimAppLink({
      eventId: claimPageConfig.eventId,
      chainId: BigInt(claimPageConfig.chainId),
      claimContract: claimPageConfig.claimContract,
      recipient,
      state,
    }),
  );
});

submitButton.addEventListener("click", async () => {
  const session = loadSession();
  const claim = session.claim;
  if (!claim) return;
  const ethereum = (window as Window & { ethereum?: { request: (args: unknown) => Promise<unknown> } }).ethereum;
  if (!ethereum) {
    setStatus("No injected wallet was found.", true);
    return;
  }
  try {
    const proof = await loadProof(claim.eventKeyAddress);
    const client = createWalletClient({ chain, transport: custom(ethereum) });
    const [account] = await client.requestAddresses();
    const hash = await client.writeContract({
      account,
      address: claimPageConfig.claimContract,
      abi: claimAbi,
      functionName: "claim",
      args: [
        BigInt(claimPageConfig.snapshotId),
        claim.eventKeyAddress,
        proof,
        claim.recipient,
        claim.signature,
      ],
    });
    setStatus(`Claim submitted: ${hash}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Claim submission failed.", true);
  }
});

recipientInput.addEventListener("input", showRecipient);

async function boot(): Promise<void> {
  let session = loadSession();
  if (window.location.hash.includes("sig=")) {
    try {
      const callback = parseCallbackFragment(window.location.hash);
      if (!session.pending) throw new Error("No pending app request is stored in this browser.");
      assertCallbackState(session.pending.state, callback);
      if (session.pending.phase === "key") {
        session = { ...session, eventKeyAddress: callback.a, pending: undefined };
      } else {
        session = {
          ...session,
          eventKeyAddress: session.pending.eventKeyAddress,
          pending: undefined,
          claim: {
            recipient: session.pending.recipient,
            eventKeyAddress: session.pending.eventKeyAddress,
            signature: callback.sig,
            compressedKey: callback.k,
          },
        };
      }
      saveSession(session);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setStatus("App callback accepted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Callback rejected.", true);
    }
  }

  let eligible: EligibleKey | null | undefined = session.eventKeyAddress ? undefined : undefined;
  render(session, session.eventKeyAddress ? undefined : undefined);
  if (session.eventKeyAddress) {
    try {
      eligible = await loadEligibility(session.eventKeyAddress);
      render(session, eligible);
    } catch (error) {
      eligibilityEl.textContent = error instanceof Error ? error.message : "Could not read eligible.json.";
      signButton.disabled = true;
    }
  }
  if (session.claim) {
    recipientInput.value = session.claim.recipient;
    showRecipient();
  }
}

void boot();
