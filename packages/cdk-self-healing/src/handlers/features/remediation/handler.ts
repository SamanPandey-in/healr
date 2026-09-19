import { LambdaClient, ListVersionsByFunctionCommand, UpdateAliasCommand, GetAliasCommand } from "@aws-sdk/client-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveRemediation } from "../incidents/incidentsRepository";
import { env } from "../../config/env";
import { ApprovalOutcome, RemediationResult, ServiceName } from "../types";

patchAwsSdkForTracing();
const lambdaClient = new LambdaClient({});

export async function handler(input: ApprovalOutcome): Promise<RemediationResult> {
  if (!input.approved) {
    throw new Error("REMEDIATION_NOT_APPROVED: incident " + input.incidentId);
  }

  const functionName = env.protectedFunctionName;
  const aliasName = env.protectedAliasName;

  if (!functionName) {
    throw new Error("NO_REMEDIATION_TARGET: PROTECTED_FUNCTION_NAME env var not set");
  }

  const alias = await lambdaClient.send(new GetAliasCommand({ FunctionName: functionName, Name: aliasName }));
  const currentVersion = alias.FunctionVersion!;

  const versions = await lambdaClient.send(new ListVersionsByFunctionCommand({ FunctionName: functionName }));
  const published = (versions.Versions ?? [])
    .map((v) => v.Version!)
    .filter((v) => v !== "$LATEST")
    .sort((a, b) => Number(a) - Number(b));

  const currentIndex = published.indexOf(currentVersion);
  const previousVersion = currentIndex > 0 ? published[currentIndex - 1] : null;
  if (!previousVersion) {
    throw new Error(
      "NO_PREVIOUS_VERSION: " + functionName + " alias '" + aliasName + "' is already at " +
      "its oldest published version (" + currentVersion + ") — nothing to roll back to."
    );
  }

  await lambdaClient.send(new UpdateAliasCommand({
    FunctionName: functionName,
    Name: aliasName,
    FunctionVersion: previousVersion,
  }));

  const result: RemediationResult = {
    incidentId: input.incidentId,
    service: input.rootCauseService,
    action: "lambda-alias-rollback",
    revertedFromVersion: currentVersion,
    revertedToVersion: previousVersion,
    remediatedAt: new Date().toISOString(),
  };
  await saveRemediation(result);
  return result;
}
