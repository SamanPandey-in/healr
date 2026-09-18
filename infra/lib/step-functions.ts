import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import {
  StateMachine, DefinitionBody, JsonPath, IntegrationPattern, TaskInput, Wait, WaitTime,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import { IFunction } from "aws-cdk-lib/aws-lambda";

interface IncidentResponseProps {
  createIncidentFn: IFunction;
  buildGraphFn: IFunction;
  localizeFn: IFunction;
  diagnoseFn: IFunction;
  requestApprovalFn: IFunction;
  remediateFn: IFunction;
  verifyOutcomeFn: IFunction;
}

export function createIncidentResponseStateMachine(scope: Construct, fns: IncidentResponseProps) {
  const createIncident = new LambdaInvoke(scope, "CreateIncident", { lambdaFunction: fns.createIncidentFn, payloadResponseOnly: true });
  const buildGraph = new LambdaInvoke(scope, "BuildGraph", { lambdaFunction: fns.buildGraphFn, payloadResponseOnly: true });
  const localize = new LambdaInvoke(scope, "LocalizeRootCause", { lambdaFunction: fns.localizeFn, payloadResponseOnly: true });

  const diagnose = new LambdaInvoke(scope, "DiagnoseWithBedrock", {
    lambdaFunction: fns.diagnoseFn,
    payloadResponseOnly: true,
  });

  const requestApproval = new LambdaInvoke(scope, "RequestApproval", {
    lambdaFunction: fns.requestApprovalFn,
    integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
    payload: TaskInput.fromObject({
      taskToken: JsonPath.taskToken,
      diagnosis: JsonPath.entirePayload,
    }),
    taskTimeout: { seconds: Duration.minutes(30).toSeconds() } as any,
  });

  const remediate = new LambdaInvoke(scope, "Remediate", { lambdaFunction: fns.remediateFn, payloadResponseOnly: true });
  const settle = new Wait(scope, "WaitForMetricsToSettle", { time: WaitTime.duration(Duration.seconds(60)) });
  const verify = new LambdaInvoke(scope, "VerifyOutcome", { lambdaFunction: fns.verifyOutcomeFn, payloadResponseOnly: true });

  const definition = createIncident
    .next(buildGraph)
    .next(localize)
    .next(diagnose)
    .next(requestApproval)
    .next(remediate)
    .next(settle)
    .next(verify);

  return new StateMachine(scope, "IncidentResponseStateMachine", {
    stateMachineName: "IncidentResponseDay3",
    definitionBody: DefinitionBody.fromChainable(definition),
    timeout: Duration.minutes(40),
  });
}
