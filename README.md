# gsd-provider-api

Provider bridge for GSD2. Lets you build provider extensions that use auth models and source types the vendored GSD2 fork of Pi doesn't natively support.

## The Problem

GSD2 uses a vendored fork of Pi as its AI provider system. That fork only supports two auth modes natively: `apiKey` and `oauth`. If your provider doesn't authenticate with one of those two patterns — a CLI tool like `claude` or `ollama`, a local model with no auth, an SDK that manages its own credentials — you're stuck. The vendored Pi fork has no mechanism for it, and GSD core doesn't patch around it.

This package fills that gap.

## What This Package Does

`gsd-provider-api` is an external bridge library that sits between your provider extension and the vendored GSD2 Pi fork. It:

1. **Extends the auth model.** Adds `externalCli` and `none` auth modes on top of Pi's `apiKey` and `oauth`. Your provider declares which mode it uses, and the bridge handles the rest.

2. **Defines a stable provider contract.** You implement `GsdProviderInfo` — a single interface that describes your provider's identity, models, auth mode, and a `createStream()` function. That's the entire surface area you need to touch.

3. **Translates your stream into Pi's event format.** Your `createStream()` yields simple `GsdEvent` objects (`text_delta`, `thinking_delta`, `tool_start`, `tool_end`, `completion`, `error`). The adapter converts these into Pi's `AssistantMessageEventStream` so the vendored fork's orchestration layer consumes them like any native provider.

4. **Shares runtime state without compile-time coupling.** GSD orchestration publishes supervisor config, tool definitions, and context callbacks via process-global symbols. Your provider consumes them through this package's registry APIs. No direct imports from GSD internals.

## Architecture

```
┌─────────────────────────┐
│  Your Provider Extension │
│                         │
│  implements:            │
│    GsdProviderInfo      │
│    createStream()       │
│    → yields GsdEvent    │
└────────┬────────────────┘
         │
         │  registerProviderInfo()
         │
┌────────▼────────────────┐
│  gsd-provider-api       │
│                         │
│  Provider Registry      │  ← process-global Symbol store
│  Tool Registry          │  ← shared tool defs from GSD
│  Deps Registry          │  ← supervisor config, callbacks
│  Pi Adapter             │  ← GsdEvent → Pi stream translation
│  Local Discovery        │  ← auto-loads info.ts files
│  Onboarding             │  ← default or custom onboarding
└────────┬────────────────┘
         │
         │  wireProvidersToPI(pi)
         │
┌────────▼────────────────┐
│  Vendored GSD2 Pi Fork  │
│                         │
│  pi.registerProvider()  │
│  AssistantMessageEvent  │
│  Stream                 │
└─────────────────────────┘
```

## Building a Provider Extension

### 1. Install the package

```bash
npm install @thereaperjay/gsd-provider-api
```

Your extension also needs `@gsd/pi-ai` and `@gsd/pi-coding-agent` as peer dependencies (these come from the vendored GSD2 Pi fork).

### 2. Create your provider info (`info.ts`)

This file self-registers your provider as a side effect of being imported. The local discovery system picks it up automatically.

```typescript
import { registerProviderInfo } from "@thereaperjay/gsd-provider-api";
import type {
  GsdProviderInfo,
  GsdStreamContext,
  GsdProviderDeps,
  GsdEventStream,
} from "@thereaperjay/gsd-provider-api";

function createStream(context: GsdStreamContext, deps: GsdProviderDeps): GsdEventStream {
  return (async function* () {
    // Call your provider's API, SDK, CLI, local model — whatever you need.
    const response = await callYourProvider(context.modelId, context.userPrompt);

    // Yield GsdEvent objects. The adapter handles Pi translation.
    yield { type: "text_delta" as const, text: response.text };

    yield {
      type: "completion" as const,
      usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens },
      stopReason: "stop",
    };
  })();
}

const provider: GsdProviderInfo = {
  id: "my-provider",
  displayName: "My Provider",
  authMode: "externalCli",  // or "apiKey", "oauth", "none"
  models: [
    {
      id: "my-provider:my-model",
      displayName: "My Model",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
    },
  ],
  createStream,
};

registerProviderInfo(provider);
```

### 3. Wire it to Pi (extension entrypoint)

```typescript
import { wireProvidersToPI } from "@thereaperjay/gsd-provider-api";
import "./info.js"; // side-effect: registers the provider

export async function activate(pi: ExtensionAPI) {
  await wireProvidersToPI(pi);
}
```

That's it. GSD discovers your extension, imports your `info.ts`, and `wireProvidersToPI` translates your `GsdEvent` stream into Pi's native format.

### 4. Provider directory structure

Place your provider in one of these locations (scanned in order, last write wins on ID conflict):

| Location | Scope |
|---|---|
| `~/.gsd/agent/extensions/<name>/` | Bundled/installed extensions |
| `~/.gsd/providers/<name>/` | Global providers |
| `<project>/.gsd/providers/<name>/` | Project-local (overrides global) |

