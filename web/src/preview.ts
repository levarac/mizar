import eligible from "./fixtures/evaluator/eligible.json";
import paramsBytes from "./fixtures/params.json?raw";
import deployment from "../public/claim-config.json";
import { groupAddress } from "./codec";
import { getAddress } from "viem";
import {
  parseRuleConfig,
  renderRules,
  showRuleError,
  verifyParameters,
} from "./rule-card";
import {
  setPurpose,
  setStateHeading,
  showState,
  showTransaction,
  type ClaimView,
} from "./presentation";

const states: Array<[ClaimView | "params-unverified", string]> = [
  ["unconfigured", "No configuration"],
  ["params-unverified", "Parameters unverified"],
  ["idle", "Start a claim"],
  ["lookup", "Eligibility lookup"],
  ["not-eligible", "Not eligible"],
  ["recipient", "Eligible · recipient"],
  ["signature", "Waiting for app signature"],
  ["ready", "Ready to submit"],
  ["submitting", "Submitting transaction"],
  ["submitted", "Transaction submitted"],
  ["claimed", "Claimed"],
  ["already-claimed", "Already claimed"],
  ["error", "Error"],
];
export function startPreview(): void {
  const bar = document.createElement("div");
  bar.id = "preview-bar";
  bar.innerHTML =
    '<strong>Preview: fixture data</strong><label for="preview-state">View state</label><select id="preview-state"></select>';
  document.body.prepend(bar);
  const config = parseRuleConfig(deployment);
  const params = verifyParameters(
    new TextEncoder().encode(paramsBytes),
    config,
  );
  const select = document.querySelector<HTMLSelectElement>("#preview-state")!;
  for (const [value, label] of states) select.add(new Option(label, value));
  let recipient = getAddress(eligible.addresses[1]);
  const key = getAddress(eligible.addresses[0]);
  const input = document.querySelector<HTMLInputElement>("#recipient")!;
  const grouped = document.querySelector<HTMLElement>("#recipient-grouped")!;
  const change = (state: string) => {
    const selected =
      states.find(([value]) => value === state)?.[0] ?? "recipient";
    select.value = selected;
    history.replaceState(null, "", `?state=${selected}`);
    renderRules(params, config);
    if (["unconfigured", "params-unverified"].includes(selected))
      showRuleError();
    showState(selected === "params-unverified" ? "unconfigured" : selected);
    if (selected === "params-unverified") {
      setStateHeading(
        "Check the published parameters.",
        "published parameters.",
      );
      document.querySelector("#state-status")!.textContent =
        "The parameters could not be verified; ask the event organizer for the correct file and try again.";
    }
    const hasKey = !["idle", "unconfigured", "params-unverified"].includes(
      selected,
    );
    document.querySelector("#event-key")!.textContent = hasKey
      ? groupAddress(key)
      : "Available after the app responds.";
    document.querySelector("#eligibility")!.textContent =
      selected === "lookup"
        ? "Checking the published list…"
        : selected === "not-eligible"
          ? "Not in the published eligible list."
          : hasKey
            ? `${eligible.explanations[0].partners.length} distinct partners in the published eligible list.`
            : "Not checked yet.";
    const signed = [
      "ready",
      "submitting",
      "submitted",
      "claimed",
      "already-claimed",
    ].includes(selected);
    document.querySelector("#signature")!.textContent = signed
      ? "App signature received for this recipient."
      : "No app signature yet.";
    input.value = recipient;
    grouped.textContent = groupAddress(recipient);
    document.querySelector<HTMLButtonElement>("#submit")!.disabled =
      selected === "submitting";
    showTransaction(`0x${"ab".repeat(32)}`);
    setPurpose(config.eventId);
  };
  select.addEventListener("change", () => change(select.value));
  input.addEventListener("input", () => {
    try {
      recipient = getAddress(input.value.trim());
      grouped.textContent = groupAddress(recipient);
    } catch {
      grouped.textContent = "Enter a complete wallet address.";
    }
  });
  // Preview controls only change presentation; no signing, wallet or network calls.
  document
    .querySelector("#sign")!
    .addEventListener("click", () => change("signature"));
  document
    .querySelector("#submit")!
    .addEventListener("click", () => change("submitting"));
  document
    .querySelector("#transaction-link")!
    .addEventListener("click", (event) => event.preventDefault());
  change(new URLSearchParams(location.search).get("state") ?? "recipient");
}
