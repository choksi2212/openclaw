import {
  describe,
  registerCodexEventProjectorTestLifecycle,
  expect,
  it,
  createProjector,
  buildEmptyToolTelemetry,
  forCurrentTurn,
} from "./event-projector.test-harness.js";

function notify(
  projector: Awaited<ReturnType<typeof createProjector>>,
  method: Parameters<typeof forCurrentTurn>[0],
  params: Record<string, unknown>,
) {
  return projector.handleNotification(forCurrentTurn(method, params));
}

registerCodexEventProjectorTestLifecycle();

describe("Codex Code Mode transcript projection", () => {
  it("keeps the canonical apply_patch item when it fails", async () => {
    const projector = await createProjector();
    const outerCallId = "code-mode-patch-exec";
    const nativeCallId = "code-mode-patch-file-change";
    const patchInput =
      "*** Begin Patch\n*** Add File: runtime-tool-fixture-patch.txt\n+runtime patch\n*** End Patch\n";

    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call",
        call_id: outerCallId,
        name: "exec",
        input: `const result = await tools.apply_patch(${JSON.stringify(patchInput)});\ntext(result);\n`,
      },
    });
    await notify(projector, "item/completed", {
      item: {
        type: "fileChange",
        id: nativeCallId,
        changes: [{ path: "runtime-tool-fixture-patch.txt", kind: { type: "add" } }],
        status: "failed",
      },
    });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call_output",
        call_id: outerCallId,
        output: [
          {
            type: "input_text",
            text: "Script failed\nWall time 6.0 seconds\nOutput:\n",
          },
          {
            type: "input_text",
            text: "Script error: patch failed",
          },
        ],
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    const patchCalls = result.messagesSnapshot.flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content)) {
        return [];
      }
      return message.content.filter(
        (block) => block.type === "toolCall" && "name" in block && block.name === "apply_patch",
      );
    });
    expect(patchCalls).toHaveLength(1);
    expect(patchCalls[0]).toMatchObject({ id: nativeCallId, name: "apply_patch" });
    expect(
      result.messagesSnapshot.filter(
        (message) => message.role === "toolResult" && message.toolName === "apply_patch",
      ),
    ).toEqual([expect.objectContaining({ toolCallId: nativeCallId, isError: true })]);
    expect(result.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: outerCallId,
        toolName: "exec",
        __openclaw: expect.objectContaining({
          toolOutput: { source: "provider-response", modelInput: "unverified" },
        }),
      }),
    );
  });

  it.each([
    {
      label: "a mismatched input variable",
      source: 'const args = {cmd: "exit 1"}; text(await tools.exec_command(other));',
    },
    {
      label: "a command template interpolation",
      source: "text(await tools.exec_command({cmd: `exit ${code}`}));",
    },
    {
      label: "a prototype setter",
      source: 'text(await tools.exec_command({__proto__: null, cmd: "exit 1"}));',
    },
  ])("keeps $label as an outer exec", async ({ source }) => {
    const projector = await createProjector();
    const callId = "not-an-isolated-code-mode-patch";

    await notify(projector, "rawResponseItem/completed", {
      item: { type: "custom_tool_call", call_id: callId, name: "exec", input: source },
    });
    await notify(projector, "rawResponseItem/completed", {
      item: {
        type: "custom_tool_call_output",
        call_id: callId,
        output: [
          { type: "input_text", text: "Script failed\nWall time 6.0 seconds\nOutput:\n" },
          {
            type: "input_text",
            text: "Script error:\npatch rejected: writing outside of the project; rejected by user approval settings",
          },
        ],
      },
    });

    const result = projector.buildResult(buildEmptyToolTelemetry());
    expect(result.messagesSnapshot.filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({ toolCallId: callId, toolName: "exec", isError: true }),
    ]);
  });
});
