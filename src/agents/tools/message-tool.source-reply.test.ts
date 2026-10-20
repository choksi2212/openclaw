import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundContext } from "../../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import * as commandSecretGateway from "../../cli/command-secret-gateway.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as messageActionRunner from "../../infra/outbound/message-action-runner.js";
import {
  directOutbound,
  workspaceConfig,
  workspaceTestPlugin,
} from "../../infra/outbound/message-action-runner.test-support.js";
import { buildOutboundMediaLoadOptions } from "../../media/load-options.js";
import { loadWebMedia } from "../../media/web-media.js";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createMessageTool } from "./message-tool-execution.js";
import type { MessageToolOptions } from "./message-tool-execution.types.js";

const actualRunMessageAction = messageActionRunner.runMessageAction;
const mocks = {
  runMessageAction: vi.fn<typeof actualRunMessageAction>(),
  resolveCommandSecretRefsViaGateway: vi.fn(
    commandSecretGateway.resolveCommandSecretRefsViaGateway,
  ),
};

function registerPlugins(plugin: ChannelPlugin) {
  setActivePluginRegistry(createTestRegistry([{ pluginId: plugin.id, source: "test", plugin }]));
}

beforeEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  mocks.runMessageAction.mockReset();
  mocks.resolveCommandSecretRefsViaGateway.mockClear();
  vi.spyOn(messageActionRunner, "runMessageAction").mockImplementation(mocks.runMessageAction);
  vi.spyOn(commandSecretGateway, "resolveCommandSecretRefsViaGateway").mockImplementation(
    mocks.resolveCommandSecretRefsViaGateway,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("completion source-reply authority", () => {
  const replyTag = "[[reply_to:message-2]]";
  const audioTag = "[[audio_as_voice]]";
  function createSourceTool(
    config: MessageToolOptions["config"],
    options: Partial<MessageToolOptions>,
  ) {
    return createMessageTool({
      config,
      sourceReplyOnly: true,
      sourceReplyDeliveryMode: "message_tool_only",
      currentThreadTs: "thread-1",
      currentMessageId: "message-1",
      ...options,
    });
  }
  function createRestrictedTool(overrides: Partial<MessageToolOptions> = {}) {
    const config = overrides.config ?? {};
    setRuntimeConfigSnapshot(config);
    registerPlugins({
      ...createChannelTestPluginBase({
        id: "discord",
        config: { listAccountIds: () => ["source-account"] },
      }),
      actions: {
        describeMessageTool: () => ({ actions: ["send", "delete", "ban"] }),
        messageActionTargetAliases: {
          send: { aliases: ["destination"], deliveryTargetAliases: ["destination"] },
        },
      },
    });
    return createSourceTool(config, {
      currentChannelProvider: "discord",
      currentChannelId: "channel:source",
      agentAccountId: "source-account",
      ...overrides,
    });
  }

  it.each([
    ["delete", { action: "delete" }],
    ["other provider", { channel: "telegram" }],
    ["other target", { target: "channel:other" }],
    ["legacy recipient", { to: "channel:other" }],
    ["channel-id alias", { channelId: "channel:other" }],
    ["plugin target alias", { destination: "channel:other" }],
    ["multiple targets", { targets: ["channel:other"] }],
    ["other account", { accountId: "other-account" }],
    ["other thread", { threadId: "thread-2" }],
    ["other reply", { replyTo: "message-2" }],
    ["remote gateway", { gatewayUrl: "wss://other.example" }],
    ["gateway token", { gatewayToken: "other-token" }],
    ["inline buffer", { buffer: "c2VjcmV0" }],
    ["unknown plugin argument", { pluginFile: "./AGENTS.md" }],
    ["inline reply route", { message: `${replyTag} stolen thread` }],
    [
      "media URL reply",
      { media: undefined, message: `MEDIA:https://example.com/a${replyTag}.png` },
    ],
    ["media caption reply", { message: "", caption: `MEDIA:https://example.com/a${replyTag}.png` }],
    ["media URL audio", { message: `MEDIA:https://example.com/a${audioTag}.ogg` }],
    ["caption reply route", { message: "", caption: `${replyTag} stolen thread` }],
    ["caption audio directive", { message: " ", caption: `${audioTag} completion` }],
    [
      "reply directive after an indented fence",
      { message: "    ```text\n[[reply_to:message-2]] stolen thread\n```" },
    ],
    ["inline audio directive", { message: `${audioTag} completion` }],
    ["citation marker reply", { message: `cite${replyTag}` }],
    [
      "tool-owned fence audio",
      {
        message: [
          "<function=read><parameter=x>",
          "```text",
          "</parameter></function>",
          `${audioTag} completion`,
          "```",
        ].join("\n"),
      },
    ],
    [
      "sanitizer-assembled reply directive",
      { message: "[[reply_<final>to:message-2]] stolen thread" },
    ],
  ])("rejects %s before resolving secrets or dispatching", async (_name, args) => {
    const tool = createRestrictedTool();

    await expect(
      tool.execute("restricted", {
        action: "send",
        message: "completion",
        media: "https://example.com/photo.png",
        filename: "photo.png",
        contentType: "image/png",
        ...args,
      }),
    ).rejects.toThrow(/Completion source replies/);
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(mocks.runMessageAction).not.toHaveBeenCalled();
  });

  function createCompletionMediaTool() {
    mocks.runMessageAction.mockImplementation(actualRunMessageAction);
    const config = { ...workspaceConfig, tools: { fs: { workspaceOnly: true } } };
    setRuntimeConfigSnapshot(config);
    const sendMedia = vi.fn(async (_ctx: ChannelOutboundContext) => ({
      channel: "workspace",
      messageId: "photo-1",
    }));
    registerPlugins({
      ...workspaceTestPlugin,
      outbound: {
        ...directOutbound,
        extractMarkdownImages: true,
        sendMedia: async (ctx) => {
          // This provider accepts remote URLs; local uploads use the shared media policy.
          if (ctx.mediaUrl && !ctx.mediaUrl.startsWith("https://")) {
            await loadWebMedia(ctx.mediaUrl, buildOutboundMediaLoadOptions(ctx));
          }
          return sendMedia(ctx);
        },
      },
    });
    const tool = createSourceTool(config, {
      agentSessionKey: "agent:main:workspace:group:SOURCE",
      currentChannelProvider: "workspace",
      currentChannelId: "SOURCE",
    });
    return { tool, sendMedia };
  }

  it("delivers completion media and attachments to the current source through normal sends", async () => {
    await withOpenClawTestState({ layout: "state-only", prefix: "completion-media-" }, async () => {
      const { tool, sendMedia } = createCompletionMediaTool();
      const url = "https://example.com/photo.png";
      for (const args of [
        { media: url, message: "Replacement photo" },
        { media: url, caption: "Replacement photo" },
        { media: url, filename: "photo.png", contentType: "image/png" },
        { media: url, mimeType: "image/png" },
        { attachments: [{ media: url, name: "photo.png" }] },
        { message: `MEDIA:${url}` },
        { message: `![Replacement photo](${url})` },
      ]) {
        sendMedia.mockClear();
        const result = await tool.execute("completion-media", {
          action: "send",
          replyTo: "message-1",
          threadId: "thread-1",
          ...args,
        });
        expect(sendMedia).toHaveBeenCalledTimes(1);
        expect(sendMedia).toHaveBeenCalledWith(
          expect.objectContaining({
            to: "SOURCE",
            mediaUrl: url,
            threadId: "thread-1",
            replyToId: "message-1",
          }),
        );
        expect(result.details).toHaveProperty("messageDelivery.sourceReplyDelivered", true);
      }
    });
  });

  it("applies normal local media roots and empty-send validation to completion replies", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "completion-media-" },
      async ({ stateDir }) => {
        const { tool, sendMedia } = createCompletionMediaTool();
        // State files outside managed media/workspace roots must never become attachments.
        const outside = `${stateDir}/private.txt`;
        const directivePath = pathToFileURL(outside).href;
        await fs.writeFile(outside, "private fixture");
        for (const args of [
          { media: outside },
          { attachments: [{ media: outside }] },
          { message: `MEDIA:${directivePath}` },
          { message: `completion\\nMEDIA:${directivePath}` },
          { message: `completion\nMEciteDIA:${directivePath}` },
        ]) {
          const result = await tool.execute("outside-roots", {
            action: "send",
            filename: "photo.png",
            contentType: "image/png",
            ...args,
          });
          expect(result.details).toMatchObject({
            deliveryStatus: "failed",
            error: expect.stringMatching(/not under an allowed directory/),
            messageDelivery: { status: "failed" },
          });
          expect(result.details).not.toHaveProperty("messageDelivery.sourceReplyDelivered");
        }
        await expect(tool.execute("empty", { action: "send", message: " \n\t " })).rejects.toThrow(
          "send requires text or media",
        );
        expect(sendMedia).not.toHaveBeenCalled();
      },
    );
  });

  it("allows shared final controls and matched canonical source-thread text sends", async () => {
    mocks.runMessageAction.mockResolvedValue({
      kind: "send",
      action: "send",
      channel: "discord",
      to: "channel:source",
      handledBy: "plugin",
      payload: {},
      dryRun: true,
    });
    const tool = createRestrictedTool();

    for (const [id, args] of [
      ["implicit", { message: "completion", final: true }],
      ["literal-no-reply", { message: "NO_REPLY", final: true }],
      ["media-prose", { message: "See the MEDIA: section for details." }],
      ["media-code-example", { message: "Example:\n```text\nMEDIA:./AGENTS.md\n```" }],
      [
        "explicit",
        {
          channel: "discord",
          target: "channel:source",
          accountId: "source-account",
          threadId: "thread-1",
          replyTo: "message-1",
          message: "completion",
          final: false,
        },
      ],
    ] as const) {
      await tool.execute(id, { action: "send", ...args });
    }

    expect(mocks.runMessageAction).toHaveBeenCalledTimes(5);
    expect(mocks.runMessageAction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ params: expect.objectContaining({ message: "NO_REPLY" }) }),
    );
  });

  it("fails closed when the authoritative source target is missing", async () => {
    const tool = createRestrictedTool({ currentChannelId: undefined });

    await expect(
      tool.execute("missing-source", { action: "send", message: "completion" }),
    ).rejects.toThrow("authoritative current conversation");
    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
  });
});
