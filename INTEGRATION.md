# Extension Integration Guide

How to build a GSD2 provider extension using `gsd-provider-api`. This covers the two-phase lifecycle (CLI install + session start), onboarding, and the extension entry point structure.

## Extension Lifecycle

A GSD2 extension runs in two separate contexts. They never overlap.

### Phase 1: CLI Install (`gsd install <source>`)

Runs outside of any session. No `ExtensionAPI` (`pi`), no TUI, no session context.

Your extension is loaded by the lifecycle hook system. You get a `LifecycleHookContext` with:
- `ctx.log()`, `ctx.warn()`, `ctx.error()` — plain text terminal output
- `ctx.source` — the install source string
- `ctx.installedPath` — where the package was installed on disk
- `ctx.scope` — `"user"` or `"project"`
- `ctx.cwd` — current working directory
- `ctx.interactive` — whether the terminal is a TTY

**Use this phase for:** verifying external dependencies are installed and authenticated. Things that don't require Pi or GSD — just the user's system.

**Do NOT use this phase for:** registering providers, setting default models, anything that needs `pi` or `SettingsManager`.

### Phase 2: Session Start (`gsd` launches)

Your extension's factory function receives `ExtensionAPI` (`pi`). Full access to provider registration, tool registration, event hooks, model selection, settings, auth storage, TUI.

**Use this phase for:** registering providers via `wireProvidersToPI(pi)`, running onboarding flows that need `pi`/`SettingsManager`/`AuthStorage`, setting up event handlers.

## Extension Entry Point Structure

A complete extension has a single entry point that handles both phases:

```typescript
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import { registerProviderInfo, wireProvidersToPI } from "@thereaperjay/gsd-provider-api";
import type { GsdProviderInfo } from "@thereaperjay/gsd-provider-api";

// ─── Provider Definition ────────────────────────────────────────────────────

const provider: GsdProviderInfo = {
  id: "my-provider",
  displayName: "My Provider",
  authMode: "externalCli",
  models: [
    {
      id: "my-provider:default-model",
      displayName: "Default Model",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  isReady: () => {
    // Called by Pi's isProviderRequestReady() before auth checks.
    // Return false if the provider cannot serve requests right now.
    const result = spawnSync("my-cli", ["auth", "status"], { encoding: "utf-8", timeout: 3000 });
    return result.status === 0;
  },
  createStream: (context, deps) => {
    return (async function* () {
      // Your streaming implementation here.
      yield { type: "text_delta" as const, text: "Hello from my provider" };
      yield {
        type: "completion" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "stop",
      };
    })();
  },
};

registerProviderInfo(provider);

// ─── Phase 1: CLI Install Hooks ─────────────────────────────────────────────
// These run during `gsd install`, outside of any session.
// They receive LifecycleHookContext, NOT pi.

export function afterInstall(ctx: { log: (msg: string) => void; warn: (msg: string) => void }) {
  // Check external dependency
  const version = spawnSync("my-cli", ["--version"], { encoding: "utf-8" });
  if (version.status !== 0) {
    ctx.warn("my-cli is not installed. Install it: npm install -g my-cli");
    return;
  }
  ctx.log(`my-cli found: ${version.stdout.trim()}`);

  // Check auth
  const auth = spawnSync("my-cli", ["auth", "status"], { encoding: "utf-8" });
  if (auth.status !== 0) {
    ctx.warn("my-cli is not authenticated. Run: my-cli auth login");
    return;
  }
  ctx.log("my-cli authenticated.");
}

// ─── Phase 2: Session Start ─────────────────────────────────────────────────
// This runs when GSD launches and loads the extension.
// It receives the full ExtensionAPI (pi).

export default async function activate(pi: ExtensionAPI) {
  await wireProvidersToPI(pi);
}
```

## Onboarding

`gsd-provider-api` provides `runPluginOnboarding()` as a session-time helper. It has two modes:

### Default behavior (no custom `onboard` function)

If your `GsdProviderInfo` does not set `onboard`, the default runs at session start:
- Logs that the extension was installed
- If models are declared, hints to the user about `/provider` for switching

It does **not** check auth, run spinners, or change the default model. Those are either handled at install time (Phase 1) or by a custom `onboard` function.

### Custom onboarding (set `onboard` on your provider)

For providers that need session-time setup (interactive prompts, model selection, auth storage), set `onboard` on your `GsdProviderInfo`:

```typescript
const provider: GsdProviderInfo = {
  id: "my-provider",
  displayName: "My Provider",
  authMode: "externalCli",
  models: [...],
  createStream: ...,

  // Custom onboarding — runs at session start with full clack/pico/authStorage access.
  // Return true if onboarding succeeded, false if it failed.
  onboard: async (clack, pico, authStorage) => {
    const p = clack as typeof import("@clack/prompts");
    const pc = pico as { green: (s: string) => string; dim: (s: string) => string };

    // Example: check auth with a spinner
    const s = p.spinner();
    s.start("Checking my-cli authentication...");
    const result = spawnSync("my-cli", ["auth", "status"], { encoding: "utf-8" });
    if (result.status !== 0) {
      s.stop("Not authenticated.");
      p.log.warn("Run: my-cli auth login");
      return false;
    }
    s.stop(`${pc.green("Authenticated")} as ${result.stdout.trim()}`);

    // Example: ask to set default model
    const setDefault = await p.confirm({
      message: "Set My Provider as the default?",
    });
    if (setDefault && !p.isCancel(setDefault)) {
      // Use pi (captured in closure) or settingsManager to set default
    }

    return true;
  },
};
```

## What Goes Where

| Concern | Phase | Context Available | Example |
|---|---|---|---|
| CLI installed? | Install (`afterInstall`) | `LifecycleHookContext` | `spawnSync("claude", ["--version"])` |
| CLI authenticated? | Install (`afterInstall`) | `LifecycleHookContext` | `spawnSync("claude", ["auth", "status"])` |
| Runtime dependencies met? | Install (`afterInstall`) | `LifecycleHookContext` | Check binaries, Python packages, etc. |
| Register provider with Pi | Session (factory) | `ExtensionAPI` | `wireProvidersToPI(pi)` |
| Set default model | Session (`onboard`) | clack, pico, AuthStorage | `settingsManager.setDefaultModelAndProvider()` |
| Interactive auth prompts | Session (`onboard`) | clack, pico, AuthStorage | `p.confirm()`, `p.text()`, etc. |
| Stream translation | Session (runtime) | `GsdStreamContext`, `GsdProviderDeps` | `createStream()` yields `GsdEvent` |
| Readiness check | Session (runtime) | None (pure function) | `isReady: () => boolean` |

## Install Flow (What Happens When)

```
User runs: gsd install https://github.com/user/my-provider-extension

  1. gsd resolves source, downloads/clones the package
  2. loadExtensions() loads entry points, collects lifecycle hooks
  3. afterInstall hook runs → your checks (CLI installed? authenticated?)
  4. extension-manifest.json runtime deps verified (if declared)
  5. Extension is persisted to settings

User runs: gsd

  1. createAgentSession() loads extensions
  2. Your factory function runs: export default function(pi) { ... }
  3. registerProviderInfo() registers your provider info (if not already via info.ts)
  4. wireProvidersToPI(pi) translates and registers with Pi
  5. runPluginOnboarding() runs (default message or custom onboard)
  6. Provider is live — Pi can route requests to it
```
