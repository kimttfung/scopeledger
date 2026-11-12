import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider UIs show server-derived remaining and blocked states", async () => {
  const [authoring, sourceAnalysis, pdfAnalysis] = await Promise.all([
    readFile(
      "apps/web/app/provider/authoring/authoring-workspace.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/source-analysis/source-analysis-workspace.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/analysis/analysis-upload.tsx",
      "utf8",
    ),
  ]);

  assert.match(authoring, /sourceLimits\.remainingCount/u);
  assert.match(authoring, /sourceLimits\.remainingBytes/u);
  assert.match(authoring, /Source admission limit reached/u);
  assert.match(sourceAnalysis, /project\.controls\.remainingRuns/u);
  assert.match(sourceAnalysis, /project\.controls\.remainingModelCalls/u);
  assert.match(sourceAnalysis, /Save manual fallback/u);
  assert.match(pdfAnalysis, /limits\.remainingRuns/u);
  assert.match(pdfAnalysis, /limits\.remainingModelCalls/u);
  assert.match(pdfAnalysis, /save manual fallback/u);
});

test("browser requests cannot provide, increase, or reset evaluator limits", async () => {
  const [authoring, sourceAnalysis, pdfAnalysis] = await Promise.all([
    readFile(
      "apps/web/app/provider/authoring/authoring-workspace.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/source-analysis/source-analysis-workspace.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/analysis/analysis-upload.tsx",
      "utf8",
    ),
  ]);
  const browserCode = `${authoring}\n${sourceAnalysis}\n${pdfAnalysis}`;
  assert.doesNotMatch(
    browserCode,
    /data\.set\(["'](?:limit|budget|remaining|reset)/u,
  );
  assert.doesNotMatch(
    browserCode,
    /body:\s*JSON\.stringify\(\{[^}]*?(?:limit|budget|remaining|reset)/su,
  );
  assert.doesNotMatch(browserCode, /internal cost|cost estimate/iu);
});
