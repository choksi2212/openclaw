import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Scenario = {
  event?: string;
  schedule?: string;
  operation?: string;
  enabled?: string;
  admitted?: boolean;
  destination?: "testflight" | "app-store" | "internal" | "play-store";
  qualify?: boolean;
  qualificationResult?: "success" | "failure" | "cancelled" | "skipped";
  cancelled?: boolean;
  screenshots?: boolean;
  ref?: string;
  repository?: string;
};
type Workflow = {
  "run-name": string;
  on: {
    schedule: Array<{ cron: string; timezone: string }>;
    workflow_dispatch: { inputs: { operation: { default: string; options: string[] } } };
  };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: {
    qualify: { if: string };
    release: { if: string; needs: string; environment: string; steps: WorkflowStep[] };
    screenshots: { if: string };
  };
};

function loadWorkflow(platform: string) {
  const workflow = parse(
    fs.readFileSync(`.github/workflows/${platform}-store-release.yml`, "utf8"),
  ) as Workflow;
  expect(workflow.on.schedule).toEqual([
    { cron: "0 7 * * *", timezone: "America/Los_Angeles" },
    { cron: "0 11 * * 1", timezone: "America/Los_Angeles" },
  ]);
  expect(workflow.concurrency).toMatchObject({
    group: `${platform}-release`,
    "cancel-in-progress": false,
  });
  expect(workflow.jobs.release.needs).toBe("qualify");
  return workflow;
}

function scenarioEvaluator(scenario: Scenario, variables: Record<string, string>, ios = false) {
  const qualificationResult =
    scenario.qualificationResult ?? (scenario.qualify ? "success" : "skipped");
  const context = {
    github: {
      event_name: scenario.event ?? "schedule",
      event: { schedule: scenario.schedule ?? "0 7 * * *" },
      ref: scenario.ref ?? "refs/heads/main",
      repository: scenario.repository ?? "openclaw/openclaw",
    },
    inputs: { operation: scenario.operation ?? "" },
    vars: variables,
    needs: { qualify: { result: qualificationResult } },
    cancelled: () => scenario.cancelled ?? qualificationResult === "cancelled",
    success: () => qualificationResult === "success",
    always: () => true,
    ...(ios
      ? {
          failure: () => qualificationResult === "failure",
          format: (template: string, operation: string) => template.replace("{0}", operation),
        }
      : {}),
  };
  return (expression: string) => evaluateWorkflowExpression(expression, context);
}

function assertAdmission(
  workflow: Workflow,
  scenario: Scenario,
  evaluate: (expression: string) => unknown,
) {
  expect(Boolean(evaluate(workflow.jobs.qualify.if)), JSON.stringify(scenario)).toBe(
    scenario.qualify ?? false,
  );
  // GitHub adds success() unless the condition includes a status function.
  const condition = workflow.jobs.release.if;
  const releaseCondition = /\b(always|cancelled|failure|success)\s*\(/u.test(condition)
    ? condition
    : `success() && (${condition})`;
  expect(Boolean(evaluate(releaseCondition)), JSON.stringify(scenario)).toBe(
    scenario.admitted ?? Boolean(scenario.destination),
  );
}

function assertUpload(
  upload: WorkflowStep,
  platform: string,
  destination: string,
  evaluate: (expression: string) => unknown,
) {
  const expression = expectDefined(
    upload.env?.[`${platform.toUpperCase()}_RELEASE_DESTINATION`],
    "release destination",
  );
  expect(
    releaseUploadArguments(upload, {
      [`${platform.toUpperCase()}_RELEASE_DESTINATION`]: String(evaluate(expression)),
    }),
  ).toEqual([
    `${platform}:release:upload`,
    "--",
    "--destination",
    destination,
    "--recovery-dir",
    `/synthetic-runner-temp/${platform}-release-recovery`,
  ]);
}

function evaluateWorkflowExpression(expression: string, context: Record<string, unknown>): unknown {
  return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/gu, ""), context);
}

function releaseUploadArguments(upload: WorkflowStep, env: NodeJS.ProcessEnv): string[] {
  return execFileSync(
    "bash",
    [
      "-c",
      [
        "gh() { :; }",
        "pnpm() { printf '%s\\n' \"$@\"; }",
        expectDefined(upload.run, "release upload command"),
      ].join("\n"),
    ],
    { encoding: "utf8", env: { ...process.env, ...env, RUNNER_TEMP: "/synthetic-runner-temp" } },
  )
    .trim()
    .split("\n");
}

