import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOMATED_LIMITS,
  evaluateAutomatedAdmission,
  validateCandidateClaims,
} from "@scopeledger/analysis";
import {
  candidates,
  diagnosticCodes,
  errorCodes,
  must,
  partialPdf,
  pdfSource,
  run,
  source,
} from "./fixtures.js";

test("selected byte and page thresholds are exact decimal declared-record limits", () => {
  assert.deepEqual(AUTOMATED_LIMITS, {
    pdfBytesPerFile: 10_000_000,
    pdfPagesPerFile: 50,
    pdfPagesPerRun: 100,
    codePointsPerRun: 200_000,
    codePointsPerRequest: 10_000,
  });
  const record = pdfSource(50, 10_000_000);
  const value = must(evaluateAutomatedAdmission(run([record])));
  assert.equal(value.status, "local-validation-admitted");
  assert.equal(value.scope, "declared-extracted-records-only");
  assert.equal(value.modelDispatch, "not-authorized-by-this-module");
  assert.equal(value.totals.pdfPages, 50);
});

test("one byte over the per-file PDF threshold preserves all text and requires manual review", () => {
  const record = pdfSource(50, 10_000_001);
  const value = must(evaluateAutomatedAdmission(run([record])));
  assert.equal(value.status, "manual-required");
  assert.ok(diagnosticCodes(value).includes("PDF_FILE_BYTES_EXCEEDED"));
  assert.equal(value.sources[0]?.extractedText, record.extractedText);
  assert.equal(value.manualRoute, "complete-attributed-source-manifest-required");
});

test("51 declared PDF pages fail automated per-file admission", () => {
  const value = must(evaluateAutomatedAdmission(run([pdfSource(51)])));
  assert.equal(value.status, "manual-required");
  assert.ok(diagnosticCodes(value).includes("PDF_FILE_PAGES_EXCEEDED"));
});

test("aggregate PDF pages admit exactly 100 and reject 101 without dropping an amendment", () => {
  const records = [pdfSource(50), pdfSource(50, 100, "amendment-1")];
  const admitted = must(evaluateAutomatedAdmission(run(records)));
  assert.equal(admitted.status, "local-validation-admitted");
  assert.equal(admitted.totals.pdfPages, 100);
  const extra = pdfSource(1, 100, "amendment-2");
  const blocked = must(evaluateAutomatedAdmission(run([...records, extra])));
  assert.equal(blocked.status, "manual-required");
  assert.ok(diagnosticCodes(blocked).includes("RUN_PDF_PAGES_EXCEEDED"));
  assert.equal(blocked.sources.length, 3);
  assert.deepEqual(blocked.sources.map((entry) => entry.sourceId), ["source-1", "amendment-1", "amendment-2"]);
});

test("run code-point threshold includes request text and permits exactly 200,000", () => {
  const exact = source({ extractedText: "😀".repeat(199_999) });
  const value = must(evaluateAutomatedAdmission(run([exact], "x")));
  assert.equal(value.status, "local-validation-admitted");
  assert.equal(value.totals.sourceCodePoints, 199_999);
  assert.equal(value.totals.combinedCodePoints, 200_000);
  const above = source({ extractedText: `${exact.extractedText}x` });
  const blocked = must(evaluateAutomatedAdmission(run([above], "x")));
  assert.ok(diagnosticCodes(blocked).includes("RUN_CODE_POINTS_EXCEEDED"));
  assert.equal(blocked.sources[0]?.extractedText, above.extractedText);
});

test("aggregate text is counted across all supplied source versions", () => {
  const records = [
    source({ extractedText: "a".repeat(100_000) }),
    source({ sourceId: "amendment", extractedText: "b".repeat(99_999) }),
  ];
  assert.equal(must(evaluateAutomatedAdmission(run(records, "x"))).status, "local-validation-admitted");
  const above = must(evaluateAutomatedAdmission(run(records, "xy")));
  assert.equal(above.totals.combinedCodePoints, 200_001);
  assert.ok(diagnosticCodes(above).includes("RUN_CODE_POINTS_EXCEEDED"));
});

for (const kind of ["request", "correction"] as const) {
  test(`${kind} limit counts exactly 10,000 Unicode code points, not UTF-16 units`, () => {
    const record = source();
    const exact = run([record], "😀".repeat(10_000));
    assert.equal(must(evaluateAutomatedAdmission({
      ...exact, request: { ...exact.request, kind },
    })).status, "local-validation-admitted");
    const above = { ...exact, request: { kind, text: `${exact.request.text}x` } };
    const value = must(evaluateAutomatedAdmission(above));
    assert.equal(value.request.text, above.request.text);
    assert.equal(value.totals.requestCodePoints, 10_001);
    assert.ok(diagnosticCodes(value).includes("REQUEST_CODE_POINTS_EXCEEDED"));
  });
}

test("combining marks count separately toward request budgets", () => {
  const exact = "e\u0301".repeat(5_000);
  assert.equal(must(evaluateAutomatedAdmission(run([source()], exact))).status, "local-validation-admitted");
  assert.ok(diagnosticCodes(must(evaluateAutomatedAdmission(run([source()], `${exact}\u0301`)))).includes("REQUEST_CODE_POINTS_EXCEEDED"));
});

