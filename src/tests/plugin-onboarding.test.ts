import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatExternalCliAuthenticatedMessage } from "../plugin-onboarding.js";

describe("plugin onboarding message formatting", () => {
  it("keeps the exact fallback when metadata is missing", () => {
    const text = formatExternalCliAuthenticatedMessage("Codex CLI (Subscription)", { ok: true });
    assert.equal(text, "Codex CLI (Subscription) authenticated");
  });

  it("includes email when only email is available", () => {
    const text = formatExternalCliAuthenticatedMessage("Codex CLI (Subscription)", {
      ok: true,
      email: "user@example.com",
    });
    assert.equal(text, "Codex CLI (Subscription) authenticated as user@example.com");
  });

  it("includes subscription label when only subscription is available", () => {
    const text = formatExternalCliAuthenticatedMessage("Codex CLI (Subscription)", {
      ok: true,
      subscriptionLabel: "Codex Pro",
    });
    assert.equal(text, "Codex CLI (Subscription) authenticated (Codex Pro)");
  });

  it("includes both email and subscription label", () => {
    const text = formatExternalCliAuthenticatedMessage("Codex CLI (Subscription)", {
      ok: true,
      email: "user@example.com",
      subscriptionLabel: "Codex Pro",
    });
    assert.equal(text, "Codex CLI (Subscription) authenticated as user@example.com (Codex Pro)");
  });
});
