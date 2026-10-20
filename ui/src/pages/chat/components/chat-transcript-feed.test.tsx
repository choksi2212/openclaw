import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatTranscriptFeed } from "./chat-transcript-feed-view.tsx";

afterEach(cleanupSolid);

function mount(messages: unknown[]) {
  const { container } = mountSolid(() => <ChatTranscriptFeed messages={messages} />);
  flush();
  return queries(container);
}

function queries(container: HTMLElement) {
  const all = <T extends Element = HTMLElement>(selector: string) => [
    ...container.querySelectorAll<T>(selector),
  ];
  return {
    get textContent() {
      return container.textContent;
    },
    all,
    one: <T extends Element = HTMLElement>(selector: string) =>
      container.querySelector<T>(selector),
    texts: (selector: string) => all(selector).map((entry) => entry.textContent?.trim()),
  };
}

const part = (name: string) => ".chat-task-feed__" + name;

function toolCall(id: string, name: string, args: unknown) {
  return { type: "toolCall", id, name, arguments: args };
}

const assistant = (...content: unknown[]) => ({ role: "assistant", content });
const text = (value: string) => ({ type: "text", text: value });
const reply = (content: string, fields: Record<string, unknown> = {}) => ({
  role: "assistant",
  content,
  ...fields,
});
const completed = (...calls: ReturnType<typeof toolCall>[]) => ({
  ...assistant(...calls),
  activity: calls.map(({ id, name }) => completedActivity(id, name === "exec" ? "Exec" : "Read")),
});

function toolResult(toolCallId: string, isError = false) {
  return {
    role: "toolResult",
    toolCallId,
    isError,
    content: [{ type: "text", text: "Result body must not appear" }],
  };
}

function completedActivity(toolCallId: string, title: string) {
  return {
    itemId: `tool:${toolCallId}`,
    toolCallId,
    title,
    kind: "tool",
    phase: "end",
    status: "completed",
  };
}

it("preserves forwarded attribution beside ordinary user and assistant messages", () => {
  const container = mount([
    { role: "user", content: "Please **inspect** [the renderer](https://example.com)." },
    reply("Check the queue.", {
      senderLabel: "Forwarded from Daily report — café 雪 🦞",
      senderSession: {
        sessionKey: "agent:main:cron:daily-report:run:completed",
        agentId: "main",
        label: "Daily report — café 雪 🦞",
      },
    }),
    reply("An agent sent this update.", { senderSession: { agentId: "reviewer" } }),
    reply("A named assistant is not a forwarded source.", { senderLabel: "Custom assistant" }),
    reply("Found the [owner](https://example.com/owner).\n\n```ts\nconst ready = true;\n```"),
  ]);
  const attributions = container.all(".chat-reply-attribution--forwarded");
  expect(attributions.map((entry) => entry.textContent?.replace(/\s+/gu, " ").trim())).toEqual([
    "From Daily report — café 雪 🦞",
    "Forwarded from reviewer",
  ]);
  for (const attribution of attributions) {
    expect(attribution.querySelector("a, [role=link], [tabindex]")).toBeNull();
  }
  expect(container.texts(".sr-only")).toEqual(["User:", "Assistant:", "Assistant:"]);
  const user = container.one(part("user"));
  expect(user?.textContent).toContain("Please inspect the renderer.");
  expect(user?.querySelector("strong, a")).toBeNull();
  expect(container.one('a[href="https://example.com/owner"]')?.textContent).toBe("owner");
  expect(container.one("pre code")?.textContent).toContain("const ready = true;");
  expect(container.one(".chat-avatar, .chat-bubble, .chat-author-avatar")).toBeNull();
});

