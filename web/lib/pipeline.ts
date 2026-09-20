import type {
  Candidate, ExecutionStep, ExecutionView, IncidentBundle, ViewStep,
} from "./types";

// Mirrors the state names in infra/lib/step-functions.ts. Steps the execution hasn't
// reached yet are still drawn (as "pending") so judges see the whole pipeline up front.
// If a state is renamed in CDK, update it here — unknown states from the API are appended.
export const PIPELINE: Omit<ViewStep, "status" | "attempts">[] = [
  { name: "CreateIncident", label: "Create incident", aws: "Lambda · DynamoDB", blurb: "Opens the incident record from the CloudWatch alarm event." },
  { name: "BuildGraph", label: "Build service graph", aws: "Lambda · X-Ray", blurb: "Rebuilds the call graph from recent X-Ray traces." },
  { name: "LocalizeRootCause", label: "Localize root cause", aws: "Lambda · DynamoDB", blurb: "Walks the graph upstream and ranks suspects by deploy timing." },
  { name: "DiagnoseWithBedrock", label: "Diagnose with AI", aws: "Lambda · LLM", blurb: "Cited diagnosis — every claim must reference a real evidence id." },
  { name: "RequestApproval", label: "Human approval", aws: "Step Functions · waitForTaskToken", blurb: "The execution pauses here until a human approves or denies." },
  { name: "Remediate", label: "Remediate", aws: "Lambda · UpdateAlias", blurb: "Rolls the Lambda alias back to the previous published version." },
  { name: "WaitForMetricsToSettle", label: "Let metrics settle", aws: "Step Functions · Wait", blurb: "Waits before measuring so the recovery signal is meaningful.", timerSeconds: 60 },
  { name: "VerifyOutcome", label: "Verify recovery", aws: "Lambda · CloudWatch", blurb: "Compares fault counts before and after the fix." },
];

export function mergeSteps(exec: ExecutionStep[]): ViewStep[] {
  const byName = new Map(exec.map((s) => [s.name, s]));
  const rows: ViewStep[] = PIPELINE.map((def) => {
    const live = byName.get(def.name);
    return { ...def, ...(live ?? {}), status: live?.status ?? "pending", attempts: live?.attempts ?? 0 };
  });
  const known = new Set(PIPELINE.map((d) => d.name));
  for (const s of exec) {
    if (!known.has(s.name)) rows.push({ ...s, label: s.name, aws: "State", blurb: "", status: s.status });
  }
  return rows;
}

// Fallback when the /execution route isn't deployed (or errors): rebuild the same rows from
// the DynamoDB records the dashboard already fetched. Less detail (no per-step input/output
// for early states, no retries) but the UI keeps working.
export function deriveSteps(inc: IncidentBundle): ExecutionStep[] {
  const meta = inc.META;
  if (!meta) return [];
  const a = inc.APPROVAL;
  const exits: Array<string | undefined> = [
    meta.createdAt, undefined, inc.LOCALIZATION?.computedAt, inc.DIAGNOSIS?.generatedAt,
    a && a.status !== "pending" ? a.decidedAt : undefined,
    inc.REMEDIATION?.remediatedAt, undefined, inc.VERIFICATION?.verifiedAt,
  ];
  const outputs: unknown[] = [
    { incidentId: meta.incidentId }, undefined, inc.LOCALIZATION, inc.DIAGNOSIS,
    a ? { status: a.status, decidedAt: a.decidedAt } : undefined, inc.REMEDIATION, undefined, inc.VERIFICATION,
  ];
  const s = meta.status;
  // index of the first state that is not finished yet
  let cursor = ({ open: 1, localized: 3, diagnosed: 4, remediated: 6, closed: 8 } as Record<string, number>)[s] ?? 1;
  if (s === "diagnosed" && a && a.status !== "pending") cursor = a.status === "approved" ? 5 : 4;

  const out: ExecutionStep[] = [];
  PIPELINE.forEach((def, i) => {
    if (i > cursor) return;
    const enteredAt = (i === 0 ? meta.detectedAt : exits.slice(0, i).reverse().find(Boolean)) ?? meta.createdAt;
    const base = { name: def.name, enteredAt, attempts: 1, input: undefined as unknown };
    if (i < cursor) {
      const exitedAt = exits[i];
      out.push({ ...base, status: "succeeded", exitedAt, output: outputs[i],
        durationMs: exitedAt ? Date.parse(exitedAt) - Date.parse(enteredAt) : undefined });
    } else if (def.name === "RequestApproval" && a?.status === "denied") {
      out.push({ ...base, status: "failed", error: "ApprovalDenied", cause: "Human denied remediation" });
    } else if (def.name === "RequestApproval" || def.name === "WaitForMetricsToSettle") {
      out.push({ ...base, status: "waiting", waitingOn: def.name === "RequestApproval" ? "callback" : "timer" });
    } else {
      out.push({ ...base, status: "running" });
    }
  });
  return out;
}