Each directory must contain an `info.ts` or `info.js` that calls `registerProviderInfo()` on import.

## GsdEvent Types

Your `createStream()` yields these events:

| Event | Fields | Purpose |
|---|---|---|
| `text_delta` | `text: string` | Streamed text output |
| `thinking_delta` | `thinking: string` | Streamed reasoning/thinking output |
| `tool_start` | `toolCallId`, `toolName`, `detail?` | Tool execution started (shown in TUI status) |
| `tool_end` | `toolCallId` | Tool execution finished (clears TUI status) |
| `completion` | `usage: GsdUsage`, `stopReason: string` | Stream finished successfully |
| `error` | `message`, `category`, `retryAfterMs?` | Stream failed. Categories: `rate_limit`, `auth`, `timeout`, `unknown` |

## Auth Modes

| Mode | Use Case |
|---|---|
| `apiKey` | Provider authenticates with an API key (native Pi support) |
| `oauth` | Provider authenticates via OAuth flow (native Pi support) |
| `externalCli` | Provider delegates auth to an external CLI tool (e.g., `claude`, `gcloud`) |
| `none` | No authentication required (local models, open APIs) |

For `externalCli` providers, you can declare an `onboarding` field with a `check()` function that verifies the CLI is installed and authenticated:

```typescript
const provider: GsdProviderInfo = {
  // ...
  authMode: "externalCli",
  onboarding: {
    kind: "externalCli",
    hint: "Run `my-cli auth login` to authenticate",
    check: (spawnFn) => {
      const result = (spawnFn ?? spawnSync)("my-cli", ["auth", "status"]);
      if (result.status === 0) return { ok: true, email: "user@example.com" };
      return { ok: false, reason: "Not authenticated", instruction: "Run: my-cli auth login" };
    },
  },
};
```

## API Reference

### Provider Registry

| Function | Description |
|---|---|
| `registerProviderInfo(info)` | Register or replace a provider by ID |
| `getRegisteredProviderInfos()` | Get all registered providers |
| `removeProviderInfo(id)` | Remove a provider by ID |
| `clearRegisteredProviderInfos()` | Remove all providers |

### Runtime Deps

GSD orchestration publishes these once per active runtime context. Your provider receives them as the second argument to `createStream()`.

| Function | Description |
|---|---|
| `setProviderDeps(deps)` | Publish runtime deps (called by GSD core) |
| `getProviderDeps()` | Get current deps (or `null` if not yet set) |
| `waitForProviderDeps(timeoutMs?)` | Async wait for deps to be published (default 3s timeout) |
| `clearProviderDeps()` | Clear deps |

`GsdProviderDeps` gives your provider access to supervisor config, context-write blocking, milestone tracking, tool lifecycle hooks, and unit info — all without importing GSD internals.

### Tool Registry

GSD publishes available tools here. Providers can read them to expose tools to their underlying model.

| Function | Description |
|---|---|
| `registerGsdTool(def)` | Register a single tool |
| `replaceGsdTools(defs)` | Replace all tools atomically |
| `getGsdTools()` | Get current tool definitions |
| `clearGsdTools()` | Clear all tools |
| `defineGsdTool(name, desc, schema, execute)` | Type-safe tool definition helper (infers arg types from Zod schema) |

### Pi Adapter

| Function | Description |
|---|---|
| `wireProvidersToPI(pi)` | Registers all discovered providers with the vendored Pi fork. Translates `GsdEvent` streams to `AssistantMessageEventStream`. |

### Local Discovery

| Function | Description |
|---|---|
| `discoverLocalProviders(projectRoot?)` | Scans extension/provider directories for `info.ts`/`info.js` files and imports them. Returns list of loaded provider directory names. |

### Onboarding

| Function | Description |
|---|---|
| `runPluginOnboarding(provider)` | Self-contained onboarding. If `onboard()` is set on the provider, it runs with clack/pico passed from the library. If `onboarding.kind === "externalCli"`, runs spinner + `check()`. Otherwise logs a generic install message. Returns `{ ok: boolean }`. The library owns `@clack/prompts` and `picocolors` — extensions do not need to install them. |

See [INTEGRATION.md](./INTEGRATION.md) for the full two-phase lifecycle (CLI install + session start) and how to structure your extension's onboarding.

## Runtime Internals

State is shared across module boundaries via process-global symbols:

- `Symbol.for("gsd-provider-registry")` — registered `GsdProviderInfo` entries
- `Symbol.for("gsd-provider-deps")` — runtime deps from GSD orchestration
- `Symbol.for("gsd-tool-registry")` — shared tool definitions

This means your extension doesn't need a compile-time dependency on GSD core. GSD publishes state to these symbols, your extension reads from them through this package's APIs, and everything shares the same process-global store.

## Development

```bash
npm install
npm run typecheck
npm run build
```
