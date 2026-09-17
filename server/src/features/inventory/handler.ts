import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { maybeInjectFault } from "./faultInjection";
import { InventoryCheckRequest } from "./types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: InventoryCheckRequest = JSON.parse(event.body ?? "{}");
    await maybeInjectFault();

    const result = { sku: body.sku, available: true, quantityOnHand: 42 };
    return ok(result);
  } catch (err) {
    return fail(500, (err as Error).message);
  }
}