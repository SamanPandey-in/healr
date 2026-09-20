import { Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { createTables } from "./tables";
import { createLambdas } from "./lambdas";
import { createApi } from "./api-gateway";
import { createIncidentResponseStateMachine } from "./step-functions";
import { createInventoryAlarmAndRule } from "./alarms";

export class SelfHealingInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = createTables(this);
    const lambdas = createLambdas(this, tables);
    const api = createApi(this, lambdas.gatewayFn, lambdas.armDemoFn, lambdas.getIncidentFn, lambdas.listIncidentsFn);

    const stateMachine = createIncidentResponseStateMachine(this, {
      createIncidentFn: lambdas.createIncidentFn,
      buildGraphFn: lambdas.buildGraphFn,
      localizeFn: lambdas.localizeFn,
      diagnoseFn: lambdas.diagnoseFn,
      requestApprovalFn: lambdas.requestApprovalFn,
      remediateFn: lambdas.remediateFn,
      verifyOutcomeFn: lambdas.verifyOutcomeFn,
    });
    createInventoryAlarmAndRule(this, lambdas.inventoryFn, stateMachine);

    new CfnOutput(this, "ApproveFunctionUrl", { value: lambdas.approveHandlerUrl });
    new CfnOutput(this, "ApiUrl", { value: api.url });
  }
}
