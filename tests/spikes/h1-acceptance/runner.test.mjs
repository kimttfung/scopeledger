import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  H1AcceptanceError,
  assertReportSafe,
  parseArguments,
  parseBrowserSummary,
  parseTestSummary,
  runAcceptance,
  safeChildEnvironment,
  sanitizeText,
  validateAcceptanceManifest,
  validateRepositoryState,
} from "../../../scripts/run-h1-acceptance.mjs";

const repositoryRoot = path.resolve(".");
const fixedCommit = "9".repeat(40);
const passingTap = [
  "TAP version 13",
  "1..2",
  "# tests 2",
  "# pass 2",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "",
].join("\n");
const profile = Object.freeze({
  booleans: Object.freeze({
    environmentFile: true,
    localH1Profile: true,
    databaseConfigured: true,
    mailpitConfigured: true,
    objectRootConfigured: true,
    objectRootReady: true,
    accessSessionConfigured: true,
    auth0Configured: false,
    paypalSandboxConfigured: false,
    geminiConfigured: false,
  }),
  sensitiveValues: Object.freeze([]),
});

function fakeExecutor(overrides = {}) {
  return async ({ id }) => {
    if (id in overrides) return overrides[id];
    if (id === "git-commit") {
      return { exitCode: 0, stdout: `${fixedCommit}\n`, stderr: "" };
    }
    if (id === "git-status" || id === "git-status-after") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (id === "git-tracked-files") {
      return {
        exitCode: 0,
        stdout: [
          ".gitignore",
          "scripts/run-h1-acceptance.mjs",
          "tests/spikes/h1-acceptance/acceptance.json",
        ].join("\n"),
        stderr: "",
      };
    }
    if (id === "npm-version") {
      return { exitCode: 0, stdout: "11.12.1\n", stderr: "" };
    }
    if (id === "database-status") {
      return {
        exitCode: 0,
        stdout: '{"running":true,"version":"17.11"}',
        stderr: "",
      };
    }
    if (id === "mailpit-status") {
      return { exitCode: 0, stdout: '{"running":true}', stderr: "" };
    }
    if (["package-build", "typecheck", "lint"].includes(id)) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: passingTap, stderr: "" };
  };
}

function fakeDependencies(execute = fakeExecutor()) {
  return {
    execute,
    inspectLocalProfile: async () => profile,
    now: () => new Date("2026-11-12T18:00:00.000Z"),
    probeRoutes: async () => ({ running: false, healthy: true }),
    validateEvidenceManifests: async () => [
      "tests/spikes/h1-acceptance/acceptance.json",
      "tests/spikes/ordered-consent/acceptance.json",
    ],
    validateMigrationChain: async () => true,
  };
}

test("argument parsing defaults to quick and confines JSON evidence output", () => {
  const defaults = parseArguments([], repositoryRoot);
  assert.equal(defaults.mode, "quick");
  assert.equal(defaults.allowDirty, false);
  assert.equal(
    defaults.reportPath,
    ".scopeledger-local/evidence/h1-acceptance-quick.json",
  );
  const full = parseArguments([
    "--full",
    "--allow-dirty",
    "--output",
    ".scopeledger-local/evidence/judge.json",
  ], repositoryRoot);
  assert.equal(full.mode, "full");
  assert.equal(full.allowDirty, true);
  assert.equal(full.reportPath, ".scopeledger-local/evidence/judge.json");
});

test("argument parsing rejects ambiguous modes and unsafe output paths", () => {
  for (const arguments_ of [
    ["--quick", "--full"],
    ["--output"],
    ["--output", "report.json"],
    ["--output", ".scopeledger-local/evidence/report.txt"],
    ["--unknown"],
  ]) {
    assert.throws(
      () => parseArguments(arguments_, repositoryRoot),
      H1AcceptanceError,
    );
  }
});

test("only the browser suite receives the demo database disable gate", () => {
  assert.equal(
    safeChildEnvironment("correction-reissue").SCOPELEDGER_DEMO_DB_DISABLED,
    undefined,
  );
  assert.equal(
    safeChildEnvironment("browser-suite").SCOPELEDGER_DEMO_DB_DISABLED,
    "1",
  );
});

