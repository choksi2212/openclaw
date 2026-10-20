// Tests reply payload construction and metadata propagation from agent runs.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { selectHeartbeatToolResponse } from "../heartbeat-tool-response.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

const baseParams = {
  isHeartbeat: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

type TestReplyPayloadParams = Partial<Parameters<typeof buildReplyPayloads>[0]> &
  Pick<Parameters<typeof buildReplyPayloads>[0], "payloads">;

type ReplyRouteDedupeCase = {
  name: string;
  channel: "slack" | "discord" | "mattermost";
  text: string;
  payload?: Record<string, unknown>;
  payloads?: TestReplyPayloadParams["payloads"];
  params: Partial<TestReplyPayloadParams>;
  target: Record<string, unknown>;
  to?: string;
  sharedFirstReply?: boolean;
  expected: string[];
  expectedReplyIds?: Array<string | undefined>;
};

type DirectBlockDedupeCase = {
  name: string;
  payloads: TestReplyPayloadParams["payloads"];
  directBlockPayloads: ReplyPayload[];
  params?: Partial<TestReplyPayloadParams>;
  expected?: Record<string, unknown>;
};

function buildTestReplyPayloads(overrides: TestReplyPayloadParams) {
  return buildReplyPayloads({ ...baseParams, ...overrides });
}

async function expectBuiltPayloads({
  expected,
  ...params
}: TestReplyPayloadParams & { expected: Record<string, unknown>[] }) {
  const { replyPayloads } = await buildTestReplyPayloads(params);
  expect(replyPayloads).toHaveLength(expected.length);
  expected.forEach((payload, index) => expectFields(replyPayloads[index], payload));
}

describe("heartbeat reply scratch", () => {
  it.each([
    { notify: false, proposals: ["  PRIVATE_SCRATCH\n\n- keep exact spacing  \n"] },
    { notify: true, proposals: [""] },
    { notify: false, proposals: ["old proposal", "new proposal"] },
    { notify: false, proposals: ["old proposal", undefined] },
  ])(
    "preserves the latest private decision through embedded and final payloads: %j",
    async ({ notify, proposals }) => {
      const responses = proposals.map((scratch, index) => ({
        outcome: "done" as const,
        notify,
        summary: `Monitor checked ${index + 1}.`,
        ...(scratch !== undefined ? { scratch } : {}),
      }));
      const payloads = responses.flatMap((heartbeatToolResponse) =>
        buildEmbeddedRunPayloads({
          assistantTexts: [],
          lastAssistant: undefined,
          sessionKey: "agent:main:main",
          isHeartbeatTrigger: true,
          heartbeatToolResponse,
        }),
      );
      const expected = proposals.at(-1);
      const embedded = expectDefined(
        selectHeartbeatToolResponse(payloads),
        "expected the embedded heartbeat response",
      );
      expect(getReplyPayloadMetadata(embedded.payload)?.heartbeatScratchProposal).toBe(expected);
      const { replyPayloads } = await buildTestReplyPayloads({ isHeartbeat: true, payloads });

      expect(replyPayloads).toHaveLength(proposals.length);
      const selected = expectDefined(
        selectHeartbeatToolResponse(replyPayloads),
        "expected the final heartbeat response",
      );
      expect(getReplyPayloadMetadata(selected.payload)?.heartbeatScratchProposal).toBe(expected);
      expect(selected.response).toEqual({
        outcome: "done",
        notify,
        summary: `Monitor checked ${proposals.length}.`,
      });
      const serialized = JSON.stringify(replyPayloads);
      expect(serialized).not.toContain('"scratch"');
      for (const scratch of proposals) {
        if (scratch) {
          expect(serialized).not.toContain(JSON.stringify(scratch));
        }
      }
    },
  );
});

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const payload = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(payload[key], key).toEqual(expectedValue);
  }
}

function withMirror(text: string, visibleText = text) {
  return setReplyPayloadMetadata(
    { text: visibleText },
    { sourceReplyTranscriptMirror: { sessionKey: "agent:main", text } },
  );
}

