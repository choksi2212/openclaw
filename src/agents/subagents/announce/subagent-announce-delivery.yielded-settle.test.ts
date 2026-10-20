// Yielded private settle finals require completion evidence and the original requester.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { sendMessage } from "../../../infra/outbound/message.js";
import { captureSessionTarget } from "../../../sessions/session-controller.target.js";
import { deliverSubagentAnnouncement, testing } from "./subagent-announce-delivery.test-support.js";

const sentDeliveryStatus = { status: "sent", resultCount: 1 } as const;
const payloads = (text = "parent answer") => [{ text }];
const visibleResult = { payloads: payloads(), deliveryStatus: sentDeliveryStatus };
const silentResult = { payloads: [], meta: { terminalReply: { disposition: "silent" } } };
const missingReply = { delivered: false, reason: "visible_reply_missing" };
const visibleReply = { delivered: true, requesterVisibleFinalDelivered: true };
const policySuppression = {
  payloads: payloads(),
  deliveryStatus: { status: "suppressed", reason: "message_tool_only", resultCount: 0 },
};
const settleCase = (
  name: string,
  response: unknown,
  expected: Record<string, unknown> = missingReply,
) => ({ name, response, expected });

describe("yielded private settle outcomes", () => {
  it.each([
    settleCase("delivered final", { status: "ok", result: visibleResult }, visibleReply),
    {
      ...settleCase(
        "required public reply in a group that allows silence",
        {
          status: "ok",
          result: visibleResult,
        },
        visibleReply,
      ),
      public: true,
      group: true,
    },
    settleCase("intentional silence", { status: "ok", result: silentResult }, { delivered: true }),
    ...["ok", "timeout"].map((status) => ({
      name: `normalized silent result: ${status}`,
      response: {
        status,
        result: {
          ...silentResult,
          deliveryStatus: {
            status: "suppressed",
            succeeded: true,
            reason: "no_visible_payload",
            resultCount: 0,
          },
        },
      },
      expected: status === "ok" ? { delivered: true } : missingReply,
    })),
    settleCase("runtime timeout", { status: "timeout", summary: "aborted", stopReason: "timeout" }),
    settleCase("failed turn", { status: "error" }),
    settleCase("empty successful turn", { status: "ok", result: { payloads: [] } }),
    settleCase("failed silence", {
      status: "ok",
      result: { ...silentResult, meta: { ...silentResult.meta, aborted: true } },
    }),
    settleCase("undelivered text", {
      status: "ok",
      result: { payloads: payloads("unsent answer") },
    }),
    settleCase(
      "message-tool room: final sent with the message tool",
      {
        status: "ok",
        result: {
          payloads: [],
          didSendViaMessagingTool: true,
          messagingToolSentTargets: [
            {
              tool: "message",
              provider: "discord",
              accountId: "acct-1",
              to: "dm:U123",
              text: "parent answer",
              sourceReplyFinal: true,
            },
          ],
        },
      },
      visibleReply,
    ),
    settleCase(
      "message-tool room: plain final suppressed by policy",
      { status: "ok", result: policySuppression },
      { delivered: false, disposition: "intentional_non_delivery", terminal: true },
    ),
    {
      ...settleCase(
        "public yielded room: plain final suppressed by policy",
        { status: "ok", result: policySuppression },
        { delivered: false, disposition: "intentional_non_delivery", terminal: true },
      ),
      public: true,
    },
    ...[
      { error: { kind: "incomplete_turn" } },
      { aborted: true },
      { yielded: true },
      { continuationPending: true },
    ].map((meta) => ({
      name: "policy suppression cannot settle " + Object.keys(meta)[0],
      response: {
        status: "ok",
        result: { ...policySuppression, payloads: payloads("partial answer"), meta },
      },
      expected: missingReply,
    })),
    settleCase(
      "transferred next wave",
      {
        status: "ok",
        result: { payloads: [], meta: { yielded: true }, requesterContinuationSettled: true },
      },
      { delivered: true },
    ),
    {
      ...settleCase(
        "replaced requester",
        { status: "ok" },
        { delivered: false, reason: "completion_handoff_unavailable", terminal: true },
      ),
      replaced: true,
    },
  ])("requires real completion evidence: $name", async (testCase) => {
    const to = "group" in testCase ? "channel:room-1" : "dm:U123";
    const sessionKey = `agent:main:discord:${to}`;
    const origin = { channel: "discord", to, accountId: "acct-1" };
    const current = "replaced" in testCase ? "replacement-parent" : "requester-session-dm";
    const dispatch = vi.fn(async function <T>(
      _method: string,
      _params: Record<string, unknown>,
      _options?: unknown,
    ) {
      return testCase.response as T;
    });
    const send = vi.fn<typeof sendMessage>();
    onTestFinished(() => testing.setDepsForTest());
    testing.setDepsForTest({
      dispatchGatewayMethodInProcess: dispatch,
      getRequesterSessionActivity: () => ({
        sessionId: current,
        isActive: false,
        target: captureSessionTarget({
          storeScope: "/synthetic/yielded-settle/sessions.json",
          sessionKey,
          incarnation: current,
        }),
      }),
      getRuntimeConfig: () => ({ surfaces: { discord: { silentReply: { group: "allow" } } } }),
      loadRequesterSessionEntry: (key) => ({
        cfg: {},
        canonicalKey: key,
        entry: { sessionId: current, updatedAt: 1 },
      }),
      sendMessage: send,
    });
    const result = await deliverSubagentAnnouncement({
      requesterSessionKey: sessionKey,
      targetRequesterSessionKey: sessionKey,
      triggerMessage: "settled private findings",
      requesterSessionOrigin: origin,
      directOrigin: origin,
      sourceTool: "subagent_settle",
      requesterIsSubagent: false,
      expectsCompletionMessage: false,
      ...("public" in testCase
        ? { requireVisibleReply: true }
        : { completionRequesterSessionId: "requester-session-dm" }),
      directIdempotencyKey: "announce:requester-settle:private",
    });
    expect(result).toMatchObject(testCase.expected);
    if ("replaced" in testCase) {
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(dispatch.mock.calls[0]?.[2]).toMatchObject({
        replyExpectation: "public" in testCase ? "required" : "optional",
      });
      const agentParams = dispatch.mock.calls[0]?.[1];
      expect(agentParams).toMatchObject({
        deliver: true,
        channel: "discord",
        to,
        ...("public" in testCase ? {} : { expectedExistingSessionId: "requester-session-dm" }),
      });
      // The conversation's configured reply policy decides, not this handoff.
      expect(agentParams).not.toHaveProperty("sourceReplyDeliveryMode");
    }
    expect(send).not.toHaveBeenCalled();
  });
});