test("sanitization removes homes, credentials, recipients and provider references", () => {
  const raw = [
    "/Users/example/private/file",
    "client_secret=super-secret",
    "Bearer abc.def.ghi",
    "judge@example.test",
    "https://api.example.test/private",
    "ORDER-ABCDEF123456",
    "captureId=CAPTURE123",
  ].join(" ");
  const sanitized = sanitizeText(raw);
  for (const privateValue of [
    "/Users/example",
    "super-secret",
    "abc.def.ghi",
    "judge@example.test",
    "api.example.test",
    "ORDER-ABCDEF123456",
    "CAPTURE123",
  ]) {
    assert.equal(sanitized.includes(privateValue), false);
  }
});

test("report safety rejects secret-looking and configured private values", () => {
  assert.throws(
    () => assertReportSafe({ diagnostic: "password=not-public" }),
    (error) =>
      error instanceof H1AcceptanceError && error.code === "unsafe-report",
  );
  assert.throws(
    () => assertReportSafe({ diagnostic: "opaque-value" }, ["opaque-value"]),
    (error) =>
      error instanceof H1AcceptanceError && error.code === "unsafe-report",
  );
  assert.deepEqual(assertReportSafe({ safe: true }), { safe: true });
});

test("repository validation fails dirty trees and tracked private boundaries", () => {
  assert.deepEqual(validateRepositoryState({
    statusOutput: " M scripts/example.mjs\n",
    trackedFilesOutput: "scripts/example.mjs\n",
    privatePaths: ["guides", ".env.local"],
    allowDirty: false,
  }).failures, ["working-tree-dirty"]);
  assert.deepEqual(validateRepositoryState({
    statusOutput: " M scripts/example.mjs\n",
    trackedFilesOutput: "guides/private.md\n",
    privatePaths: ["guides", ".env.local"],
    allowDirty: true,
  }).failures, ["private-path-tracked"]);
});

test("runner reports dirty-tree and private-boundary preflight failures", async () => {
  const dirty = await runAcceptance(
    parseArguments(["--quick"], repositoryRoot),
    fakeDependencies(fakeExecutor({
      "git-status": {
        exitCode: 0,
        stdout: " M scripts/example.mjs\n",
        stderr: "",
      },
      "git-status-after": {
        exitCode: 0,
        stdout: " M scripts/example.mjs\n",
        stderr: "",
      },
    })),
  );
  assert.equal(dirty.result.passed, false);
  assert.equal(
    dirty.commands.find(({ id }) => id === "repository-state").failureCode,
    "working-tree-dirty",
  );

  const privateBoundary = await runAcceptance(
    parseArguments(["--quick", "--allow-dirty"], repositoryRoot),
    fakeDependencies(fakeExecutor({
      "git-tracked-files": {
        exitCode: 0,
        stdout: "guides/internal.md\n",
        stderr: "",
      },
    })),
  );
  assert.equal(privateBoundary.result.passed, false);
  assert.equal(
    privateBoundary.commands.find(({ id }) => id === "private-boundary")
      .failureCode,
    "private-path-tracked",
  );
});

test("required acceptance manifest validation rejects unsafe commands", () => {
  assert.throws(
    () => validateAcceptanceManifest({}),
    (error) =>
      error instanceof H1AcceptanceError
      && error.code === "invalid-acceptance-manifest",
  );
});

test("Playwright summaries are normalized for zero-skip enforcement", () => {
  assert.deepEqual(parseBrowserSummary([
    "  38 passed (4.2s)",
    "  1 skipped",
  ].join("\n")), {
    tests: 39,
    passed: 38,
    failed: 0,
    skipped: 1,
    cancelled: 0,
    todo: 0,
    summaries: 2,
    valid: true,
    ambiguous: false,
  });
});

