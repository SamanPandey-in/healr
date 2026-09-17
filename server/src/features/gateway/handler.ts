import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing, traced, traceHeaders } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body = JSON.parse(event.body ?? "{}");

    const orderResult = await traced("call-orders", async () => {
      const res = await fetch(env.ordersFunctionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...traceHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`orders returned ${res.status}`);
      return res.json();
    });

    return ok(orderResult);
  } catch (err) {
    return fail(502, (err as Error).message);
  }
}