test("empty, unreadable and partial inventories return explicit manual routes", () => {
  const missing = must(evaluateAutomatedAdmission(run([])));
  assert.equal(missing.status, "manual-required");
  assert.ok(diagnosticCodes(missing).includes("MISSING_SOURCES"));
  const unavailable = source({
    extractedText: "",
    extraction: { status: "unavailable", unavailableReason: "No readable original is available." },
  });
  for (const record of [unavailable, partialPdf()]) {
    const value = must(evaluateAutomatedAdmission(run([record])));
    assert.equal(value.status, "manual-required");
    assert.ok(diagnosticCodes(value).includes("SOURCE_TEXT_UNAVAILABLE"));
    assert.equal(value.sources[0]?.extraction.status, record.extraction.status);
  }
});

test("declared image-only PDF pages stay explicit instead of becoming empty successful extraction", () => {
  const record = source({
    extractedText: "",
    extraction: { status: "unavailable", unavailableReason: "No readable text is declared for either page." },
    document: {
      format: "pdf",
      declaredByteLength: 100,
      declaredPageCount: 2,
      pages: [],
      unavailablePages: [
        { pageNumber: 1, reason: "Declared image-only page; no actual file inspection performed." },
        { pageNumber: 2, reason: "Declared image-only page; no actual file inspection performed." },
      ],
    },
  });
  const value = must(evaluateAutomatedAdmission(run([record])));
  assert.equal(value.status, "manual-required");
  assert.equal(value.totals.pdfPages, 2);
  assert.equal(value.sources[0]?.document.format, "pdf");
  if (value.sources[0]?.document.format === "pdf") {
    assert.deepEqual(value.sources[0].document.unavailablePages.map((page) => page.pageNumber), [1, 2]);
  }
});

for (const permission of ["denied", "unresolved"] as const) {
  test(`model permission ${permission} is blocked separately from studio sharing`, () => {
    const base = source();
    const record = source({
      permissions: { ...base.permissions, modelProcessing: permission },
    });
    const value = must(evaluateAutomatedAdmission(run([record])));
    assert.ok(diagnosticCodes(value).includes("MODEL_PROCESSING_NOT_PERMITTED"));
    assert.ok(!diagnosticCodes(value).includes("STUDIO_SHARING_NOT_PERMITTED"));
    assert.ok(errorCodes(validateCandidateClaims(candidates([record]), run([record]))).includes("LOCAL_ADMISSION_REQUIRED"));
  });

  test(`studio sharing ${permission} is not implied by model permission`, () => {
    const base = source();
    const record = source({
      permissions: { ...base.permissions, studioSharing: permission },
    });
    const value = must(evaluateAutomatedAdmission(run([record])));
    assert.ok(diagnosticCodes(value).includes("STUDIO_SHARING_NOT_PERMITTED"));
    assert.equal(value.status, "manual-required");
  });
}

for (const status of ["not-reviewed", "unresolved", "prohibited-financial-data"] as const) {
  test(`model-input review ${status} withholds original text without redaction or dispatch`, () => {
    const base = source();
    const record = source({
      extractedText: "Synthetic identifier embedded in original text; no detector is claimed.",
      permissions: { ...base.permissions, modelInputReview: { status } },
    });
    const value = must(evaluateAutomatedAdmission(run([record])));
    assert.equal(value.status, "manual-required");
    assert.equal(value.modelDispatch, "not-authorized-by-this-module");
    assert.ok(diagnosticCodes(value).includes("MODEL_INPUT_NOT_CLEARED"));
    assert.equal(value.sources[0]?.extractedText, record.extractedText);
  });
}

test("wrong project/workspace inventory and duplicate immutable versions are rejected", () => {
  const original = source();
  for (const record of [
    source({ projectId: "other-project" }),
    source({ workspaceId: "other-workspace" }),
  ]) {
    assert.equal(evaluateAutomatedAdmission(run([record])).ok, false);
  }
  assert.ok(errorCodes(evaluateAutomatedAdmission(run([original, original]))).includes("DUPLICATE_SOURCE_VERSION"));
  const changedTextSameVersion = source({ extractedText: "Changed text, same immutable version identifier." });
  assert.ok(errorCodes(evaluateAutomatedAdmission(run([original, changedTextSameVersion]))).includes("DUPLICATE_SOURCE_VERSION"));
});

test("all applicable versions are counted; accepted amendments and prior decisions have no payment filter", () => {
  const original = source();
  const amendment = source({
    sourceId: "amendment",
    provenance: { ...original.provenance, origin: "amendment" },
  });
  const decision = source({
    sourceId: "prior-decision",
    provenance: { ...original.provenance, origin: "prior-decision" },
  });
  const value = must(evaluateAutomatedAdmission(run([original, amendment, decision])));
  assert.equal(value.sources.length, 3);
  assert.equal(value.status, "local-validation-admitted");
  assert.equal(value.sources[1]?.provenance.acceptance.kind, "provider-attested-import");
});
