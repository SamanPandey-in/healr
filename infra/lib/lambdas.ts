import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime, Tracing, FunctionUrlAuthType } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import { Table } from "aws-cdk-lib/aws-dynamodb";
import { Duration } from "aws-cdk-lib";

interface LambdasProps {
  serviceGraph: Table;
  deployEvents: Table;
  incidents: Table;
}

export function createLambdas(scope: Construct, tables: LambdasProps) {
  const commonEnv = {
    SERVICE_GRAPH_TABLE: tables.serviceGraph.tableName,
    DEPLOY_EVENTS_TABLE: tables.deployEvents.tableName,
    INCIDENTS_TABLE: tables.incidents.tableName,
  };

  // aws-xray-sdk-core's captureAWSv3Client() reaches into @smithy/* internals via
  // dynamic require() calls that esbuild can't statically resolve. Left to the
  // default bundling behavior, those @smithy packages end up neither bundled nor
  // provided by the runtime, which is what throws
  // "Cannot find module '@smithy/service-error-classification'" at cold start.
  // Forcing aws-xray-sdk-core to be npm-installed (with its full dep tree) instead
  // of esbuild-bundled fixes it. Every function below calls patchAwsSdkForTracing(),
  // so every one needs this.
  const xrayBundling = { nodeModules: ["aws-xray-sdk-core"] };

  const inventoryFn = new NodejsFunction(scope, "InventoryFunction", {
    entry: "../server/src/features/inventory/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INJECT_FAULT: "false" },
    bundling: xrayBundling,
  });
  const inventoryUrl = inventoryFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

  const ordersFn = new NodejsFunction(scope, "OrdersFunction", {
    entry: "../server/src/features/orders/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, INVENTORY_FUNCTION_URL: inventoryUrl.url },
    bundling: xrayBundling,
  });
  const ordersUrl = ordersFn.addFunctionUrl({ authType: FunctionUrlAuthType.AWS_IAM });

  const gatewayFn = new NodejsFunction(scope, "GatewayFunction", {
    entry: "../server/src/features/gateway/handler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    timeout: Duration.seconds(10),
    environment: { ...commonEnv, ORDERS_FUNCTION_URL: ordersUrl.url },
    bundling: xrayBundling,
  });

  const deployEventsWebhookFn = new NodejsFunction(scope, "DeployEventsWebhookFunction", {
    entry: "../server/src/features/deploy-events/webhookHandler.ts",
    runtime: Runtime.NODEJS_20_X,
    tracing: Tracing.ACTIVE,
    environment: commonEnv,
    bundling: xrayBundling,
  });

  tables.serviceGraph.grantReadWriteData(gatewayFn);
  tables.deployEvents.grantReadWriteData(deployEventsWebhookFn);
  tables.incidents.grantReadWriteData(gatewayFn);

  return { gatewayFn, ordersFn, inventoryFn, deployEventsWebhookFn };
}