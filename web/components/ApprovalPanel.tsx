"use client";
import { useState } from "react";
import { ApiError, decideIncident } from "@/lib/api";
import { fmtClock, middleTruncate } from "@/lib/format";
import type { Approval, ViewStep } from "@/lib/types";
import { Icon } from "./Icon";

interface Props {
  incidentId: string;
  approval?: Approval;
  approvalStep?: ViewStep;
  rootCause?: string; // fallback when the APPROVAL row has no embedded diagnosis
  onDecided: () => void;
}

export function ApprovalPanel({ incidentId, approval, approvalStep, rootCause, onDecided }: Props) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState<"approve" | "deny" | null>(null);

  const gateReached = !!approvalStep && approvalStep.status !== "pending";
  if (!approval && !gateReached) return null;

  // Show the outcome immediately after a successful click; the next poll confirms it.
  const recorded = approval?.status ?? "pending";
  const status = recorded !== "pending" ? recorded : sent ? (sent === "approve" ? "approved" : "denied") : "pending";
  const root = approval?.diagnosis?.rootCauseService ?? rootCause;

  async function decide(action: "approve" | "deny") {
    setBusy(action);
    setError("");
    try {
      await decideIncident(incidentId, action);
      setSent(action);
      onDecided();
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409 ? "Someone already decided this request." : e instanceof Error ? e.message : String(e);
      setError(`${msg} You can still use the approval link below.`);
      onDecided();
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`card approval approval-${status}`}>
      <header className="card-head">
        <span className="eyebrow"><Icon name="shield" size={14} /> Human-in-the-loop gate</span>
        {status === "pending" && <span className="pill pill-amber"><span className="dot dot-pulse" />Waiting for decision</span>}
        {status === "approved" && <span className="pill pill-green"><span className="dot" />Approved</span>}
        {status === "denied" && <span className="pill pill-red"><span className="dot" />Denied</span>}
      </header>

      {status === "pending" && (
        <>
          <h3>Approve automatic remediation?</h3>
          <p className="dim">
            Nothing changes in production until you decide. Approving resumes the paused Step Functions execution, which will
            roll back the <code>{root ?? "affected"}</code> Lambda alias to its previous published version.
          </p>
          {root && root !== "inventory" && (
            <div className="notice notice-amber">Only <code>inventory</code> has a rollback target configured — approving a <code>{root}</code> root cause will fail the Remediate step.</div>
          )}
          {!approval?.approveLink ? (
            <div className="notice notice-blue"><span className="spinner" /> Generating the approval link…</div>
          ) : (
            <>
              <div className="actions">
                <button className="btn btn-approve" disabled={busy !== null} onClick={() => decide("approve")}>
                  {busy === "approve" ? <span className="spinner" /> : <Icon name="check" size={16} />}
                  {busy === "approve" ? "Sending SendTaskSuccess…" : "Approve remediation"}
                </button>
                <button className="btn btn-ghost-red" disabled={busy !== null} onClick={() => decide("deny")}>
                  {busy === "deny" ? <span className="spinner" /> : <Icon name="x" size={16} />} Deny
                </button>
              </div>
              <div className="linkbox">
                <div className="linkbox-label"><Icon name="link" size={13} /> Approval link (Lambda Function URL → <code>SendTaskSuccess</code>)</div>
                <div className="linkbox-row">
                  <a className="mono" href={approval.approveLink} target="_blank" rel="noreferrer" title="Opens the link — clicking it approves the request">
                    {middleTruncate(approval.approveLink)}
                  </a>
                  <button className="icon-btn" title="Copy full link" onClick={() => {
                    navigator.clipboard?.writeText(approval.approveLink!).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
                  }}><Icon name={copied ? "check" : "copy"} size={14} /></button>
                  <a className="icon-btn" href={approval.approveLink} target="_blank" rel="noreferrer" title="Approve via link"><Icon name="external" size={14} /></a>
                </div>
              </div>
            </>
          )}
          {error && <div className="notice notice-red">{error}</div>}
        </>
      )}

      {status === "approved" && (
        <p>
          Approved at <span className="mono">{fmtClock(approval?.decidedAt)}</span>. <code>SendTaskSuccess</code> resumed the paused execution, and <strong>Remediate</strong> took over.
        </p>
      )}
      {status === "denied" && (
        <p>Denied at <span className="mono">{fmtClock(approval?.decidedAt)}</span>. <code>SendTaskFailure</code> ended the execution; no remediation was performed.</p>
      )}
    </section>
  );
}