it("groups consecutive calls across result messages and expands every command or path", () => {
  const command = "pnpm tsgo --project tsconfig.gateway.json\npnpm lint:ui:styles --fix";
  const path = "ui/src/styles/chat/sidebar.css";
  const container = mount([
    completed(toolCall("exec-1", "exec", { command })),
    toolResult("exec-1"),
    completed(
      toolCall("exec-2", "exec", { command: "pnpm lint:ui:styles" }),
      toolCall("read-1", "read", { path }),
    ),
    toolResult("read-1"),
    { role: "assistant", content: "The next step is the layout fix." },
    assistant(
      toolCall("edit-1", "edit", {
        path,
        oldText: "display: flex",
        newText: "display: grid",
      }),
    ),
  ]);
  const groups = container.all<HTMLDetailsElement>("details.chat-task-feed__tool-group");
  expect(groups).toHaveLength(2);
  const group = groups[0]!;
  const summary = group.querySelector("summary")!;
  expect(summary.textContent).toContain("3 operations");
  expect(summary.textContent).toContain("3 other operations");
  expect(summary.textContent).not.toContain("--fix");
  expect(group.open).toBe(false);
  summary.click();
  expect(group.open).toBe(true);
  expect(
    group.querySelector(".chat-task-feed__calls .chat-task-feed__tool-line--full")?.textContent,
  ).toContain(command);
  expect(group.textContent).toContain("pnpm lint:ui:styles");
  expect(group.textContent).toContain(path);
  expect(group.querySelectorAll(part("tool-line")).length).toBeGreaterThanOrEqual(3);
  summary.click();
  expect(group.open).toBe(false);
  expect(container.textContent).not.toContain("Result body must not appear");
});

it.each(["arguments", "args", "input"])(
  "renders and groups untyped calls carrying %s",
  (argumentField) => {
    const commands = ["pnpm check:ui", "pnpm lint:ui:styles"];
    const content = commands.map((command, index) =>
      Object.freeze({
        id: `untyped-exec-${index + 1}`,
        name: "exec",
        [argumentField]: { command },
      }),
    );
    const container = mount([{ role: "assistant", content: Object.freeze(content) }]);
    const groups = container.all(part("tool-group"));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.querySelector("summary")?.textContent?.trim()).toBe("Raw details");
    expect(
      [...groups[0]!.querySelectorAll(part("tool-line--full"))].map((line) =>
        line.textContent?.trim(),
      ),
    ).toEqual(expect.arrayContaining(commands));
  },
);

it("preserves mixed-block order and associates late failure results with their call", () => {
  const container = mount([
    assistant(
      text("Before the command."),
      toolCall("failed-call", "exec", { command: "pnpm check:ui" }),
      text("After the command."),
      toolCall("successful-call", "read", { path: "ui/package.json" }),
    ),
    toolResult("successful-call"),
    toolResult("failed-call", true),
  ]);
  const entries = container.all(part("entry"));
  expect(entries.map((entry) => entry.textContent?.trim())).toEqual([
    expect.stringContaining("Before the command."),
    expect.stringContaining("pnpm check:ui"),
    expect.stringContaining("After the command."),
    expect.stringContaining("ui/package.json"),
  ]);
  const failed = container
    .all(part("tool-line"))
    .filter((line) => line.textContent?.includes("pnpm check:ui"));
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.every((line) => line.classList.contains("chat-task-feed__error"))).toBe(true);
  const successful = container
    .all(part("tool-line"))
    .find((line) => line.textContent?.includes("ui/package.json"));
  expect(successful?.classList.contains("chat-task-feed__error")).toBe(false);
});

it.each(["tool", "function", "toolResult", "tool_result", undefined])(
  "omits an orphan %s result when the page starts after its call",
  (role) => {
    const container = mount([
      {
        ...(role ? { role } : {}),
        toolCallId: "call-on-previous-page",
        toolName: "read",
        content: [{ type: "text", text: "Orphan result body must not appear" }],
      },
      { role: "assistant", content: "The file confirms the layout contract." },
    ]);
    expect(container.textContent).not.toContain("Orphan result body");
    expect(container.textContent).toContain("The file confirms the layout contract.");
    expect(container.all(part("entry"))).toHaveLength(1);
    expect(container.one(part("tool-group"))).toBeNull();
  },
);

it("omits commentary text while retaining a call in the same assistant message", () => {
  const container = mount([
    {
      role: "assistant",
      phase: "commentary",
      content: [
        text("Commentary before the call must not appear"),
        toolCall("commentary-call", "read", { path: "ui/src/styles/chat/sidebar.css" }),
        text("Commentary after the call must not appear"),
      ],
    },
    toolResult("commentary-call"),
    { role: "assistant", phase: "final_answer", content: "The stylesheet owns the layout." },
  ]);
  expect(container.textContent).not.toContain("Commentary");
  expect(container.textContent).not.toContain("Result body must not appear");
  expect(container.all(part("tool-group"))).toHaveLength(1);
  expect(container.one(".chat-task-feed__tool-group summary")?.textContent).toContain(
    "Raw details",
  );
  expect(container.textContent).toContain("The stylesheet owns the layout.");
  expect(container.all(part("entry"))).toHaveLength(2);
});

