export type {
  ProviderAuthMode,
  GsdToolDef,
  GsdProviderDeps,
  GsdUsage,
  GsdEvent,
  GsdEventStream,
  GsdModel,
  GsdStreamContext,
  CliCheckResult,
  GsdProviderOnboarding,
  GsdProviderOnboardingExternalCli,
  GsdProviderInfo,
} from "./types.js";

export {
  registerProviderInfo,
  getRegisteredProviderInfos,
  setProviderDeps,
  clearProviderDeps,
  getProviderDeps,
  waitForProviderDeps,
  removeProviderInfo,
  clearRegisteredProviderInfos,
} from "./provider-registry.js";

export {
  registerGsdTool,
  replaceGsdTools,
  clearGsdTools,
  getGsdTools,
} from "./tool-registry.js";

export { defineGsdTool } from "./define-tool.js";

export { wireProvidersToPI } from "./adapter.js";

export { discoverLocalProviders } from "./local-discovery.js";

export { runPluginOnboarding } from "./plugin-onboarding.js";
