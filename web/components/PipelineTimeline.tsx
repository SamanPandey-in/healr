"use client";
import { useState } from "react";
import { fmtClock, fmtDuration } from "@/lib/format";
import { useNow } from "@/lib/usePoll";
import type { ViewStep } from "@/lib/types";
import { Icon } from "./Icon";
import { JsonView } from "./JsonView";

const STATUS_TEXT: Record<ViewStep["status"], string> = {
  pending: "Pending", running: "Running", waiting: "Waiting", succeeded: "Succeeded", failed: "Failed",
};

function Node({ status }: { status: ViewStep["status"] }) {
  return (
    <span className={`node node-${status}`}>
      {status === "succeeded" && <Icon name="check" size={14} />}
      {status === "failed" && <Icon name="x" size={14} />}
      {status === "waiting" && <Icon name="pause" size={13} />}
    </span>
  );
}

function StepBody({ step }: { step: ViewStep }) {
  const [tab, setTab] = useState<"input" | "output" | "error">(step.status === "failed" ? "error" : "output");
  const hasError = !!(step.error || step.cause);
  return (
    <div className="step-detail">
      <div className="tabs">
        <button className={tab === "input" ? "on" : ""} onClick={() => setTab("input")}>Input</button>
        <button className={tab === "output" ? "on" : ""} onClick={() => setTab("output")}>Output</button>
        {hasError && <button className={`${tab === "error" ? "on " : ""}bad`} onClick={() => setTab("error")}>Error</button>}
      </div>
      {tab === "input" && <JsonView value={step.input} empty="No input recorded" />}
      {tab === "output" && (
        <JsonView value={step.output} empty={step.status === "succeeded" ? "Empty output" : "Waiting for this state to finish…"} />
      )}
      {tab === "error" && <JsonView value={{ error: step.error, cause: step.cause }} />}
    </div>
  );
}

export function PipelineTimeline({ steps }: { steps: ViewStep[] }) {
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const live = steps.some((s) => s.status === "running" || s.status === "waiting");
  const now = useNow(live);

  return (
    <ol className="timeline">
      {steps.map((s, i) => {
        const isOpen = override[s.name] ?? (s.status === "failed" || s.status === "waiting");
        const canOpen = s.status !== "pending";
        const elapsed =
          s.durationMs ?? (s.enteredAt && (s.status === "running" || s.status === "waiting") ? now - Date.parse(s.enteredAt) : undefined);
        const next = steps[i + 1];
        const flowing = s.status === "succeeded" && next && (next.status === "running" || next.status === "waiting");
        return (
          <li key={s.name} className={`step step-${s.status}`}>
            <div className="rail">
              <Node status={s.status} />
              {next && <span className={`wire${s.status === "succeeded" ? " wire-done" : ""}${flowing ? " wire-flow" : ""}`} />}
            </div>
            <div className="step-main">
              <button className="step-head" disabled={!canOpen} onClick={() => canOpen && setOverride({ ...override, [s.name]: !isOpen })}>
                <div className="step-title">
                  <span className="step-index">{String(i + 1).padStart(2, "0")}</span>
                  <strong>{s.label}</strong>
                  <code className="state-name">{s.name}</code>
                  {s.attempts > 1 && <span className="tag tag-amber">attempt {s.attempts}</span>}
                </div>
                <div className="step-meta">
                  <span className={`status-text st-${s.status}`}>{STATUS_TEXT[s.status]}</span>
                  <span className="mono dim">{s.enteredAt ? fmtClock(s.enteredAt) : ""}</span>
                  <span className="mono dur">{fmtDuration(elapsed)}</span>
                  {canOpen && <span className={`chev${isOpen ? " chev-open" : ""}`}><Icon name="chevron" size={14} /></span>}
                </div>
              </button>
              <div className="step-sub">
                <span>{s.blurb}</span>
                <span className="tag">{s.aws}</span>
              </div>
              {s.status === "waiting" && s.waitingOn === "callback" && (
                <div className="notice notice-amber">
                  <Icon name="pause" size={14} /> Execution is paused. It resumes when a human calls <code>SendTaskSuccess</code> with the task token.
                </div>
              )}
              {s.status === "waiting" && s.waitingOn === "timer" && s.timerSeconds && s.enteredAt && (
                <div className="timer">
                  <div className="bar"><i style={{ width: `${Math.min(100, ((now - Date.parse(s.enteredAt)) / (s.timerSeconds * 1000)) * 100)}%` }} /></div>
                  <span className="mono dim">{Math.max(0, Math.ceil(s.timerSeconds - (now - Date.parse(s.enteredAt)) / 1000))}s remaining</span>
                </div>
              )}
              {s.status === "failed" && (
                <div className="notice notice-red"><Icon name="x" size={14} /> {s.error ?? "Failed"}{s.cause ? ` — ${s.cause}` : ""}</div>
              )}
              {isOpen && canOpen && <StepBody key={`${s.name}-${s.status}`} step={s} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
