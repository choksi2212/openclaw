import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, unknown>,
    loadExactSessionEntryReadOnly: vi.fn((scope: { sessionKey: string }) => {
      const entry = state.rows[scope.sessionKey];
      return entry ? { sessionKey: scope.sessionKey, entry } : undefined;
    }),
  };
  return state;
});

const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../config/sessions/session-entry-read-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-entry-read-runtime.js")>()),
  readSessionEntryReadOnlyInWorker: async (scope: { sessionKey: string }) =>
    store.loadExactSessionEntryReadOnly(scope)?.entry,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (_store: unknown, opts?: { agentId?: string }) =>
    `/tmp/${opts?.agentId ?? "main"}-sessions.sqlite`,
}));

vi.mock("../../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: () => [
    { agentId: "main", storePath: "/tmp/main-sessions.sqlite" },
    { agentId: "main", storePath: "/tmp/secondary-sessions.sqlite" },
  ],
}));

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: getChannelPluginMock,
}));

import { resolveEffectiveCurrentChannelContextForRequest } from "./message-tool-discovery.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

function resolveContext(sessionId?: string) {
  return resolveEffectiveCurrentChannelContextForRequest(
    { currentChannelProvider: "webchat", agentSessionKey: SESSION_KEY, sessionId },
    { config: {}, action: "send", params: {} },
  );
}

function expectReads(keys: string[]) {
  expect(store.loadExactSessionEntryReadOnly.mock.calls.map(([scope]) => scope.sessionKey)).toEqual(
    keys,
  );
}

describe("canonical destination recovery stays bounded", () => {
  beforeEach(() => {
    store.rows = {
      [SESSION_KEY]: {
        sessionId: "s1",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "googlechat", target: { to: `googlechat:${CANONICAL_SPACE}` } },
          context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
          origin: { provider: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
        },
      },
    };
    store.loadExactSessionEntryReadOnly.mockClear();
    getChannelPluginMock.mockReset();
    getChannelPluginMock.mockReturnValue({
      config: { listAccountIds: () => ["default"] },
      messaging: { targetIdComparison: "case-sensitive" },
    });
  });

  it("recovers the canonical casing without enumerating the store", async () => {
    expect(await resolveContext()).toMatchObject({
      currentChannelId: CANONICAL_SPACE,
      currentMessagingTarget: CANONICAL_SPACE,
    });
    expectReads([SESSION_KEY]);
  });

  it("does not recover delivery from a replacement session at the same key", async () => {
    const result = await resolveContext("previous-session");
    expect(result.currentMessagingTarget).toBe(FOLDED_SPACE);
    expectReads([SESSION_KEY]);
  });

  it("reads no store at all for a channel with lowercase-canonical target ids", async () => {
    getChannelPluginMock.mockReturnValue({ messaging: { targetIdComparison: "lowercase" } });
    await resolveContext();
    expectReads([]);
  });
});
