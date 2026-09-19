import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { recordDeployEvent } from "./deployEventsRepository";
import { DeployEvent } from "../types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: DeployEvent = JSON.parse(event.body ?? "{}");
    await recordDeployEvent(body);
    return ok({ recorded: true });
  } catch (err) {
    return fail(500, (err as Error).message);
  }
}
