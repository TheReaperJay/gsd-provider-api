# gsd-provider-api

Standalone provider bridge library for GSD-compatible provider extensions.

This package is intentionally external to GSD core. Provider extensions depend on it directly.

## Why this exists

`gsd-provider-api` solves three integration problems once, in one place:

1. **Stable provider contract**
   Extensions implement `GsdProviderInfo` + `createStream(...)` without importing GSD internals.
2. **Event model translation**
   It translates provider-native stream events (`GsdEvent`) into Pi's `AssistantMessageEventStream`.
3. **Runtime bridge for orchestration context**
   It exposes a minimal runtime handoff so GSD can provide supervision/tool context to external providers.

This keeps provider logic reusable and keeps GSD core edits small.

## What it provides

- Provider info registry
  - `registerProviderInfo`, `getRegisteredProviderInfos`
- Runtime dependency bridge
  - `setProviderDeps`, `getProviderDeps`, `waitForProviderDeps`
- Shared tool registry
  - `registerGsdTool`, `replaceGsdTools`, `clearGsdTools`, `getGsdTools`
- Pi adapter
  - `wireProvidersToPI` (stream translation + provider registration)
- Local provider discovery
  - `discoverLocalProviders`
- Optional onboarding helper
  - `runPluginOnboarding`

## Auth model (directly aligned with core)

Provider definitions use core-aligned `authMode` directly:

- `apiKey`
- `oauth`
- `externalCli`
- `none`

No legacy auth-shape mapping is required.

## How it works at runtime

`provider-api` uses process-global symbols so runtime state can be shared across module boundaries:

- `Symbol.for("gsd-provider-registry")`
- `Symbol.for("gsd-provider-deps")`
- `Symbol.for("gsd-tool-registry")`

That allows:

- GSD extension bootstrap to publish deps/tools once
- External provider extensions (loaded independently) to consume the same state
- No direct compile-time coupling between provider package and GSD internals

## Minimal GSD wiring contract

GSD does **not** install this package globally. Instead, each provider extension depends on it.

GSD only needs to publish runtime values:

1. `setProviderDeps(...)` once per active runtime context
2. `replaceGsdTools([...])` when the available tool set changes
3. `discoverLocalProviders(...)` for side-effect registration (`info.ts`)
4. `wireProvidersToPI(pi)` to register discovered providers

In current integration, GSD may satisfy this contract either by importing these APIs directly or by publishing equivalent symbol payloads using the same keys.

## Provider extension usage

Typical extension pattern:

1. In `info.ts`, call `registerProviderInfo(...)`
2. Define models and `createStream(context, deps)`
3. Use `authMode: "externalCli"` (or other core mode as needed)
4. In extension entrypoint, call `wireProvidersToPI(pi)`

## Install

```bash
npm install @thereaperjay/gsd-provider-api
```

## Development

```bash
npm install
npm run typecheck
npm run build
```

## Design rationale

Keeping this package external gives you:

- independent release/versioning from GSD core
- shared logic across multiple provider extensions
- lower-risk core changes (bridge contract only)
- cleaner separation of concerns (core orchestration vs provider implementation)
