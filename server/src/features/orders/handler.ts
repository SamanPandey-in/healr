import { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { patchAwsSdkForTracing, traced, traceHeaders } from "../../shared/aws/xray";
import { ok, fail } from "../../shared/http/responses";
import { env } from "../../config/env";
import { OrderRequest } from "@shi/shared-types";

patchAwsSdkForTracing();

export async function handler(event: APIGatewayProxyEventV2, _context: Context) {
  try {
    const body: OrderRequest = JSON.parse(event.body ?? "{}");

    const inventoryResult = await traced("call-inventory", async () => {
      const res = await fetch(env.inventoryFunctionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...traceHeaders() },
        body: JSON.stringify({ sku: body.sku, quantity: body.quantity }),
      });
      if (!res.ok) throw new Error(`inventory returned ${res.status}`);
      return res.json();
    });

    return ok({ orderId: body.orderId, status: "confirmed", inventoryResult });
  } catch (err) {
    return fail(502, (err as Error).message);
  }
}