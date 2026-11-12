import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  executeAnalysisUpload,
  validateAnalysisFormData,
} from "../../../apps/web/app/api/analysis/analysis-service.js";
import { analysisParserRuntime } from "../../../apps/web/app/api/analysis/runtime-parser.js";
import type {
  AnalysisRunInput,
  AnalysisSourceVersionInput,
} from "@scopeledger/db";

const runId = "33333333-3333-4333-8333-333333333333";
const subjectDigest = "c".repeat(64);

async function syntheticPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText("Synthetic provider analysis boundary.", {
    x: 48,
    y: 720,
    size: 12,
    font,
  });
  return document.save();
}

test("web analysis runtime parses a real multipart PDF through the ESM worker", async () => {
  const persisted: Array<Readonly<{
    source: AnalysisSourceVersionInput;
    run: AnalysisRunInput;
  }>> = [];
  const bytes = await syntheticPdf();
  const formData = new FormData();
  formData.set("file", new File(
    [new Uint8Array(bytes)],
    "synthetic-runtime.pdf",
    { type: "application/pdf" },
  ));
  formData.set("contentAttested", "true");
  formData.set("geminiPermitted", "false");
  const validation = validateAnalysisFormData(formData);
  assert.equal(validation.ok, true);
  if (!validation.ok) return;
  const execution = await executeAnalysisUpload(
    validation.value,
    {
      extractPdf: analysisParserRuntime.extractPdf,
      sealParsedPdfSource: analysisParserRuntime.sealParsedPdfSource,
      generateCandidates: async () => {
        throw new Error("Gemini must not run in parser-only regression");
      },
      requestedBySubjectDigest: subjectDigest,
      persistRun: async (input) => {
        persisted.push(input);
      },
      newRunId: () => runId,
      now: () => new Date("2026-11-12T06:30:00.000Z"),
    },
  );

  assert.equal(execution.status, 200);
  assert.equal(execution.body.ok, true);
  if (!execution.body.ok) return;
  assert.match(
    persisted[0]?.source.exactText ?? "",
    /Synthetic provider analysis boundary/,
  );
  assert.equal(execution.body.run.runId, runId);
  assert.equal(execution.body.run.status, "manual-review-ready");
});