it("shows local HH:MM message timestamps and omits missing timestamps", () => {
  const timestamp = new Date(2026, 8, 10, 9, 7).getTime();
  const container = mount([
    { role: "user", content: "Timestamped prompt", timestamp },
    { role: "assistant", content: "No timestamp" },
    { role: "assistant", content: "Later timestamp", timestamp: timestamp + 60_000 },
  ]);
  expect(container.all(part("time")).map((time) => time.textContent)).toEqual(["09:07", "09:08"]);
  const unclocked = container
    .all(part("entry"))
    .find((entry) => entry.textContent?.includes("No timestamp"));
  expect(unclocked?.querySelector(part("time"))).toBeNull();
});

it("preserves a complete credential-shaped fixture while bounding the command label", () => {
  const syntheticToken = `AKIA${"0".repeat(16)}`;
  const command = `echo ${"a".repeat(140)} ${syntheticToken}`;
  const container = mount([assistant(toolCall("redact", "exec", { command }))]);
  expect(container.one(part("row-label"))?.textContent).toBe(command.slice(0, 160));
  expect(container.one("code")?.textContent).toBe(command);
});

it.each<[string, Record<string, unknown>, string | null]>([
  ["exec", { command: "set -e" }, "set -e"],
  ["read", { path: "src/example.ts", offset: 20, limit: 30 }, null],
  ["edit", { path: "src/example.ts", oldText: "before", newText: "after" }, null],
  ["write", { path: "src/example.ts", content: "complete file content" }, null],
  ["codebase_search", { query: "example", path: "src/components" }, null],
  [
    "apply_patch",
    {
      input:
        "*** Begin Patch\n*** Add File: one.ts\n+one\n*** Add File: two.ts\n+two\n*** End Patch",
    },
    null,
  ],
])("preserves %s input and setup-only command labels", (name, args, label) => {
  const container = mount([assistant(toolCall("input", name, args))]);
  if (label !== null) {
    expect(container.one(part("row-label"))?.textContent).toBe(label);
  } else {
    expect(JSON.parse(container.one("code")!.textContent!)).toEqual(args);
  }
});

it("preserves anonymous command disclosures when earlier rows arrive in the same group", () => {
  const anonymous = (messageId: string, command: string) => ({
    role: "assistant",
    messageId,
    content: [{ type: "toolCall", name: "exec", arguments: { command } }],
  });
  const first = {
    role: "assistant",
    messageId: "anchor-message",
    content: [toolCall("anchor", "exec", { command: "echo anchor" })],
  };
  const one = anonymous("message-one", "echo one");
  const two = anonymous("message-two", "echo two");
  const [messages, setMessages] = createSignal([first, one, two]);
  const mounted = mountSolid(() => <ChatTranscriptFeed messages={messages()} />);
  const container = queries(mounted.container);
  flush();
  const originalGroup = container.one<HTMLDetailsElement>(part("tool-group"))!;
  originalGroup.querySelector("summary")!.click();
  const original = container.all<HTMLDetailsElement>(part("tool-line"));
  original[2]!.querySelector("summary")!.click();
  expect(original[2]!.open).toBe(true);
  setMessages([first, anonymous("inserted-message", "echo inserted"), one, two]);
  flush();
  const current = container.all<HTMLDetailsElement>(part("tool-line"));
  expect(container.one(part("tool-group"))).toBe(originalGroup);
  expect(originalGroup.open).toBe(true);
  expect([...current].map((row) => row.querySelector("code")?.textContent)).toEqual([
    "echo anchor",
    "echo inserted",
    "echo one",
    "echo two",
  ]);
  expect(current[3]).toBe(original[2]);
  expect(current[3]!.open).toBe(true);
  expect(current[1]!.open).toBe(false);
});

it("names media without previews and omits private thinking blocks", () => {
  const container = mount([
    assistant(
      { type: "thinking", thinking: "Private reasoning must not appear" },
      {
        type: "image",
        name: "layout.png",
        source: { type: "base64", media_type: "image/png", data: "AA==" },
      },
      { type: "file", name: "report.txt", mimeType: "text/plain" },
      text("Attachment review complete."),
    ),
  ]);
  expect(container.textContent).toContain("layout.png");
  expect(container.textContent).toContain("report.txt");
  expect(container.textContent).toContain("Attachment review complete.");
  expect(container.textContent).not.toContain("Private reasoning");
  expect(container.one("img, iframe, video")).toBeNull();
});
