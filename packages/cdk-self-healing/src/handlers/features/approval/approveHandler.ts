import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { getApproval, markApprovalDecided } from "../incidents/incidentsRepository";

patchAwsSdkForTracing();
const sfn = new SFNClient({});

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  const qs = event.queryStringParameters ?? {};
  const { incidentId, token, action } = qs;
  if (!incidentId || !token || !action) {
    return { statusCode: 400, body: "Missing incidentId, token or action" };
  }

  const approval = await getApproval(incidentId);
  if (approval?.status && approval.status !== "pending") {
    return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: "<p>This incident was already " + approval.status + ".</p>" };
  }

  const diagnosis = approval?.diagnosis as { rootCauseService?: string; rankedCandidates?: unknown } | undefined;

  if (action === "approve") {
    await sfn.send(new SendTaskSuccessCommand({
      taskToken: token,
      output: JSON.stringify({
        incidentId,
        approved: true,
        rootCauseService: diagnosis?.rootCauseService,
        rankedCandidates: diagnosis?.rankedCandidates,
        decidedAt: new Date().toISOString(),
      }),
    }));
    await markApprovalDecided(incidentId, "approved");
    return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: "<h1>Approved</h1><p>Remediation is proceeding.</p>" };
  }

  await sfn.send(new SendTaskFailureCommand({ taskToken: token, error: "ApprovalDenied", cause: "Human denied remediation" }));
  await markApprovalDecided(incidentId, "denied");
  return { statusCode: 200, headers: { "Content-Type": "text/html" }, body: "<h1>Denied</h1><p>No remediation action was taken.</p>" };
}
