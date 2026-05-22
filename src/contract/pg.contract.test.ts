import {
  authFlowTestSuite,
  caseInsensitiveTestSuite,
  testAdapter,
} from "@better-auth/test-utils/adapter";
import { describe } from "vitest";
import { createContractContext } from "./harness";

describe("contract:pg", async () => {
  const ctx = createContractContext("pg");
  const { execute } = await testAdapter({
    adapter: ctx.adapter,
    runMigrations: ctx.runMigrations,
    overrideBetterAuthOptions: ctx.overrideBetterAuthOptions,
    tests: [
      caseInsensitiveTestSuite(),
      authFlowTestSuite(),
    ],
    onFinish: ctx.onFinish,
  });
  execute();
});
