import deployment from "../public/claim-config.json";
import { parseDeploymentConfig } from "./deployment";

export type { ClaimPageConfig } from "./deployment";

const config = parseDeploymentConfig(deployment);
export const claimPageConfig = {
  ...config,
  eligibleJsonUrl: new URL(config.eligibleJsonUrl, window.location.origin).href,
};
