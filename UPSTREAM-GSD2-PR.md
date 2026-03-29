# Upstream PR Required (`gsd-build/gsd-2`)

This refactor intentionally does **not** edit `gsd-2` directly.

## Why an upstream PR is needed

`gsd-provider-api` now emits canonical tool events (`tool_call_*`, `tool_result`) and attaches tool execution results to tool-call blocks.  
To render those results correctly in external-CLI mode, `gsd-2` needs a small upstream change in external tool execution handling.

## Required upstream changes

1. In `packages/pi-agent-core/src/agent-loop.ts`, external tool execution path should:
   - stop hardcoding `"(executed by Claude Code)"`,
   - consume provider-supplied external tool result payload when present,
   - fallback to `"(executed by external provider)"` when absent.

2. Keep behavior provider-agnostic for all `externalCli` providers (`codex`, `claude`, `gemini`, etc.).

## PR status

- Local `gsd-2` codebase was **not modified** for this implementation wave.
- This file is the tracked reminder/dependency until the upstream PR is opened and merged.
