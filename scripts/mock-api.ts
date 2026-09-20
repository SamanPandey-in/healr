// Offline stand-in for the deployed API, so the dashboard can be developed and demoed without AWS.
// It replays a scripted incident and builds the /execution response with the REAL parser
// (server/src/features/incidents/executionView.ts) from synthetic Step Functions history events.
//
//   npx tsx scripts/mock-api.ts          # http://localhost:9999
//   NEXT_PUBLIC_API_BASE=http://localhost:9999 npm run dev --workspace web
import http from "node:http";
import type { HistoryEvent } from "@aws-sdk/client-sfn";
import { buildSteps, buildEvents } from "../server/src/features/incidents/executionView";

const PORT = Number(process.env.PORT ?? 9999);
const WAIT_MS = Number(process.env.WAIT_MS ?? 8000); // real pipeline waits 60s; shortened for demos
const BASE = `http://localhost:${PORT}`;

interface Script { name: string; ms: number; kind?: "callback" | "timer"; out: (id: string) => unknown }
const candidates = (id: string) => [
  { service: "inventory", distanceFromAnomaly: 0, deployTimestamp: iso(-47_000), deployVersion: "2", deploySummary: "Add 800ms pricing lookup", secondsBeforeAnomaly: 47, score: 0.79 },
  { service: "orders", distanceFromAnomaly: 1, deployTimestamp: null, deployVersion: null, deploySummary: null, secondsBeforeAnomaly: null, score: 0.11 },
  { service: "gateway", distanceFromAnomaly: 2, deployTimestamp: null, deployVersion: null, deploySummary: null, secondsBeforeAnomaly: null, score: 0.08 },
];
const SCRIPT: Script[] = [
  { name: "CreateIncident", ms: 700, out: (id) => ({ incidentId: id, service: "inventory" }) },
  { name: "BuildGraph", ms: 1400, out: (id) => ({ incidentId: id, service: "inventory" }) },
  { name: "LocalizeRootCause", ms: 900, out: (id) => ({ incidentId: id, rankedCandidates: candidates(id) }) },
  { name: "DiagnoseWithBedrock", ms: 2600, out: (id) => ({ incidentId: id, rootCauseService: "inventory", confidence: 0.92 }) },
  { name: "RequestApproval", ms: 0, kind: "callback", out: (id) => ({ incidentId: id, approved: true, rootCauseService: "inventory" }) },
  { name: "Remediate", ms: 1500, out: (id) => ({ incidentId: id, revertedFromVersion: "2", revertedToVersion: "1" }) },
  { name: "WaitForMetricsToSettle", ms: WAIT_MS, kind: "timer", out: () => ({}) },
  { name: "VerifyOutcome", ms: 1200, out: (id) => ({ incidentId: id, recovered: true }) },
];

function iso(offsetMs = 0) { return new Date(Date.now() + offsetMs).toISOString(); }

interface Run { id: string; start: number; decidedAt?: number; decision?: "approve" | "deny" }
const runs: Run[] = [];
const past = [
  { incidentId: "9f31c2aa-0000-4000-8000-000000000001", service: "inventory", alarmName: "InventoryErrorAlarm", detectedAt: iso(-3_600_000), createdAt: iso(-3_599_000), status: "closed" },
  { incidentId: "1c77d0be-0000-4000-8000-000000000002", service: "inventory", alarmName: "InventoryErrorAlarm", detectedAt: iso(-7_200_000), createdAt: iso(-7_199_000), status: "closed" },
];

// Compute every step's [start, end) from the run's clock and the approval decision time.
function timeline(run: Run) {
  let cursor = run.start;
  return SCRIPT.map((s) => {
    const start = cursor;
    const end = s.kind === "callback" ? (run.decidedAt ? run.decidedAt : Infinity) : start + s.ms;
    cursor = end;
    return { s, start, end };
  });
}

function history(run: Run, now: number): HistoryEvent[] {
  let id = 0;
  const ev = (type: string, at: number, extra: Partial<HistoryEvent> = {}) => ({ id: ++id, type, timestamp: new Date(at), ...extra }) as HistoryEvent;
  const out: HistoryEvent[] = [ev("ExecutionStarted", run.start)];
  let failed = false;
  for (const { s, start, end } of timeline(run)) {
    if (now < start || failed) break;
    const entered = s.kind === "timer" ? "WaitStateEntered" : "TaskStateEntered";
    out.push(ev(entered, start, { stateEnteredEventDetails: { name: s.name, input: JSON.stringify({ incidentId: run.id, taskToken: "SHOULD-BE-REDACTED" }) } } as any));
    if (s.kind !== "timer") {
      out.push(ev(s.kind === "callback" ? "TaskScheduled" : "LambdaFunctionScheduled", start + 40));
      out.push(ev(s.kind === "callback" ? "TaskStarted" : "LambdaFunctionStarted", start + 120));
      if (s.kind === "callback") out.push(ev("TaskSubmitted", start + 260));
    }
    if (now >= end) {
      if (s.kind === "callback" && run.decision === "deny") {
        out.push(ev("TaskFailed", end, { taskFailedEventDetails: { error: "ApprovalDenied", cause: "Human denied remediation" } as any }));
        out.push(ev("ExecutionFailed", end, { executionFailedEventDetails: { error: "ApprovalDenied", cause: "Human denied remediation" } } as any));
        failed = true;
        break;
      }
      out.push(ev(s.kind === "callback" ? "TaskSucceeded" : s.kind === "timer" ? "WaitStateExited" : "LambdaFunctionSucceeded", end - 30));
      out.push(ev(s.kind === "timer" ? "WaitStateExited" : "TaskStateExited", end, { stateExitedEventDetails: { name: s.name, output: JSON.stringify(s.out(run.id)) } } as any));
    }
  }
  const done = timeline(run).every((t) => now >= t.end);
  if (done) out.push(ev("ExecutionSucceeded", timeline(run).at(-1)!.end + 20));
  return out;
}

