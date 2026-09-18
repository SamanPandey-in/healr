import { LambdaClient, ListVersionsByFunctionCommand, UpdateAliasCommand, GetAliasCommand } from "@aws-sdk/client-lambda";
import { patchAwsSdkForTracing } from "../../shared/aws/xray";
import { saveRemediation } from "../incidents/incidentsRepository";
import { env } from "../../config/env";
import { ApprovalOutcome, RemediationResult, ServiceName } from "@shi/shared-types";

patchAwsSdkForTracing();
const lambdaClient = new LambdaClient({});

const REMEDIABLE_FUNCTIONS: Partial<Record<ServiceName, { functionName: string; aliasName: string }>> = {
  inventory: { functionName: env.inventoryFunctionName, aliasName: env.inventoryAliasName },
};

export async function handler(input: ApprovalOutcome): Promise<RemediationResult> {
  if (!input.approved) {
    throw new Error(`REMEDIATION_NOT_APPROVED: incident ${input.incidentId}`);
  }
  const target = REMEDIABLE_FUNCTIONS[input.rootCauseService];
  if (!target) {
    throw new Error(`NO_REMEDIATION_TARGET: no rollback configured for service '${input.rootCauseService}'`);
  }

  const alias = await lambdaClient.send(new GetAliasCommand({ FunctionName: target.functionName, Name: target.aliasName }));
  const currentVersion = alias.FunctionVersion!;

  const versions = await lambdaClient.send(new ListVersionsByFunctionCommand({ FunctionName: target.functionName }));
  const published = (versions.Versions ?? [])
    .map((v) => v.Version!)
    .filter((v) => v !== "$LATEST")
    .sort((a, b) => Number(a) - Number(b));

  const currentIndex = published.indexOf(currentVersion);
  const previousVersion = currentIndex > 0 ? published[currentIndex - 1] : null;
  if (!previousVersion) {
    throw new Error(
      `NO_PREVIOUS_VERSION: ${target.functionName} alias '${target.aliasName}' is already at ` +
      `its oldest published version (${currentVersion}) — nothing to roll back to. Either the ` +
      `fault was introduced in the FIRST published deploy, or you haven't published a second ` +
      `one yet — see plan3.md §14's test setup.`
    );
  }

  await lambdaClient.send(new UpdateAliasCommand({
    FunctionName: target.functionName,
    Name: target.aliasName,
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
