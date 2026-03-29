export type {
  ProviderAuthMode,
  GsdToolDef,
  GsdProviderDeps,
  GsdUsage,
  GsdToolResultPart,
  GsdToolResultPayload,
  GsdEvent,
  GsdEventStream,
  GsdModel,
  GsdStreamContext,
  CliCheckResult,
  GsdProviderOnboarding,
  GsdProviderOnboardingExternalCli,
  GsdProviderInfo,
  PluginLifecycleContext,
  PluginLifecycleHandler,
  PluginRuntimeState,
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

export { wireProvidersToPI, wireLifecycleHooks } from "./adapter.js";

export { discoverLocalProviders } from "./local-discovery.js";

export { runPluginOnboarding } from "./plugin-onboarding.js";

export { readPluginState, writePluginState } from "./plugin-state.js";
