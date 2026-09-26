import deployment from "../public/claim-config.json";
import { loadRules } from "./rule-card";
import { showState } from "./presentation";

if (import.meta.env.MODE === "preview") {
  void import("./preview").then(({ startPreview }) => startPreview());
} else {
  void loadRules(deployment);
  void import("./main").catch(() => showState("unconfigured"));
}