describe("mobile store release routing", () => {
  it("routes daily TestFlight and qualified weekly/manual App Store releases", () => {
    const workflow = loadWorkflow("ios");
    const upload = expectDefined(
      workflow.jobs.release.steps.find((step) => step.name === "Prepare and upload iOS release"),
      "iOS upload step",
    );
    const uploadEnvironment = expectDefined(upload.env, "iOS upload environment");

    const scenarios: Scenario[] = [
      { admitted: true, destination: "testflight" },
      { enabled: "", admitted: false },
      { enabled: "false", admitted: false },
      ...["true", "false", ""].map((enabled) => ({
        schedule: "0 11 * * 1",
        enabled,
        admitted: true,
        destination: "app-store" as const,
        qualify: true,
      })),
      ...(["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
        schedule: "0 11 * * 1",
        qualify: true,
        qualificationResult,
        admitted: false,
      })),
      { schedule: "0 12 * * 1", admitted: false },
      ...[{ ref: "refs/heads/candidate" }, { repository: "example/fork" }].map((change) => ({
        schedule: "0 11 * * 1",
        admitted: false,
        ref: change.ref,
        repository: change.repository,
      })),
      {
        event: "workflow_dispatch",
        operation: "testflight",
        enabled: "false",
        admitted: true,
        destination: "testflight",
      },
      {
        event: "workflow_dispatch",
        operation: "release",
        enabled: "false",
        admitted: true,
        destination: "app-store",
        qualify: true,
      },
      ...(["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
        event: "workflow_dispatch",
        operation: "release",
        qualify: true,
        qualificationResult,
        admitted: false,
      })),
      ...["schedule", "workflow_dispatch"].map((event) => ({
        event,
        operation: event === "schedule" ? "" : "testflight",
        cancelled: true,
        admitted: false,
      })),
      {
        event: "workflow_dispatch",
        operation: "screenshots",
        admitted: false,
        screenshots: true,
        ref: "refs/heads/candidate",
      },
      {
        event: "workflow_dispatch",
        operation: "testflight",
        admitted: false,
        ref: "refs/heads/candidate",
      },
      { admitted: false, repository: "example/fork" },
      { event: "push", operation: "release", admitted: false },
    ];
    for (const scenario of scenarios) {
      const evaluate = scenarioEvaluator(
        scenario,
        {
          IOS_TESTFLIGHT_ENABLED: scenario.enabled ?? "true",
          OPENCLAW_TESTFLIGHT_GROUP_ID: "external-group-id",
        },
        true,
      );
      assertAdmission(workflow, scenario, evaluate);
      expect(Boolean(evaluate(workflow.jobs.screenshots.if))).toBe(scenario.screenshots ?? false);
      if (!scenario.admitted) {
        continue;
      }
      expect(evaluate(workflow["run-name"].slice("iOS ".length))).toBe(
        scenario.destination === "testflight"
          ? "TestFlight distribution"
          : (scenario.event ?? "schedule") === "schedule"
            ? "Store release (weekly)"
            : "Store release",
      );
      expect(evaluate(workflow.jobs.release.environment)).toBe(
        scenario.destination === "testflight" ? "ios-testflight" : "ios-store-release",
      );
      expect(
        evaluate(
          expectDefined(
            uploadEnvironment.OPENCLAW_TESTFLIGHT_GROUP_ID,
            "TestFlight group expression",
          ),
        ),
      ).toBe("external-group-id");
      assertUpload(upload, "ios", expectDefined(scenario.destination, "iOS destination"), evaluate);
    }
  });

  it("routes Android weekly/manual store releases through qualification and screenshot tooling", () => {
    const workflow = loadWorkflow("android");
    expect(workflow.on.workflow_dispatch.inputs.operation).toMatchObject({
      default: "release",
      options: ["release", "internal"],
    });
    const release = workflow.jobs.release;
    const findStep = (name: string) =>
      expectDefined(
        release.steps.find((step) => step.name === name),
        name,
      );
    const upload = findStep("Prepare and upload Android release");
    const tooling = findStep("Prepare trusted Linux Android tooling");
    const diagnostics = findStep("Retain screenshot diagnostics");
    const emulators = expectDefined(
      findStep("Setup Android toolchain").with?.["install-screenshot-emulators"],
      "screenshot emulator selection",
    );
    const scenarios: Scenario[] = [
      { destination: "internal" },
      { enabled: "" },
      { enabled: "false" },
      ...["true", "false", ""].map((enabled) => ({
        schedule: "0 11 * * 1",
        enabled,
        destination: "play-store" as const,
        qualify: true,
      })),
      ...["schedule", "workflow_dispatch"].flatMap((event) =>
        (["failure", "cancelled", "skipped"] as const).map((qualificationResult) => ({
          event,
          schedule: "0 11 * * 1",
          operation: event === "schedule" ? "" : "release",
          qualify: true,
          qualificationResult,
        })),
      ),
      { schedule: "0 12 * * 1" },
      ...[{ ref: "refs/heads/candidate" }, { repository: "example/fork" }].map((change) => ({
        schedule: "0 11 * * 1",
        ref: change.ref,
        repository: change.repository,
      })),
      {
        schedule: "0 11 * * 1",
        qualify: true,
        cancelled: true,
      },
      {
        event: "workflow_dispatch",
        operation: "internal",
        enabled: "false",
        destination: "internal",
      },
      {
        event: "workflow_dispatch",
        operation: workflow.on.workflow_dispatch.inputs.operation.default,
        enabled: "false",
        destination: "play-store",
        qualify: true,
      },
      { event: "workflow_dispatch", operation: "unknown" },
      { event: "push", operation: "internal" },
      ...["schedule", "workflow_dispatch"].flatMap((event) => [
        { event, operation: "internal", ref: "refs/heads/candidate" },
        { event, operation: "internal", repository: "example/fork" },
      ]),
    ];
    for (const scenario of scenarios) {
      const evaluate = scenarioEvaluator(scenario, {
        ANDROID_INTERNAL_ENABLED: scenario.enabled ?? "true",
      });
      assertAdmission(workflow, scenario, evaluate);
      if (!scenario.destination) {
        continue;
      }
      const storeRelease = scenario.destination === "play-store";
      expect(evaluate(workflow["run-name"].slice("Android ".length))).toBe(
        !storeRelease
          ? "Internal testing distribution"
          : (scenario.event ?? "schedule") === "schedule"
            ? "Store release (weekly)"
            : "Store release",
      );
      expect(evaluate(release.environment)).toBe(
        storeRelease ? "android-store-release" : "android-internal",
      );
      expect(Boolean(evaluate(tooling.if ?? "true"))).toBe(storeRelease);
      expect(Boolean(evaluate(diagnostics.if ?? "true"))).toBe(storeRelease);
      expect(evaluate(String(emulators))).toBe(String(storeRelease));
      assertUpload(upload, "android", scenario.destination, evaluate);
    }
  });
});
