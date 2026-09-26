import {
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  isAddress,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  acceptClaimCallback,
  callbackError,
  claimAbi,
  claimAppLink,
  groupAddress,
  parseCallbackFragment,
} from "./codec";
import { claimPageConfig } from "./config";
import {
  assertProofRoot,
  findEligible,
  parseEligibleFile,
  parseProofFile,
  proofsUrlFor,
  type EligibleKey,
  type ProofFile,
} from "./eligibility";
import { clearClaimIfDifferent, loadSession, saveSession, type Session } from "./session";

const statusEl = document.querySelector<HTMLElement>("#status")!;
const eventKeyEl = document.querySelector<HTMLElement>("#event-key")!;
const eligibilityEl = document.querySelector<HTMLElement>("#eligibility")!;
const recipientInput = document.querySelector<HTMLInputElement>("#recipient")!;
const recipientGrouped = document.querySelector<HTMLElement>("#recipient-grouped")!;
const signButton = document.querySelector<HTMLButtonElement>("#sign")!;
const submitButton = document.querySelector<HTMLButtonElement>("#submit")!;
const signatureEl = document.querySelector<HTMLElement>("#signature")!;
document.querySelector<HTMLElement>("#deployment")!.textContent = JSON.stringify(claimPageConfig, null, 2);

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

function describeEligibility(eligible: EligibleKey): string {
  if (eligible.partners.length === 0) return "Eligible. No partners are listed.";
  const partners = eligible.partners
    .map((partner) => `${groupAddress(partner.address)} (windows ${partner.windows.join(", ") || "none"})`)
    .join("; ");
  return `Eligible. Partners: ${partners}.`;
}

function render(session: Session, eligible?: EligibleKey | null): void {
  eventKeyEl.textContent = session.eventKeyAddress
    ? groupAddress(session.eventKeyAddress)
    : "Waiting for the app callback.";
  if (!session.eventKeyAddress) {
    eligibilityEl.textContent = "Waiting for the app callback.";
  } else if (eligible === undefined) {
    eligibilityEl.textContent = "Checking the published list.";
  } else if (eligible === null) {
    eligibilityEl.textContent = "This event key is not in the published eligible list.";
  } else {
    eligibilityEl.textContent = describeEligibility(eligible);
  }
  signatureEl.textContent = session.claim
    ? `Signature stored for ${groupAddress(session.claim.recipient)}.`
    : "No claim signature yet.";
  submitButton.disabled = !session.claim || eligible === null;
}

function readRecipient(): Address | null {
  const value = recipientInput.value.trim();
  if (!isAddress(value)) return null;
  const address = getAddress(value);
  if (address === zeroAddress) return null;
  return address;
}

function showRecipient(): void {
  const value = recipientInput.value.trim();
  if (isAddress(value) && getAddress(value) === zeroAddress) {
    recipientGrouped.textContent = "";
    setStatus("The recipient cannot be the zero address.", true);
    return;
  }
  const recipient = readRecipient();
  recipientGrouped.textContent = recipient ? groupAddress(recipient) : "";
}

async function loadEligibility(address: Address): Promise<EligibleKey | null> {
  const response = await fetch(claimPageConfig.eligibleJsonUrl);
  if (!response.ok) throw new Error(`eligible.json returned ${response.status}`);
  const file = parseEligibleFile(await response.json());
  const found = findEligible(file, address);
  return found ?? null;
}

async function loadProof(address: Address): Promise<ProofFile> {
  const response = await fetch(proofsUrlFor(claimPageConfig.eligibleJsonUrl, address));
  if (!response.ok) throw new Error(`proof file returned ${response.status}`);
  return parseProofFile(await response.json());
}

signButton.addEventListener("click", () => {
  const value = recipientInput.value.trim();
  if (isAddress(value) && getAddress(value) === zeroAddress) {
    setStatus("The recipient cannot be the zero address.", true);
    return;
  }
  const recipient = readRecipient();
  if (!recipient) {
    setStatus("Enter a recipient address first.", true);
    return;
  }
  const state = randomHex(16);
  const session = clearClaimIfDifferent(loadSession(), { recipient });
  saveSession({ ...session, pending: { state, recipient } });
  window.location.assign(
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
    const eligible = await loadEligibility(claim.eventKeyAddress);
    if (!eligible) {
      setStatus("This event key is not in the published eligible list.", true);
      return;
    }
    const proofFile = await loadProof(claim.eventKeyAddress);
    assertProofRoot(proofFile, claimPageConfig.expectedRoot);
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
        proofFile.proof,
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
  const hash = window.location.hash;
  if (callbackError(hash) === "cancelled") {
    setStatus("The app cancelled the signature.", true);
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } else if (hash.includes("sig=")) {
    try {
      const callback = parseCallbackFragment(hash);
      if (!session.pending) throw new Error("No pending app request is stored in this browser.");
      const accepted = await acceptClaimCallback({
        fragment: callback,
        expectedState: session.pending.state,
        eventId: claimPageConfig.eventId,
        chainId: BigInt(claimPageConfig.chainId),
        claimContract: claimPageConfig.claimContract,
        recipient: session.pending.recipient,
      });
      session = {
        eventKeyAddress: accepted.eventKeyAddress,
        pending: undefined,
        claim: {
          recipient: session.pending.recipient,
          eventKeyAddress: accepted.eventKeyAddress,
          signature: accepted.signature,
          compressedKey: accepted.compressedKey,
        },
      };
      saveSession(session);
      history.replaceState(null, "", window.location.pathname + window.location.search);
      setStatus("App callback accepted.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Callback rejected.", true);
    }
  }

  render(session);
  if (session.eventKeyAddress) {
    try {
      const eligible = await loadEligibility(session.eventKeyAddress);
      render(session, eligible);
    } catch (error) {
      eligibilityEl.textContent = error instanceof Error ? error.message : "Could not read eligible.json.";
      submitButton.disabled = true;
    }
  }
  if (session.claim) {
    recipientInput.value = session.claim.recipient;
    showRecipient();
  }
}

void boot();
