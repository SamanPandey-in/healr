import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, Tracing } from "aws-cdk-lib/aws-lambda";
import { RestApi, LambdaIntegration } from "aws-cdk-lib/aws-apigateway";
import { StateMachine } from "aws-cdk-lib/aws-stepfunctions";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Duration } from "aws-cdk-lib";

interface ObservabilityProps {
  api: RestApi;
  stateMachine: StateMachine;
  tables: { serviceGraph: Table; deployEvents: Table; incidents: Table };
}

// Purely additive: two new Lambdas and two new routes under the existing
// /incidents/{id} resource. Nothing that already exists is modified.
export function createObservability(scope: Construct, { api, stateMachine, tables }: ObservabilityProps) {
  // server/src/config/env.ts requires all three table names at import time.
  const commonEnv = {
    SERVICE_GRAPH_TABLE: tables.serviceGraph.tableName,
    DEPLOY_EVENTS_TABLE: tables.deployEvents.tableName,
    INCIDENTS_TABLE: tables.incidents.tableName,
  };
  const bundling = { nodeModules: ["aws-xray-sdk-core"] };

  const getExecutionFn = new NodejsFunction(scope, "GetExecutionFunction", {
    entry: "../server/src/features/incidents/executionHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(20),
    environment: { ...commonEnv, STATE_MACHINE_ARN: stateMachine.stateMachineArn },
    bundling,
  });
  tables.incidents.grantReadData(getExecutionFn);
  stateMachine.grantRead(getExecutionFn); // ListExecutions / DescribeExecution / GetExecutionHistory

  const decisionFn = new NodejsFunction(scope, "DecisionFunction", {
    entry: "../server/src/features/approval/decisionHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling,
  });
  tables.incidents.grantReadWriteData(decisionFn);
  // Same grant the existing ApproveHandlerFunction has (SendTask* has no resource-level scoping).
  decisionFn.addToRolePolicy(
    new PolicyStatement({ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] })
  );

  const incident = api.root.getResource("incidents")!.getResource("{id}")!;
  incident.addResource("execution").addMethod("GET", new LambdaIntegration(getExecutionFn));
  incident.addResource("decision").addMethod("POST", new LambdaIntegration(decisionFn));

  return { getExecutionFn, decisionFn };
}
