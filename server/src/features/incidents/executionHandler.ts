import { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  SFNClient,
  ListExecutionsCommand,
  DescribeExecutionCommand,
  GetExecutionHistoryCommand,
  HistoryEvent,
} from "@aws-sdk/client-sfn";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { getIncident } from "./incidentsRepository";
import { buildExecutionView } from "./executionView";

patchAwsSdkForTracing();
const sfn = new SFNClient({});

// incidentId -> executionArn. Survives across warm invocations, so the (expensive)
// lookup below runs once per incident per container.
const arnCache = new Map<string, string>();

// The state machine doesn't store which execution created an incident, so we match
// on the one field both sides share: the alarm timestamp (`detectedAt`). It is part of
// the execution input (see infra/lib/alarms.ts) and is copied verbatim into the
// incident's META row by CreateIncident. If that ever fails, fall back to the execution
// that started closest to the incident's createdAt (within 2 minutes).
async function locateExecution(stateMachineArn: string, meta: Record<string, unknown>): Promise<string | undefined> {
  const list = await sfn.send(new ListExecutionsCommand({ stateMachineArn, maxResults: 25 }));
  const recent = list.executions ?? [];

  const described = await Promise.all(
    recent.map((e) => sfn.send(new DescribeExecutionCommand({ executionArn: e.executionArn! })))
  );
  const exact = described.find((d) => {
    try {
      return JSON.parse((d as any).input ?? "{}").detectedAt === meta.detectedAt;
    } catch {
      return false;
    }
  });
  if ((exact as any)?.executionArn) return (exact as any).executionArn;

  const createdMs = Date.parse(String(meta.createdAt));
  return recent
    .filter((e) => e.startDate && Math.abs(createdMs - e.startDate.getTime()) < 120_000)
    .sort((a, b) => Math.abs(createdMs - a.startDate!.getTime()) - Math.abs(createdMs - b.startDate!.getTime()))[0]
    ?.executionArn;
}

async function fetchAllEvents(executionArn: string): Promise<HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let nextToken: string | undefined;
  do {
    const page = await sfn.send(
      new GetExecutionHistoryCommand({ executionArn, includeExecutionData: true, maxResults: 1000, nextToken })
    );
    events.push(...(page.events ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return events;
}

export async function handler(event: APIGatewayProxyEventV2) {
  const origin = (event.headers as any)?.origin ?? (event.headers as any)?.Origin;
  const incidentId = (event.pathParameters as any)?.id;
  if (!incidentId) return fail(400, "Missing incident id", origin);

  const stateMachineArn = process.env.STATE_MACHINE_ARN;
  if (!stateMachineArn) return fail(500, "STATE_MACHINE_ARN is not configured", origin);

  try {
    const meta = await getIncident(incidentId);
    if (!meta) return fail(404, "Incident not found", origin);

    let executionArn = arnCache.get(incidentId);
    if (!executionArn) {
      executionArn = await locateExecution(stateMachineArn, meta);
      if (!executionArn) return fail(404, "No matching Step Functions execution found", origin);
      arnCache.set(incidentId, executionArn);
    }

    const [desc, events] = await Promise.all([
      sfn.send(new DescribeExecutionCommand({ executionArn })),
      fetchAllEvents(executionArn),
    ]);
    return ok(buildExecutionView(desc, events, process.env.AWS_REGION ?? "ap-south-1"), origin);
  } catch (err) {
    return fail(500, (err as Error).message, origin);
  }
}
