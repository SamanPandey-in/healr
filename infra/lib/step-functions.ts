import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { StateMachine, DefinitionBody, JsonPath } from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { IFunction } from "aws-cdk-lib/aws-lambda";

interface IncidentResponseProps {
  createIncidentFn: IFunction;
  buildGraphFn: IFunction;
  localizeFn: IFunction;
}

export function createIncidentResponseStateMachine(scope: Construct, fns: IncidentResponseProps) {
  const createIncident = new LambdaInvoke(scope, "CreateIncident", {
    lambdaFunction: fns.createIncidentFn,
    payloadResponseOnly: true, // unwrap the Lambda's return value directly into state
  });

  const buildGraph = new LambdaInvoke(scope, "BuildGraph", {
    lambdaFunction: fns.buildGraphFn,
    payloadResponseOnly: true,
  });

  const localize = new LambdaInvoke(scope, "LocalizeRootCause", {
    lambdaFunction: fns.localizeFn,
    payloadResponseOnly: true,
  });

  const definition = createIncident.next(buildGraph).next(localize);
  // Day 3 will insert DiagnoseWithBedrock, RequestApproval (waitForTaskToken),
  // Remediate, VerifyOutcome after `localize` here — don't build those states now.

  return new StateMachine(scope, "IncidentResponseStateMachine", {
    stateMachineName: "IncidentResponseDay2",
    definitionBody: DefinitionBody.fromChainable(definition),
    timeout: Duration.minutes(5),
  });
}