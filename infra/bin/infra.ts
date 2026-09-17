#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { SelfHealingInfraStack } from "../lib/self-healing-infra-stack";

const app = new App();
new SelfHealingInfraStack(app, "SelfHealingInfraStack", {
  env: { region: "ap-south-1" },
});