function expectMirroredText(payload: ReplyPayload | undefined, text: string) {
  expect(payload?.text).toBe(text);
  expect(
    getReplyPayloadMetadata(expectDefined(payload, "expected reply"))?.sourceReplyTranscriptMirror
      ?.text,
  ).toBe(text);
}

function indexedReply(index: number, payload: ReplyPayload) {
  return setReplyPayloadMetadata(payload, { assistantMessageIndex: index });
}

function makePipeline(
  overrides: Partial<NonNullable<TestReplyPayloadParams["blockReplyPipeline"]>> = {},
) {
  return {
    didStream: () => false,
    isAborted: () => false,
    hasSentPayload: () => false,
    enqueue: () => {},
    flush: async () => {},
    stop: () => {},
    hasBuffered: () => false,
    hasRetryBlockedDelivery: () => false,
    getSentMediaUrls: (): string[] => [],
    ...overrides,
  };
}

function channelPlugin(
  id: string,
  resolveReplyTransport?: ChannelThreadingAdapter["resolveReplyTransport"],
) {
  return {
    pluginId: id,
    source: "test" as const,
    plugin: {
      ...createChannelTestPluginBase({ id }),
      ...(resolveReplyTransport ? { threading: { resolveReplyTransport } } : {}),
    },
  };
}

async function expectSameTargetRepliesDelivered(params: { provider: string; to: string }) {
  await expectBuiltPayloads({
    payloads: [{ text: "hello world!" }],
    messageProvider: "heartbeat",
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    messagingToolSentTexts: ["different message"],
    messagingToolSentTargets: [{ tool: "message", provider: params.provider, to: params.to }],
    expected: [{ text: "hello world!" }],
  });
}

