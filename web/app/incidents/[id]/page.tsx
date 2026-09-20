"use client";
import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getExecution, getIncident } from "@/lib/api";
import { usePoll, useNow } from "@/lib/usePoll";
import { computeMetrics, deriveSteps, displayStatus, mergeSteps } from "@/lib/pipeline";
import { ago, fmtClock, fmtDuration } from "@/lib/format";
import { TopBar } from "@/components/TopBar";
import { StatusPill } from "@/components/StatusPill";
import { MetricsStrip } from "@/components/MetricsStrip";
import { PipelineTimeline } from "@/components/PipelineTimeline";
import { ApprovalPanel } from "@/components/ApprovalPanel";
import { DiagnosisPanel } from "@/components/DiagnosisPanel";
import { ServiceMap } from "@/components/ServiceMap";
import { OutcomePanel } from "@/components/OutcomePanel";
import { EventLog } from "@/components/EventLog";
import { Icon } from "@/components/Icon";

export default function IncidentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = use(params);
  const id = rawId ?? "";
  const [finished, setFinished] = useState(false);

  const execPoll = usePoll(() => getExecution(id), 1500, !finished && !!id);
  const incPoll = usePoll(() => getIncident(id), 2000, !finished && !!id);
  const exec = execPoll.data ?? undefined;
  const incident = incPoll.data ?? undefined;

  // Stop polling once the execution reaches a terminal state, after one last fetch of the rows.
  const execStatus = exec?.status;
  const closed = incident?.META?.status === "closed";
  const { refresh } = incPoll;
  useEffect(() => {
    if ((execStatus && execStatus !== "RUNNING") || (!execStatus && closed)) {
      refresh();
      setFinished(true);
    }
  }, [execStatus, closed, refresh]);

  const now = useNow(!finished, 1000);
  const steps = useMemo(
    () => mergeSteps(exec?.steps ?? (incident ? deriveSteps(incident) : [])),
    [exec, incident]
  );

  if (incPoll.data === null) {
    return (
      <main className="shell">
        <TopBar />
        <div className="card empty"><h2>Incident not found</h2><Link href="/" className="btn btn-primary">Back to dashboard</Link></div>
      </main>
    );
  }
  if (!incident) {
    return (
      <main className="shell">
        <TopBar />
        <div className="card empty">
          {incPoll.error ? <><h2>Can’t reach the API</h2><p className="dim">{incPoll.error}</p></> : <><span className="spinner spinner-lg" /><p className="dim">Loading incident…</p></>}
        </div>
      </main>
    );
  }

  const meta = incident.META;
  const status = displayStatus(incident, exec);
  const approvalStep = steps.find((s) => s.name === "RequestApproval");
  const recovered = closed && incident.VERIFICATION?.recovered;
  const stale = !!incPoll.error;

  return (
    <main className="shell">
      <TopBar>
        <span className={`live ${finished ? "live-off" : stale ? "live-warn" : ""}`}>
          <span className="dot dot-pulse" />
          {finished ? "Run finished" : stale ? "Reconnecting…" : "Live"}
        </span>
      </TopBar>

      <div className="page-head">
        <div>
          <Link href="/" className="back">← All incidents</Link>
          <h1>Incident <code className="id">{String(id ?? "").slice(0, 8) || "—"}</code></h1>
          <p className="dim">
            <strong>{meta?.alarmName}</strong> on <strong>{meta?.service}</strong> · detected {fmtClock(meta?.detectedAt)} ({ago(meta?.detectedAt, now)})
          </p>
        </div>
        <StatusPill label={status.label} tone={status.tone} pulse={!finished} />
      </div>

      {recovered && (
        <div className="banner banner-green">
          <Icon name="check" size={18} />
          <div>
            <strong>Self-healed.</strong> Detected, diagnosed with cited evidence, approved by a human, rolled back and verified —{" "}
            {fmtDuration(computeMetrics(incident, steps, now).at(-1)?.value)} from alarm to recovery.
          </div>
        </div>
      )}

      <MetricsStrip metrics={computeMetrics(incident, steps, now)} />

      <div className="source">
        {exec ? (
          <>
            <span className="tag tag-green">Live from Step Functions</span>
            <span className="mono dim">{exec.name}</span>
            <span className={`tag ${exec.status === "RUNNING" ? "tag-blue" : exec.status === "SUCCEEDED" ? "tag-green" : "tag-red"}`}>{exec.status}</span>
            <a className="ext" href={exec.consoleUrl} target="_blank" rel="noreferrer">Open in AWS console <Icon name="external" size={12} /></a>
          </>
        ) : (
          <>
            <span className="tag tag-amber">DynamoDB view</span>
            <span className="dim small">
              Step Functions history isn’t available{execPoll.error ? ` (${execPoll.error})` : ""} — progress is reconstructed from stored records.
            </span>
          </>
        )}
      </div>

      <div className="grid-2">
        <section>
          <h2 className="section-title">Step Functions pipeline <span className="dim small">· click a step to inspect its input and output</span></h2>
          <PipelineTimeline steps={steps} />
        </section>
        <aside className="stack">
          <ApprovalPanel
            incidentId={id}
            approval={incident.APPROVAL}
            approvalStep={approvalStep}
            rootCause={incident.DIAGNOSIS?.rootCauseService}
            onDecided={() => { incPoll.refresh(); execPoll.refresh(); }}
          />
          <DiagnosisPanel incident={incident} />
          <ServiceMap incident={incident} />
          <OutcomePanel incident={incident} />
        </aside>
      </div>

      {exec && <EventLog events={exec.events} />}
    </main>
  );
}
