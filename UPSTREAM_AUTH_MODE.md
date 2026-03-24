# UPSTREAM_AUTH_MODE_SUPPORT

## What

`UPSTREAM_AUTH_MODE_SUPPORT` is a boolean flag in `src/adapter.ts` that controls how `wireProvidersToPI` registers providers with the vendored GSD2 Pi fork.

- **`false` (current)** — Uses a dummy API key workaround for providers that don't need credentials (`externalCli`, `none` auth modes).
- **`true`** — Passes `authMode` directly to `pi.registerProvider()`, using Pi's native auth mode support.

## Why This Exists

The vendored GSD2 fork of Pi only supports two auth modes natively: `apiKey` and `oauth`. Providers that don't fit those patterns — external CLI tools (`claude`, `ollama`), local models, SDK-based providers — get blocked at runtime.

Pi's internal code enforces credential requirements at 8 callsites across 5 files:

| File | What it blocks |
|---|---|
| `model-registry.ts` — `registerProvider()` | Throws if neither `apiKey` nor `oauth` is provided |
| `model-registry.ts` — `getAvailable()` | Filters out models where `authStorage.hasAuth()` is false |
| `agent-session.ts` — `setModel()`, model validation, model cycling (6 callsites) | Rejects models without API keys |
| `compaction-orchestrator.ts` (2 callsites) | Refuses to compact without an API key |
| `fallback-resolver.ts` | Skips providers without auth for fallback |

None of these are accessible from the extension API. You cannot override them from a Pi extension.

## The Proper Fix (Pending PR)

A PR has been submitted to the GSD2 fork that adds `authMode` to `ProviderConfig` and introduces `isProviderRequestReady()` — a method that returns `true` for `externalCli`/`none` providers without checking for credentials. All 8 blocking callsites are updated to use readiness gating instead of key-presence gating.

- **Branch:** `feature/native-install-post-install-hooks`
- **Commit:** `0d5f36af` — `feat(core): complete authMode support for keyless providers`
- **Repo:** https://github.com/gsd-build/gsd-2

Zero behavioral change for existing `apiKey`/`oauth` providers.

## The Temporary Workaround

Until the PR is merged, `UPSTREAM_AUTH_MODE_SUPPORT = false` activates a workaround:

For providers with `authMode: "externalCli"` or `authMode: "none"`, the adapter passes `apiKey: "GSD_PROVIDER_KEYLESS"` to `pi.registerProvider()` instead of the real auth config.

This works because:

1. **Registration** — Pi sees `config.apiKey` as truthy, passes validation.
2. **`hasAuth()`** — The dummy key registers as a fallback resolver value, so `hasAuth()` returns `true`.
3. **`getApiKey()`** — Returns the literal string `"GSD_PROVIDER_KEYLESS"`.
4. **`streamSimple()`** — The provider's own stream function handles auth internally. The dummy key flows through Pi's pipeline harmlessly and is never sent to any external API.
5. **Compaction/summarization** — Receives the dummy key, passes it to `streamSimple`, which ignores it.

The dummy key tricks Pi into thinking the provider has credentials. The provider itself never uses it.

## How to Remove This

When the authMode PR is merged and a new version of `gsd-pi` is published:

1. In `src/adapter.ts`, flip: `const UPSTREAM_AUTH_MODE_SUPPORT = true;`
2. Update `gsd-pi` devDependency to the version that includes the PR.
3. The `UPSTREAM_AUTH_MODE_SUPPORT = true` path passes `authMode` directly and uses the provider's real `apiKey` field (or omits it for keyless providers).
4. Once confirmed working, delete the `false` branch, the `KEYLESS_PROVIDER_DUMMY_KEY` constant, and the `needsDummyKey()` function.
5. Delete this file.

## Why the PR Should Be Accepted

This workaround exists because Pi's auth system conflates "does this provider have credentials" with "is this provider ready to serve requests." These are not the same thing. A provider that authenticates via an external CLI is ready the moment the CLI is installed — it doesn't need Pi to hold a key for it.

The PR separates these two concerns with a single method (`isProviderRequestReady`) and a single field (`authMode`). It's 158 lines added, 54 removed, zero behavioral change for existing providers, and it unblocks an entire category of provider integrations that Pi currently cannot support.

The existence of this workaround — a dummy key injected to fool the auth system — is evidence that the abstraction is wrong. The fix is small and clean. The workaround is not.