describe("buildReplyPayloads media filter integration", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        channelPlugin("slack", ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
          const allowedReply = replyDelivery?.replyToMode === "off" ? undefined : replyToId;
          // Slack uses the known root for inherited replies, but explicit targets win.
          const resolved =
            replyToIsExplicit === false ? (threadId ?? allowedReply) : (allowedReply ?? threadId);
          return {
            replyToId: resolved == null ? undefined : String(resolved),
            threadId: null,
          };
        }),
        channelPlugin("mattermost", ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
          const ambientThreadId = threadId != null ? String(threadId) : undefined;
          const isFlatDirect =
            replyDelivery?.chatType === "direct" && replyDelivery.replyToMode === "off";
          const resolvedThreadId = isFlatDirect
            ? undefined
            : replyDelivery
              ? replyToIsExplicit
                ? (replyToId ?? ambientThreadId)
                : (ambientThreadId ?? replyToId ?? undefined)
              : (ambientThreadId ?? replyToId);
          return {
            replyToId: isFlatDirect ? null : resolvedThreadId,
            threadId: resolvedThreadId ?? null,
          };
        }),
        channelPlugin("telegram"),
        channelPlugin("discord"),
        {
          pluginId: "feishu-plugin",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu" }),
            meta: {
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
              docsPath: "/channels/feishu",
              blurb: "test stub",
              aliases: ["lark"],
            },
          },
        },
      ]),
    );
  });

  it.each<{
    name: string;
    payload: ReplyPayload;
    sentMediaUrls?: string[];
    expected?: ReplyPayload[];
  }>([
    {
      name: "unsent media after the legacy media URL was already sent",
      payload: {
        text: "already sent",
        mediaUrl: "file:///tmp/sent.ogg",
        mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
        audioAsVoice: true,
      },
      sentMediaUrls: ["file:///tmp/sent.ogg"],
      expected: [
        {
          text: "already sent",
          mediaUrl: undefined,
          mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
          audioAsVoice: true,
        },
      ],
    },
    {
      name: "an enabled configured delivery operation",
      payload: { text: "already sent", delivery: { pin: { enabled: true } } },
    },
  ])("preserves $name when only the reply text was sent", async (testCase) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [testCase.payload],
      messagingToolSentTexts: ["already sent"],
      messagingToolSentMediaUrls: testCase.sentMediaUrls,
    });
    const expected = testCase.expected ?? [testCase.payload];
    expect(replyPayloads).toHaveLength(expected.length);
    expected.forEach((payload, index) => expect(replyPayloads[index]).toMatchObject(payload));
  });

  it("shares first-reply threading across staged payload builds", async () => {
    const applyReplyToMode = createReplyToModeFilterForChannel("first", "whatsapp");
    const sharedParams = {
      ...baseParams,
      replyToMode: "first" as const,
      replyToChannel: "whatsapp" as const,
      currentMessageId: "msg",
      applyReplyToMode,
    };
    const first = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "internal commentary", isCommentary: true }],
    });
    const fallback = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "run failed", isError: true }],
    });

    expect(first.replyPayloads[0]?.replyToId).toBe("msg");
    expect(fallback.replyPayloads[0]?.replyToId).toBeUndefined();
  });

  it("strips legacy bracket tool blocks from heartbeat replies", async () => {
    await expectBuiltPayloads({
      isHeartbeat: true,
      payloads: [
        {
          text: [
            "Before",
            '[TOOL_CALL]{tool => "exec", args => {"command":"ls"}}[/TOOL_CALL]',
            '[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]',
            "After",
          ].join("\n"),
        },
      ],
      expected: [{ text: "Before\n\n\nAfter" }],
    });
  });

  it("preserves internal delivery metadata through final payload normalization", async () => {
    const payload = markReplyPayloadForSourceSuppressionDelivery({
      text: "⚠️ API rate limit reached.\n[[reply_to_current]]",
    });

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
      replyToMode: "all",
      currentMessageId: "msg-1",
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ API rate limit reached.",
      replyToId: "msg-1",
    });
    expectFields(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant")),
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );
  });

  it.each([
    { name: "text alone", media: false, delivered: false, visible: false },
    { name: "already-delivered media", media: true, delivered: true, visible: false },
    { name: "unsent media", media: true, delivered: false, visible: true },
  ])(
    "filters internal formatting after media dedupe: $name",
    async ({ media, delivered, visible }) => {
      const mediaUrl = "file:///tmp/result.png";
      const { replyPayloads } = await buildTestReplyPayloads({
        payloads: [{ text: "───", ...(media ? { mediaUrl } : {}) }],
        directBlockDeliveries: delivered ? [{ payload: { mediaUrl }, outcome: "delivered" }] : [],
      });

      expect(replyPayloads).toHaveLength(visible ? 1 : 0);
      if (visible) {
        expect(replyPayloads[0]?.mediaUrl).toBe(mediaUrl);
      }
    },
  );

  it.each([
    { isHeartbeat: false, visibleAlreadyClean: false },
    { isHeartbeat: true, visibleAlreadyClean: false },
    { isHeartbeat: true, visibleAlreadyClean: true },
  ])(
    "sanitizes source reply transcript mirror text ($isHeartbeat, $visibleAlreadyClean)",
    async ({ isHeartbeat, visibleAlreadyClean }) => {
      const text = [
        "Visible",
        "<function_response>",
        'Searching for: "what skills matter most in the age of AI"',
        "...",
        "</function_response>",
        "Done",
      ].join("\n");
      const payload = withMirror(text, visibleAlreadyClean ? "Visible\n\nDone" : text);

      const { replyPayloads } = await buildTestReplyPayloads({
        isHeartbeat,
        payloads: [payload],
      });

      expect(replyPayloads).toHaveLength(1);
      expectMirroredText(replyPayloads[0], "Visible\n\nDone");
    },
  );

  it("redacts copied inbound context from the visible reply and its transcript mirror", async () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const text = `${conversationContext}\n\nVisible answer.`;
    const payload = withMirror(text);

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
      conversationContext,
    });

    expectMirroredText(replyPayloads[0], "Visible answer.");
  });

  it("dedupes final media only against message-tool media sent to the same route", async () => {
    await expectBuiltPayloads({
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          mediaUrls: ["file:///tmp/slack-photo.jpg"],
        },
        {
          tool: "discord",
          provider: "discord",
          to: "channel:C2",
          mediaUrls: ["file:///tmp/discord-photo.jpg"],
        },
      ],
      expected: [{ mediaUrl: "file:///tmp/discord-photo.jpg" }],
    });
  });

  it("delivers distinct same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesDelivered({ provider: "message", to: "ou_abc123" });
  });

  it.each<ReplyRouteDedupeCase>([
    {
      name: "dedupes against final routes when first-reply state is shared",
      channel: "slack",
      text: "result",
      payloads: [{ text: "intro" }, { text: "result" }],
      params: { replyToMode: "first", currentMessageId: "111.000" },
      target: { threadId: "111.000" },
      sharedFirstReply: true,
      expected: ["intro", "result"],
      expectedReplyIds: ["111.000", undefined],
    },
    {
      name: "dedupes an explicit Mattermost DM reply against its top-level delivery route",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "post-1", replyToTag: true },
      params: { replyToMode: "off", originatingChatType: "direct" },
      to: "user:U1",
      target: {},
      expected: [],
    },
    {
      name: "dedupes an implicit Mattermost send in the active thread",
      channel: "mattermost",
      text: "same reply",
      params: {
        replyToMode: "all",
        currentMessageId: "child-post",
        originatingThreadId: "root-post",
      },
      target: { threadId: "root-post", threadImplicit: true },
      expected: [],
    },
  ])("$name", async (testCase) => {
    const { channel, text, params, target } = testCase;
    const to = testCase.to ?? "channel:C1";
    const { replyPayloads } = await buildTestReplyPayloads({
      config: {},
      payloads: testCase.payloads ?? [{ text, ...testCase.payload }],
      replyToChannel: channel,
      messageProvider: channel,
      originatingTo: to,
      messagingToolSentTexts: [text],
      messagingToolSentTargets: [{ tool: channel, provider: channel, to, text, ...target }],
      ...params,
      ...(testCase.sharedFirstReply
        ? { applyReplyToMode: createReplyToModeFilterForChannel("first", channel) }
        : {}),
    });

    expect(replyPayloads.map((payload) => payload.text)).toEqual(testCase.expected);
    if (testCase.expectedReplyIds) {
      expect(replyPayloads.map((payload) => payload.replyToId)).toEqual(testCase.expectedReplyIds);
    }
  });

  it("strips media already sent by the block pipeline after normalizing both paths", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const rewrite = (value?: string) =>
        value === "file:///tmp/voice.ogg" ? "file:///tmp/outbound/voice.ogg" : value;
      return {
        ...payload,
        mediaUrl: rewrite(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => rewrite(value) ?? value),
      };
    };
    const pipeline = makePipeline({
      getSentMediaUrls: () => ["file:///tmp/voice.ogg"],
    });

    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/voice.ogg" }],
      expected: [
        {
          text: "caption",
          mediaUrl: undefined,
          mediaUrls: undefined,
        },
      ],
    });
  });

  it("suppresses already-sent text plus media before stripping block-sent media", async () => {
    const sentKey = JSON.stringify({
      text: "caption",
      mediaList: ["file:///tmp/outbound/voice.ogg"],
    });
    const pipeline = makePipeline({
      hasSentPayload: (payload) =>
        JSON.stringify({
          text: (payload.text ?? "").trim(),
          mediaList: [
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...(payload.mediaUrls ?? []),
          ],
        }) === sentKey,
      getSentMediaUrls: () => ["file:///tmp/outbound/voice.ogg"],
    });

    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths: async (payload) => payload,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/outbound/voice.ogg" }],
      expected: [],
    });
  });

  it("preserves unsent text-only final payloads after block pipeline streamed partial content", async () => {
    const pipeline = makePipeline({ didStream: () => true });
    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
      expected: [{ text: "response" }],
    });
  });

  it("preserves final rich content when only its text was streamed", async () => {
    const pipeline = makePipeline({
      didStream: () => true,
      hasSentPayload: () => true,
      hasSentExactPayload: () => false,
    });
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "response", presentation }],
      expected: [{ text: "response", presentation }],
    });
  });

  it("drops final caption and media already sent as one coalesced block payload", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });
    pipeline.enqueue({ text: "Preview" });
    pipeline.enqueue({ text: "below" });
    pipeline.enqueue({ mediaUrls: ["file:///photo.png"] });
    await pipeline.flush({ force: true });

    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "Preview below", mediaUrls: ["file:///photo.png"] }],
      expected: [],
    });
  });

  it("preserves post-stream error payloads when block pipeline streamed successfully", async () => {
    const pipeline = makePipeline({ didStream: () => true });

    const text = "Agent couldn't generate a response. Please try again.";
    await expectBuiltPayloads({
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text, isError: true }],
      expected: [{ text, isError: true }],
    });
  });

  it("keeps error payloads during silent turns", async () => {
    const text =
      "⚠️ write failed: Memory flush writes are restricted to memory/2026-05-05.md; use that path only.";
    await expectBuiltPayloads({
      silentExpected: true,
      payloads: [{ text: "normal maintenance reply" }, { text, isError: true }],
      expected: [{ text, isError: true }],
    });
  });

  it("keeps prepared voice media captions during silent turns", async () => {
    const payload = { text: "NO_REPLY", mediaUrl: "file:///tmp/voice.opus", audioAsVoice: true };
    await expectBuiltPayloads({
      silentExpected: true,
      payloads: [payload],
      expected: [payload],
    });
  });

  it("drops empty voice markers during silent turns", async () => {
    await expectBuiltPayloads({
      silentExpected: true,
      payloads: [{ audioAsVoice: true }],
      expected: [],
    });
  });

  it("preserves inline caption text when lifting markdown image replies into media", async () => {
    await expectBuiltPayloads({
      extractMarkdownImages: true,
      payloads: [{ text: 'Look ![chart](https://example.com/chart.png "Quarterly chart") now' }],
      expected: [
        {
          text: "Look now",
          mediaUrl: "https://example.com/chart.png",
          mediaUrls: ["https://example.com/chart.png"],
        },
      ],
    });
  });

  it("keeps markdown local file images as plain text in final replies", async () => {
    const text = "Look ![chart](file:///etc/passwd) now";
    await expectBuiltPayloads({
      extractMarkdownImages: true,
      payloads: [{ text }],
      expected: [{ text, mediaUrl: undefined, mediaUrls: undefined }],
    });
  });

  it.each<DirectBlockDedupeCase>([
    {
      name: "drops a final caption already sent with direct media (streaming: true)",
      directBlockPayloads: [indexedReply(1, { text: "response", mediaUrl: "/tmp/fetched.png" })],
      payloads: [indexedReply(1, { text: "response" })],
      params: { blockStreamingEnabled: true },
    },
    {
      name: "preserves the same caption from a different assistant message",
      directBlockPayloads: [indexedReply(1, { text: "response", mediaUrl: "/tmp/fetched.png" })],
      payloads: [indexedReply(2, { text: "response" })],
      expected: { text: "response" },
    },
    {
      name: "ignores direct status notices when matching final text",
      directBlockPayloads: [{ text: "Compacting", isStatusNotice: true }, { text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: { text: undefined, mediaUrls: ["/tmp/generated.png"] },
    },
  ])("$name", async ({ payloads, directBlockPayloads, params, expected }) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      directBlockDeliveries: directBlockPayloads.map((payload): DirectBlockDelivery => ({
        payload,
        outcome: "delivered",
      })),
      payloads,
      ...params,
    });

    expect(replyPayloads).toHaveLength(expected ? 1 : 0);
    if (expected) {
      expectFields(replyPayloads[0], expected);
    }
  });

  it("preserves final text when internal whitespace changed", async () => {
    const directBlockDeliveries: DirectBlockDelivery[] = [
      {
        payload: indexedReply(1, { text: "constx=1" }),
        outcome: "delivered",
      },
    ];
    const finalPayload = indexedReply(1, { text: "const x = 1\n\nMEDIA:/tmp/generated.png" });

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      directBlockDeliveries,
      payloads: [finalPayload],
    });

    expectFields(replyPayloads[0], {
      text: "const x = 1",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("does not suppress same-target replies when accountId differs", async () => {
    await expectBuiltPayloads({
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      accountId: "personal",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          accountId: "work",
        },
      ],
      expected: [{ text: "hello world!" }],
    });
  });
});