export type Tone = "blue" | "indigo" | "amber" | "green" | "red" | "grey";

export function displayStatus(inc: IncidentBundle, exec?: ExecutionView): { label: string; tone: Tone } {
  const status = inc.META?.status;
  if (exec && exec.status !== "RUNNING" && exec.status !== "SUCCEEDED") {
    return { label: inc.APPROVAL?.status === "denied" ? "Denied" : "Failed", tone: "red" };
  }
  if (status === "closed") {
    return inc.VERIFICATION?.recovered === false
      ? { label: "Not recovered", tone: "red" }
      : { label: "Resolved", tone: "green" };
  }
  if (status === "remediated") return { label: "Verifying", tone: "blue" };
  if (status === "diagnosed") {
    if (inc.APPROVAL?.status === "pending") return { label: "Awaiting approval", tone: "amber" };
    if (inc.APPROVAL?.status === "approved") return { label: "Remediating", tone: "blue" };
    return { label: "Diagnosed", tone: "indigo" };
  }
  if (status === "localized") return { label: "Diagnosing", tone: "indigo" };
  if (status === "open") return { label: "Investigating", tone: "blue" };
  return { label: status ?? "Unknown", tone: "grey" };
}

// Human-readable version of an evidence id. Ids are built in
// server/src/features/diagnosis/evidenceBuilder.ts:  EVIDENCE#<KIND>#<subject>[#<version>]
export function explainEvidence(id: string, candidates: Candidate[], alarmName?: string) {
  const [, kind = "", subject = "", version] = id.split("#");
  const c = candidates.find((x) => x.service === subject);
  if (kind === "ALARM") return { kind: "Alarm", text: `CloudWatch alarm '${alarmName ?? subject}' entered ALARM state.` };
  if (kind === "GRAPH" && c) return { kind: "Graph", text: `'${c.service}' is ${c.distanceFromAnomaly} call-hop(s) upstream of the alarming service.` };
  if (kind === "DEPLOY" && c) {
    return { kind: "Deploy", text: `'${c.service}' deployed ${version ?? c.deployVersion} ${c.secondsBeforeAnomaly ?? "?"}s before the alarm.${c.deploySummary ? ` ${c.deploySummary}` : ""}` };
  }
  return { kind: kind || "Evidence", text: id };
}

export interface Metric { label: string; value?: number; hint: string }

export function computeMetrics(inc: IncidentBundle, steps: ViewStep[], now: number): Metric[] {
  const by = (n: string) => steps.find((s) => s.name === n);
  const t = (iso?: string) => (iso ? Date.parse(iso) : undefined);
  const diff = (a?: number, b?: number) => (a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined);
  const detected = t(inc.META?.detectedAt);
  const diagEnd = t(by("DiagnoseWithBedrock")?.exitedAt);
  const appr = by("RequestApproval");
  const rem = by("Remediate");
  const verify = by("VerifyOutcome");
  const end = t(verify?.exitedAt);
  return [
    { label: "Alarm → incident", hint: "CloudWatch alarm to pipeline start", value: diff(detected, t(inc.META?.createdAt)) },
    { label: "Time to diagnosis", hint: "Incident opened to cited diagnosis", value: diff(t(inc.META?.createdAt), diagEnd) },
    { label: "Human decision", hint: "Paused at the approval gate", value: appr?.durationMs ?? (appr?.status === "waiting" && appr.enteredAt ? now - Date.parse(appr.enteredAt) : undefined) },
    { label: "Fix → verified", hint: "Remediate through VerifyOutcome", value: diff(t(rem?.enteredAt), end) },
    { label: "Total time to recovery", hint: "Alarm to verified recovery", value: diff(detected, end ?? (inc.META?.status === "closed" ? undefined : now)) },
  ];
}
