import { APIGatewayProxyEventV2 } from "aws-lambda";
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { getApproval, markApprovalDecided } from "../incidents/incidentsRepository";

patchAwsSdkForTracing();
const sfn = new SFNClient({});

// POST /incidents/{id}/decision   body: { "action": "approve" | "deny" }
//
// Same effect as clicking the emailed/Function-URL link (approveHandler.ts), but callable
// from the dashboard with CORS. The task token is read server-side from the APPROVAL row,
// so the browser never has to send it. The SendTaskSuccess payload is byte-for-byte the
// shape approveHandler.ts sends, because `Remediate` consumes it as its input.
export async function handler(event: APIGatewayProxyEventV2) {
  const origin = (event.headers as any)?.origin ?? (event.headers as any)?.Origin;
  const incidentId = (event.pathParameters as any)?.id;
  if (!incidentId) return fail(400, "Missing incident id", origin);

  let action: unknown;
  try {
    action = JSON.parse(event.body ?? "{}").action;
  } catch {
    return fail(400, "Body must be JSON: { \"action\": \"approve\" | \"deny\" }", origin);
  }
  if (action !== "approve" && action !== "deny") {
    return fail(400, "action must be \"approve\" or \"deny\"", origin);
  }

  const approval = await getApproval(incidentId);
  if (!approval) return fail(404, "No approval request exists for this incident yet", origin);
  if (approval.status !== "pending") return fail(409, `Already ${approval.status}`, origin);

  const taskToken = approval.taskToken as string;
  const diagnosis = approval.diagnosis as { rootCauseService?: string; rankedCandidates?: unknown } | undefined;
  const decidedAt = new Date().toISOString();

  try {
    if (action === "approve") {
      await sfn.send(
        new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify({
            incidentId,
            approved: true,
            rootCauseService: diagnosis?.rootCauseService,
            rankedCandidates: diagnosis?.rankedCandidates,
            decidedAt,
          }),
        })
      );
      await markApprovalDecided(incidentId, "approved");
    } else {
      await sfn.send(
        new SendTaskFailureCommand({ taskToken, error: "ApprovalDenied", cause: "Human denied remediation" })
      );
      await markApprovalDecided(incidentId, "denied");
    }
  } catch (err) {
    const name = (err as Error).name;
    // The execution already timed out (30 min) or was stopped: the token is dead.
    if (name === "TaskTimedOut" || name === "TaskDoesNotExist" || name === "InvalidToken") {
      return fail(410, `Approval request is no longer active (${name})`, origin);
    }
    return fail(500, (err as Error).message, origin);
  }

  return ok({ incidentId, decision: action === "approve" ? "approved" : "denied", decidedAt }, origin);
}