test("Node 26 summaries parse across streams with ANSI controls", () => {
  const stdout = [
    "\u001b[36mℹ tests 65\u001b[39m",
    "\u001b[32mℹ pass 65\u001b[39m",
    "",
  ].join("\n");
  const stderr = [
    "\u001b[31mℹ fail 0\u001b[39m",
    "ℹ cancelled 0",
    "\u001b[33mℹ skipped 0\u001b[39m",
    "ℹ todo 0",
    "",
  ].join("\n");
  assert.deepEqual(parseTestSummary(stdout, stderr), {
    tests: 65,
    passed: 65,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
    summaries: 1,
    valid: true,
    ambiguous: false,
  });
});

test("runner accepts a complete Node 26 summary split across captured streams", async () => {
  const report = await runAcceptance(
    parseArguments(["--quick", "--allow-dirty"], repositoryRoot),
    fakeDependencies(fakeExecutor({
      "ordered-consent": {
        exitCode: 0,
        stdout: "\u001b[36mℹ tests 65\u001b[39m\nℹ pass 65\n",
        stderr: [
          "\u001b[31mℹ fail 0\u001b[39m",
          "ℹ cancelled 0",
          "\u001b[33mℹ skipped 0\u001b[39m",
          "ℹ todo 0",
          "",
        ].join("\n"),
      },
    })),
  );
  assert.equal(report.result.passed, true);
  assert.deepEqual(
    report.commands.find(({ id }) => id === "ordered-consent").counts,
    {
      tests: 65,
      passed: 65,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      todo: 0,
    },
  );
});

test("partial or arithmetically inconsistent summaries remain ambiguous", () => {
  const partial = parseTestSummary([
    "ℹ tests 65",
    "ℹ pass 65",
    "ℹ fail 0",
    "ℹ skipped 0",
  ].join("\n"));
  assert.equal(partial.valid, false);
  assert.equal(partial.ambiguous, true);

  const inconsistent = parseTestSummary([
    "# tests 2",
    "# pass 2",
    "# fail 1",
    "# cancelled 0",
    "# skipped 0",
    "# todo 0",
  ].join("\n"));
  assert.equal(inconsistent.valid, false);
  assert.equal(inconsistent.ambiguous, true);
});

test("injected quick dry acceptance is deterministic and sanitized", async () => {
  const options = parseArguments([
    "--quick",
    "--output",
    ".scopeledger-local/evidence/fake-quick.json",
  ], repositoryRoot);
  const first = await runAcceptance(options, fakeDependencies());
  const second = await runAcceptance(options, fakeDependencies());
  assert.deepEqual(first, second);
  assert.equal(first.result.passed, true);
  assert.deepEqual(first.result.tests, {
    tests: 8,
    passed: 8,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    todo: 0,
  });
  assert.equal(first.sideEffects.externalProviderWrites, false);
  assert.equal(first.sideEffects.financialEffects, false);
  assert.equal(JSON.stringify(first).includes(repositoryRoot), false);
});

test("required test skips fail the acceptance report", async () => {
  const skippedTap = passingTap
    .replace("# pass 2", "# pass 1")
    .replace("# skipped 0", "# skipped 1");
  const report = await runAcceptance(
    parseArguments(["--quick", "--allow-dirty"], repositoryRoot),
    fakeDependencies(fakeExecutor({
      "ordered-consent": {
        exitCode: 0,
        stdout: skippedTap,
        stderr: "",
      },
    })),
  );
  assert.equal(report.result.passed, false);
  const command = report.commands.find(({ id }) => id === "ordered-consent");
  assert.equal(command.status, "failed");
  assert.equal(command.failureCode, "required-test-skip");
});

test("command failures propagate and later proof commands do not run", async () => {
  const report = await runAcceptance(
    parseArguments(["--quick", "--allow-dirty"], repositoryRoot),
    fakeDependencies(fakeExecutor({
      "package-build": { exitCode: 2, stdout: "", stderr: "raw failure" },
    })),
  );
  assert.equal(report.result.passed, false);
  assert.equal(
    report.commands.find(({ id }) => id === "package-build").failureCode,
    "command-exit-nonzero",
  );
  assert.equal(
    report.commands.find(({ id }) => id === "typecheck").status,
    "skipped",
  );
  assert.equal(JSON.stringify(report).includes("raw failure"), false);
});
