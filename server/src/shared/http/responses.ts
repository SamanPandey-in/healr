import { APIGatewayProxyResult } from "aws-lambda";

export function ok(body: unknown): APIGatewayProxyResult {
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function fail(statusCode: number, message: string): APIGatewayProxyResult {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }) };
}