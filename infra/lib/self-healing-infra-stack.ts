import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { createTables } from "./tables";
import { createLambdas } from "./lambdas";
import { createApi } from "./api-gateway";

export class SelfHealingInfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const tables = createTables(this);
    const lambdas = createLambdas(this, tables);
    createApi(this, lambdas.gatewayFn);
  }
}