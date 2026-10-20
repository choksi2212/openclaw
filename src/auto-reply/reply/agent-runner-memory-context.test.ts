import { expect, it } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import { resolveFollowupContextTokens } from "./agent-runner-memory-runtime.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";

const provider = "fixture-maintenance";
const model = "maintenance-model";
const window = { id: "small", label: "Small", contextWindow: 200_000 };
const catalogModel = {
  provider,
  id: model,
  contextTokens: 872_000,
  contextWindows: [window],
};
function resolveBudget(
  thinkingCatalog: NonNullable<Parameters<typeof createTestFollowupRun>[0]>["thinkingCatalog"],
  options: Omit<
    Parameters<typeof resolveFollowupContextTokens>[0],
    "followupRun" | "defaultModel"
  > = {
    cfg: {},
  },
  cap?: number,
) {
  const followupRun = createTestFollowupRun({ provider, model, thinkingCatalog });
  const cfg = withTestModelContextTokens({
    cfg: options.cfg,
    followupRun,
    defaultModel: model,
    contextTokens: cap,
  });
  return resolveFollowupContextTokens(
    { followupRun, defaultModel: model, ...options, cfg },
    "openclaw",
  );
}

it.each([
  { name: "accepted prompt", selected: undefined, cap: undefined, expected: 872_000 },
  { name: "selected window", selected: "small", cap: undefined, expected: 200_000 },
  { name: "authored cap", selected: undefined, cap: 64_000, expected: 64_000 },
])("uses the $name budget for maintenance", ({ selected, cap, expected }) => {
  expect(
    resolveBudget(
      [{ ...catalogModel, contextWindow: 128_000, contextWindowSource: "synthetic" }],
      {
        cfg: {},
        sessionEntry: {
          sessionId: "session",
          updatedAt: 0,
          contextWindow: selected,
        },
      },
      cap,
    ),
  ).toBe(expected);
});

it("ignores a foreign runtime catalog and unqualified shared cache", () => {
  const caches = getContextWindowCaches();
  const key = providerContextTokenCacheKey(provider, model);
  const previous = caches.discoveredTokenCache.get(key);
  caches.discoveredTokenCache.set(key, 1_000_000);
  try {
    expect(
      resolveBudget([
        { provider, id: model, nativeRuntime: "codex", contextWindow: 1_000_000 },
        { provider, id: model, contextWindow: 200_000 },
      ]),
    ).toBe(200_000);
  } finally {
    if (previous === undefined) {
      caches.discoveredTokenCache.delete(key);
    } else {
      caches.discoveredTokenCache.set(key, previous);
    }
  }
});

it("keeps the admitted synthetic estimate when prompt capacity is unknown", () => {
  expect(
    resolveBudget([
      {
        provider,
        id: model,
        contextWindow: 128_000,
        contextWindowSource: "synthetic",
      },
    ]),
  ).toBe(128_000);
});

it("ignores a selected window from a different session", () => {
  expect(
    resolveBudget([catalogModel], {
      cfg: {},
      sessionEntry: { sessionId: "foreign-session", updatedAt: 0, contextWindow: "small" },
    }),
  ).toBe(872_000);
});
