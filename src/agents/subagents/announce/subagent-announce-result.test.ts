import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  isVisibleAssistantResultEventForRun,
  matchesTranscriptEvent,
} from "../../../sessions/transcript-visible-record.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { textAssistant } from "../../test-helpers/sparse-transcript.test-support.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import {
  testing,
  readChildCompletionFindings as readChildCompletionFindingsFromRegistry,
  readSubagentRunAnnounceResult as readSubagentRunAnnounceResultFromRegistry,
} from "./subagent-announce-output.test-support.js";

describe("exact-run announcement results", () => {
  const published = new Map<string, SubagentRunRecord>();
  const readCurrent = (runId: string) => published.get(runId);
  const readResult = (child: SubagentRunRecord) =>
    readSubagentRunAnnounceResultFromRegistry(child, readCurrent);
  const readFindings = (children: SubagentRunRecord[]) =>
    readChildCompletionFindingsFromRegistry(children, readCurrent);
  type FindTranscriptEvent =
    typeof import("../../../config/sessions/session-accessor.js").findTranscriptEvent;
  const storePath = "/tmp/completed-session-store";
  const sessionKey = "agent:main:subagent:completed";

  function completedChild(text: string, runId = "completed-run"): SubagentRunRecord {
    const child: SubagentRunRecord = {
      runId,
      childSessionKey: sessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "Return the complete report",
      cleanup: "delete",
      createdAt: 1,
      execution: {
        status: "terminal",
        outcome: { status: "ok" },
        transcriptTarget: {
          agentId: "main",
          sessionId: "completed-session",
          sessionKey,
          storePath,
        },
      },
      completion: {
        required: true,
        terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
      },
    };
    published.set(child.runId, child);
    return child;
  }

  function installTranscript(events: unknown[], archiveEvents?: unknown[], deletedSession = false) {
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (_scope, match) =>
      found(events.findLast((event) => matchesTranscriptEvent(event, match))),
    );
    testing.setDepsForTest({
      findTranscriptEvent,
      getRuntimeConfig: () => ({}),
      resolveSessionStorePathCore: () => storePath,
      readSubagentSessionEntry: async () =>
        deletedSession ? undefined : { sessionId: "completed-session", updatedAt: 1 },
      findSessionTranscriptArchiveEventReadOnly: async (scope, runId) => {
        expect(scope).toEqual({
          agentId: "main",
          storePath,
          sessionId: deletedSession ? undefined : "completed-session",
          sessionKey,
        });
        return found(
          archiveEvents?.findLast((candidate) =>
            isVisibleAssistantResultEventForRun(candidate, runId),
          ),
        );
      },
    });
    return findTranscriptEvent;
  }

  const found = (event: unknown) => (event === undefined ? undefined : { event });
  const replaceWithSilence = (child: SubagentRunRecord) =>
    published.set(child.runId, {
      ...structuredClone(child),
      completion: { required: true, terminalReply: { disposition: "silent" } },
    });
  function holdTranscript(child: SubagentRunRecord, other?: SubagentRunRecord) {
    const started = createDeferred();
    const release = createDeferred();
    const reader = vi.fn<FindTranscriptEvent>(async (scope, match) => {
      const selected = other && scope.sessionId !== "second-session" ? other : child;
      if (selected === child) {
        started.resolve();
        await release.promise;
      }
      const event = assistant(
        selected.runId,
        other ? `${selected === child ? "second" : "first"} answer` : "original answer",
      );
      return found(matchesTranscriptEvent(event, match) ? event : undefined);
    });
    testing.setDepsForTest({ findTranscriptEvent: reader });
    return { started, release };
  }

  function assistant(runId: string, text: string) {
    return {
      type: "message",
      message: { ...textAssistant(text), stopReason: "stop", __openclaw: { runId } },
    };
  }

  afterEach(() => {
    testing.setDepsForTest();
    published.clear();
  });

  it("reads only a raw child's recorded owner and retains unknown-owner captured output", async () => {
    const child = completedChild("captured answer");
    child.childSessionKey = "global";
    child.childAgentId = "worker";
    child.execution.transcriptTarget = undefined;
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async (scope) => ({
      event: assistant(child.runId, `${scope.agentId} full answer`),
    }));
    testing.setDepsForTest({
      findTranscriptEvent,
      getRuntimeConfig: () => ({}),
      resolveSessionStorePathCore: () => "/synthetic/shared.sqlite",
      readSubagentSessionEntry: async () => ({ sessionId: "child-session", updatedAt: 1 }),
    });

    await expect(readResult(child)).resolves.toMatchObject({ text: "worker full answer" });
    findTranscriptEvent.mockClear();
    child.childAgentId = undefined;
    await expect(readResult(child)).resolves.toMatchObject({ text: "captured answer" });
    expect(findTranscriptEvent).not.toHaveBeenCalled();
  });

  it("keeps silent producer evidence authoritative over retained transcript text", async () => {
    const child = completedChild("old result");
    child.completion = {
      required: true,
      terminalReply: { disposition: "silent" },
      fallbackResultText: "stale fallback",
    };
    const findTranscriptEvent = installTranscript([assistant(child.runId, "old result")]);

    await expect(readResult(child)).resolves.toMatchObject({ text: undefined });
    expect(findTranscriptEvent).not.toHaveBeenCalled();
  });

  it.each(["retired", "recovered"] as const)(
    "rejects %s run during a pending exact transcript read",
    async (change) => {
      const child = completedChild("original answer");
      const { started, release } = holdTranscript(child);
      const result = readResult(child);
      const rejected = expect(result).rejects.toThrow(
        "transcript identity changed during announcement",
      );
      await started.promise;
      if (change === "retired") {
        published.delete(child.runId);
      } else {
        published.set(child.runId, structuredClone(child));
      }
      release.resolve();

      await rejected;
    },
  );

  it("retains prepared result authority across an equivalent immutable publication", async () => {
    const child = completedChild("original answer");
    const findTranscriptEvent = vi.fn<FindTranscriptEvent>(async () => {
      const next = copySubagentRunRuntimeOwner(child, structuredClone(child));
      next.completion!.capturedAt = 10;
      next.delivery = { status: "delivered" };
      published.set(next.runId, next);
      return { event: assistant(child.runId, "original answer") };
    });
    testing.setDepsForTest({ findTranscriptEvent });
    const prepared = await readResult(child);
    expect({ text: prepared.text, current: prepared.isCurrent() }).toEqual({
      text: "original answer",
      current: true,
    });
    expect(published.get(child.runId)).not.toBe(child);
  });

  it.each(["before", "after"] as const)(
    "rejects child execution replacement %s batch preparation",
    async (timing) => {
      const first = completedChild("first answer");
      const second = completedChild("second answer", "second-run");
      second.execution.transcriptTarget = {
        ...second.execution.transcriptTarget,
        sessionId: "second-session",
      };
      const { started, release } = holdTranscript(second, first);
      const result = readFindings([first, second]);
      await started.promise;
      // Finish the first reader's resolved continuation while the second remains held.
      await Promise.resolve();
      if (timing === "before") {
        const rejected = expect(result).rejects.toThrow(
          "A child result changed while preparing the completion batch",
        );
        replaceWithSilence(first);
        release.resolve();
        await rejected;
      } else {
        release.resolve();
        const prepared = await result;
        expect(prepared.isCurrent()).toBe(true);
        expect(prepared.text).toContain("first answer");
        replaceWithSilence(first);
        expect(prepared.isCurrent()).toBe(false);
      }
    },
  );

  it("announces a complete exact-run answer from its registered deletion archive", async () => {
    const text = `${"<archived>".repeat(700)}required-archive-tail`;
    const child = completedChild(text);
    const terminalReply = child.completion?.terminalReply;
    installTranscript(
      [],
      [
        assistant("previous-run", "older archive result"),
        assistant(child.runId, text),
        assistant("replacement-run", "newer archive result"),
      ],
    );

    const prepared = await readFindings([child]);
    expect(prepared.text).toContain(`${"&lt;archived&gt;".repeat(700)}required-archive-tail`);
    expect(prepared.text).not.toContain("older archive result");
    expect(prepared.text).not.toContain("newer archive result");
    expect(child.completion?.terminalReply).toBe(terminalReply);
    expect(terminalReply).toEqual({ disposition: "visible", text: `${text.slice(0, 4_095)}…` });
  });

  it("marks retained evidence when a normal child's exact result is unavailable", async () => {
    const child = completedChild("bounded producer evidence");
    child.execution.transcriptTarget = undefined;
    installTranscript([], undefined, true);

    await expect(readResult(child)).resolves.toMatchObject({
      text: "[truncated-by-retention: complete child answer unavailable]\nbounded producer evidence",
    });
  });
});
