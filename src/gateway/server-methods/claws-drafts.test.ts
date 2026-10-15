import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { clawsDraftsHandlers } from "./claws-drafts.js";
import type { GatewayClient } from "./client-types.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

describe("Claw draft human authority", () => {
  it("registers draft methods only for administrators", () => {
    for (const method of Object.keys(clawsDraftsHandlers)) {
      expect(coreGatewayHandlers[method]).toBeDefined();
      expect(
        authorizeOperatorScopesForMethod(method, ["operator.read", "operator.write"]).allowed,
      ).toBe(false);
      expect(authorizeOperatorScopesForMethod(method, ["operator.admin"]).allowed).toBe(true);
    }
  });

  it.each(["synthetic", "disconnected", "labs-off"])(
    "refuses %s creation before touching the workspace",
    async (condition) => {
      // SAFETY: This fixture supplies the exact socket fields read by the authority boundary.
      const client = {
        connId: "draft-author",
        connect: { role: "operator", scopes: ["operator.admin"] },
        internal: {
          syntheticClient: condition === "synthetic",
          operatorRoleActor: { kind: "system" },
        },
      } as GatewayClient;
      const replies: Parameters<RespondFn>[] = [];
      const context = createDirectChatContext({
        getRuntimeConfig: () => ({
          agents: { entries: { research: { workspace: "/not-a-real-claw-draft-workspace" } } },
          gateway: { controlUi: { experimental: { claws: condition !== "labs-off" } } },
        }),
        getClientConnIds: () => new Set(condition === "disconnected" ? [] : ["draft-author"]),
      });
      await expectDefined(
        clawsDraftsHandlers["claws.drafts.create"],
        "draft creation",
      )({
        req: { type: "req", id: "create", method: "claws.drafts.create" },
        params: { agentId: "research" },
        client,
        context,
        respond: (...args) => {
          replies.push(args);
        },
        isWebchatConnect: () => false,
      });
      expect(replies).toHaveLength(1);
      expect(replies[0]?.[0]).toBe(false);
      expect(replies[0]?.[2]).toMatchObject({ code: "FORBIDDEN" });
    },
  );
});
