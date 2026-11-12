import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  H1_LOCAL_EXIT_CODES,
  createCommandRunner,
  parseEnvironment,
  runH1LocalStatus,
} from "../../../scripts/h1-local-core.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

test("local status integration is read-only and redacts configured values", async () => {
  const runner = createCommandRunner({ cwd: repositoryRoot });
  const environmentPath = path.join(repositoryRoot, ".env.local");
  const environmentBefore = await Promise.all([
    readFile(environmentPath, "utf8").catch(() => null),
    lstat(environmentPath).then((value) => value.mode).catch(() => null),
  ]);

  const response = await runH1LocalStatus({
    root: repositoryRoot,
    runner,
  });

  const environmentAfter = await Promise.all([
    readFile(environmentPath, "utf8").catch(() => null),
    lstat(environmentPath).then((value) => value.mode).catch(() => null),
  ]);
  assert.deepEqual(environmentAfter, environmentBefore);
  assert.equal(
    [
      H1_LOCAL_EXIT_CODES.ok,
      H1_LOCAL_EXIT_CODES.notReady,
      H1_LOCAL_EXIT_CODES.safety,
    ].includes(response.exitCode),
    true,
  );
  assert.equal(response.report.command, "status");
  assert.equal(response.report.profile, "local-reproducible");
  assert.equal(response.report.webCommand, "npm run dev");
  assert.equal(typeof response.report.services.postgres.ready, "boolean");
  assert.equal(typeof response.report.services.mailpit.ready, "boolean");
  assert.deepEqual(response.report.migrations.expected, [
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);

  const serialized = JSON.stringify(response.report);
  const localEnvironment = environmentBefore[0] ?? "";
  const values = parseEnvironment(localEnvironment).values;
  for (const name of [
    "AUTH0_CLIENT_SECRET",
    "AUTH0_SECRET",
    "PAYPAL_CLIENT_SECRET",
    "GEMINI_API_KEY",
    "ACCESS_SESSION_SECRET",
    "DEV_POSTGRES_PASSWORD",
    "SCOPELEDGER_DATABASE_URL",
  ]) {
    const value = values[name];
    if (value) assert.equal(serialized.includes(value), false, name);
  }
});
