import deployment from "../public/claim-config.json";
import { parseDeploymentConfig } from "./deployment";
import { loadRules } from "./rule-card";
import { showState } from "./presentation";

if (import.meta.env.MODE === "preview") {
  void import("./preview").then(({ startPreview }) => startPreview());
} else {
  void loadRules(deployment);
  void startClaimPage();
}

async function startClaimPage(): Promise<void> {
  try {
    parseDeploymentConfig(deployment);
  } catch {
    showState("unconfigured");
    return;
  }
  try {
    await import("./main");
  } catch {
    showState(
      "error",
      "The claim page could not start; reload this page and try again.",
    );
    for (const id of ["sign", "recipient-section", "purpose"]) {
      document.getElementById(id)!.hidden = true;
    }
  }
}
