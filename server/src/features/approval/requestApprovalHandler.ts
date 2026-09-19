import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveApproval } from "../incidents/incidentsRepository";
import { DiagnosisResult } from "@shi/shared-types";
import { env } from "../../config/env";

patchAwsSdkForTracing();

interface RequestApprovalEvent {
  taskToken: string;
  diagnosis: DiagnosisResult;
}

export async function handler(event: RequestApprovalEvent): Promise<{ dispatched: true }> {
  const { taskToken, diagnosis } = event;
  await saveApproval({ incidentId: diagnosis.incidentId, taskToken, status: "pending", diagnosis, approveLink, denyLink });

  const base = env.approveFunctionUrl.replace(/\/$/, "");
  const approveLink = `${base}?incidentId=${diagnosis.incidentId}&token=${encodeURIComponent(taskToken)}&action=approve`;
  const denyLink = `${base}?incidentId=${diagnosis.incidentId}&token=${encodeURIComponent(taskToken)}&action=deny`;

  console.log(JSON.stringify({
    message: "INCIDENT_APPROVAL_REQUIRED",
    incidentId: diagnosis.incidentId,
    rootCauseService: diagnosis.rootCauseService,
    summary: diagnosis.summary,
    confidence: diagnosis.confidence,
    approveLink,
    denyLink,
  }));

  return { dispatched: true };
}