function bundle(run: Run, now: number) {
  const tl = timeline(run);
  const doneAt = (name: string) => { const t = tl.find((x) => x.s.name === name)!; return now >= t.end ? t.end : undefined; };
  const status = doneAt("VerifyOutcome") ? "closed" : doneAt("Remediate") ? "remediated" : doneAt("DiagnoseWithBedrock") ? "diagnosed" : doneAt("LocalizeRootCause") ? "localized" : "open";
  const b: any = { META: { incidentId: run.id, service: "inventory", alarmName: "InventoryErrorAlarm", detectedAt: new Date(run.start - 800).toISOString(), createdAt: new Date(run.start + 300).toISOString(), status } };
  if (doneAt("LocalizeRootCause")) b.LOCALIZATION = { incidentId: run.id, rankedCandidates: candidates(run.id), computedAt: new Date(doneAt("LocalizeRootCause")!).toISOString() };
  if (doneAt("DiagnoseWithBedrock")) {
    b.DIAGNOSIS = { incidentId: run.id, rootCauseService: "inventory", confidence: 0.92, generatedAt: new Date(doneAt("DiagnoseWithBedrock")!).toISOString(), rankedCandidates: candidates(run.id),
      summary: "The inventory service began failing within a minute of its version 2 deploy, which added a slow pricing lookup. It is the alarming service itself and the only candidate with a deploy immediately before the anomaly, so the deploy is the most likely cause.",
      citedEvidenceIds: ["EVIDENCE#ALARM#InventoryErrorAlarm", "EVIDENCE#GRAPH#inventory", "EVIDENCE#DEPLOY#inventory#2"] };
    b.APPROVAL = { incidentId: run.id, status: run.decision ? (run.decision === "approve" ? "approved" : "denied") : "pending", decidedAt: run.decidedAt ? new Date(run.decidedAt).toISOString() : undefined,
      approveLink: `${BASE}/approve-link?incidentId=${run.id}&token=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&action=approve`,
      denyLink: `${BASE}/approve-link?incidentId=${run.id}&action=deny` };
  }
  if (doneAt("Remediate")) b.REMEDIATION = { incidentId: run.id, service: "inventory", action: "lambda-alias-rollback", revertedFromVersion: "2", revertedToVersion: "1", remediatedAt: new Date(doneAt("Remediate")!).toISOString() };
  if (doneAt("VerifyOutcome")) b.VERIFICATION = { incidentId: run.id, service: "inventory", faultCountBefore: 11, faultCountAfter: 0, recovered: true, verifiedAt: new Date(doneAt("VerifyOutcome")!).toISOString() };
  return b;
}

function decide(run: Run, action: "approve" | "deny") {
  if (run.decision) return false;
  run.decision = action;
  run.decidedAt = Date.now();
  return true;
}

http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  const json = (code: number, body: unknown) => { res.writeHead(code, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  const m = url.pathname.match(/^\/incidents\/([^/]+)(?:\/(execution|decision))?$/);
  const now = Date.now();
  if (url.pathname === "/demo/arm" && req.method === "POST") {
    if (runs.some((r) => now - r.start < 120_000 && !timeline(r).every((t) => now >= t.end))) return json(409, { error: "A demo is already running — wait a couple of minutes and try again." });
    setTimeout(() => runs.push({ id: crypto.randomUUID(), start: Date.now() }), 9_000); // ~ alarm latency (shortened)
    return json(200, { armed: true, version: "3" });
  }
  if (url.pathname === "/orders") return json(502, { error: "inventory returned 500" });
  if (url.pathname === "/incidents") return json(200, [...runs.map((r) => bundle(r, now).META), ...past].reverse().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  if (url.pathname === "/approve-link") { // stands in for the Lambda Function URL
    const run = runs.find((r) => r.id === url.searchParams.get("incidentId"));
    const ok = run && decide(run, url.searchParams.get("action") === "deny" ? "deny" : "approve");
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(ok ? "<h1>Approved</h1><p>Remediation is proceeding.</p>" : "<p>This incident was already decided.</p>");
  }
  if (m) {
    const run = runs.find((r) => r.id === m[1]);
    if (!run) {
      const old = past.find((p) => p.incidentId === m[1]);
      return old && !m[2] ? json(200, { META: old }) : json(404, { error: "Incident not found" });
    }
    if (m[2] === "execution") {
      const events = history(run, now);
      const steps = buildSteps(events);
      return json(200, { executionArn: `arn:aws:states:ap-south-1:000000000000:execution:IncidentResponseDay3:${run.id}`, name: run.id, status: events.some((e) => e.type === "ExecutionSucceeded") ? "SUCCEEDED" : events.some((e) => e.type === "ExecutionFailed") ? "FAILED" : "RUNNING",
        startDate: new Date(run.start).toISOString(), consoleUrl: "https://ap-south-1.console.aws.amazon.com/states/home", steps, events: buildEvents(events) });
    }
    if (m[2] === "decision" && req.method === "POST") {
      let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
        const action = JSON.parse(body || "{}").action;
        if (!bundle(run, Date.now()).APPROVAL) return json(404, { error: "No approval request exists for this incident yet" });
        return decide(run, action === "deny" ? "deny" : "approve") ? json(200, { incidentId: run.id, decision: action === "deny" ? "denied" : "approved", decidedAt: iso() }) : json(409, { error: "Already decided" });
      });
      return;
    }
    return json(200, bundle(run, now));
  }
  json(404, { error: "not found" });
}).listen(PORT, () => console.log(`mock API on ${BASE}`));
