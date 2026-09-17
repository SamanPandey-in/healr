import { Table, AttributeType, BillingMode } from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

export function createTables(scope: Construct) {
  const serviceGraph = new Table(scope, "ServiceGraphTable", {
    tableName: "ServiceGraph",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  const deployEvents = new Table(scope, "DeployEventsTable", {
    tableName: "DeployEvents",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  const incidents = new Table(scope, "IncidentsTable", {
    tableName: "Incidents",
    partitionKey: { name: "PK", type: AttributeType.STRING },
    sortKey: { name: "SK", type: AttributeType.STRING },
    billingMode: BillingMode.PAY_PER_REQUEST,
  });

  return { serviceGraph, deployEvents, incidents };
}