import { APIGatewayProxyResult } from "aws-lambda";

const ALLOWED_ORIGINS = ["https://builds.samanp.xyz", "http://localhost:3000"];

function corsHeaders(origin?: string) {
  const allowOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allowOrigin, "Content-Type": "application/json" };
}

export function ok(body: unknown, origin?: string): APIGatewayProxyResult {
  return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(body) };
}

export function fail(statusCode: number, message: string, origin?: string): APIGatewayProxyResult {
  return { statusCode, headers: corsHeaders(origin), body: JSON.stringify({ error: message }) };
}
