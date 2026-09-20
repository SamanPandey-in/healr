// Offline smoke test for the Step Functions history parser (no AWS calls).
// Run:  npx tsx scripts/check-execution-view.ts
import assert from "node:assert/strict";
import type { HistoryEvent } from "@aws-sdk/client-sfn";
import { buildSteps, buildEvents } from "../server/src/features/incidents/executionView";

let id = 0;
let t = Date.parse("2026-09-20T10:00:00Z");
const ev = (type: string, extra: Partial<HistoryEvent> = {}, advanceMs = 500): HistoryEvent => {
  t += advanceMs;
  return { id: ++id, type, timestamp: new Date(t), ...extra } as HistoryEvent;
};
const entered = (name: string, input: unknown, type = "TaskStateEntered") =>
  ev(type, { stateEnteredEventDetails: { name, input: JSON.stringify(input) } } as any);
const exited = (name: string, output: unknown, type = "TaskStateExited") =>
  ev(type, { stateExitedEventDetails: { name, output: JSON.stringify(output) } } as any);
const lambdaOk = (name: string, input: unknown, output: unknown) => [
  entered(name, input), ev("LambdaFunctionScheduled"), ev("LambdaFunctionStarted"), ev("LambdaFunctionSucceeded"),
  exited(name, output),
];

// ---- Scenario A: paused at the human-approval gate ---------------------------------
const paused: HistoryEvent[] = [
  ev("ExecutionStarted"),
  ...lambdaOk("CreateIncident", { service: "inventory" }, { incidentId: "abc" }),
  ...lambdaOk("BuildGraph", { incidentId: "abc" }, { incidentId: "abc" }),
  ...lambdaOk("LocalizeRootCause", { incidentId: "abc" }, { incidentId: "abc", rankedCandidates: [] }),
  ...lambdaOk("DiagnoseWithBedrock", { incidentId: "abc" }, { incidentId: "abc", rootCauseService: "inventory" }),
  entered("RequestApproval", { incidentId: "abc", rootCauseService: "inventory", taskToken: "SECRET" }),
  ev("TaskScheduled"), ev("TaskStarted"), ev("TaskSubmitted"),
];
let steps = buildSteps(paused);
assert.equal(steps.length, 5);
assert.deepEqual(steps.slice(0, 4).map((s) => s.status), ["succeeded", "succeeded", "succeeded", "succeeded"]);
assert.equal(steps[4].name, "RequestApproval");
assert.equal(steps[4].status, "waiting");
assert.equal(steps[4].waitingOn, "callback");
assert.equal((steps[4].input as any).taskToken, "[redacted]", "task token must never leave the Lambda");
assert.ok(steps[0].durationMs! > 0);

// ---- Scenario B: approved, settled, verified -----------------------------------------
const finished: HistoryEvent[] = [
  ...paused,
  ev("TaskSucceeded"),
  exited("RequestApproval", { approved: true }),
  ...lambdaOk("Remediate", { approved: true }, { revertedFromVersion: "2", revertedToVersion: "1" }),
  entered("WaitForMetricsToSettle", {}, "WaitStateEntered"),
];
steps = buildSteps(finished);
assert.equal(steps[4].status, "succeeded");
assert.equal(steps[5].name, "Remediate");
assert.equal(steps[6].name, "WaitForMetricsToSettle");
assert.equal(steps[6].status, "waiting");
assert.equal(steps[6].waitingOn, "timer");
const done = [
  ...finished,
  exited("WaitForMetricsToSettle", {}, "WaitStateExited"),
  ...lambdaOk("VerifyOutcome", {}, { recovered: true }),
  ev("ExecutionSucceeded"),
];
steps = buildSteps(done);
assert.equal(steps.length, 8);
assert.ok(steps.every((s) => s.status === "succeeded"));

// ---- Scenario C: Lambda retry, then a hard failure -----------------------------------
const failed: HistoryEvent[] = [
  ev("ExecutionStarted"),
  entered("DiagnoseWithBedrock", {}),
  ev("LambdaFunctionScheduled"), ev("LambdaFunctionStarted"),
  ev("LambdaFunctionFailed", { lambdaFunctionFailedEventDetails: { error: "Lambda.ServiceException", cause: "boom" } } as any),
  ev("LambdaFunctionScheduled"), ev("LambdaFunctionStarted"),
  ev("LambdaFunctionFailed", { lambdaFunctionFailedEventDetails: { error: "Error", cause: "DIAGNOSIS_NOT_GROUNDED" } } as any),
  ev("ExecutionFailed", { executionFailedEventDetails: { error: "Error", cause: "DIAGNOSIS_NOT_GROUNDED" } } as any),
];
steps = buildSteps(failed);
assert.equal(steps.length, 1);
assert.equal(steps[0].status, "failed");
assert.equal(steps[0].attempts, 2);
assert.equal(steps[0].cause, "DIAGNOSIS_NOT_GROUNDED");

// ---- Event log labels ------------------------------------------------------------------
const log = buildEvents(done);
assert.equal(log[0].type, "ExecutionStarted");
assert.equal(log[0].state, undefined);
assert.equal(log[log.length - 1].type, "ExecutionSucceeded");
assert.equal(log[log.length - 1].state, undefined);

console.log("execution-view checks passed:", { scenarios: 3, events: done.length });
