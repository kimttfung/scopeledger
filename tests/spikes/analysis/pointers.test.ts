import assert from "node:assert/strict";
import test from "node:test";
import {
  codePointLength,
  validateCandidateClaims,
  validateSourcePointer,
} from "@scopeledger/analysis";
import {
  candidates,
  diagnosticCodes,
  errorCodes,
  must,
  partialPdf,
  pointer,
  run,
  source,
} from "./fixtures.js";

test("exact ASCII pointers use half-open code-point ranges, including the final point", () => {
  const record = source({ extractedText: " A\nB " });
  const result = must(validateSourcePointer(pointer(record, 1, 4), run([record])));
  assert.equal(result.quote, "A\nB");
  assert.equal(result.validation, "source-pointer-validated");
  assert.equal(result.semanticMeaning, "not-validated");
  assert.equal(must(validateSourcePointer(pointer(record, 4, 5), run([record]))).quote, " ");
});

test("non-BMP and combining marks retain their original code-point offsets", () => {
  const record = source({ extractedText: "A😀e\u0301中Z" });
  assert.equal(record.extractedText.length, 7);
  assert.equal(codePointLength(record.extractedText), 6);
  assert.equal(must(validateSourcePointer(pointer(record, 1, 2), run([record]))).quote, "😀");
  assert.equal(must(validateSourcePointer(pointer(record, 2, 4), run([record]))).quote, "e\u0301");
  assert.equal(must(validateSourcePointer(pointer(record, 3, 4), run([record]))).quote, "\u0301");
  const utf16Pointer = { ...pointer(record, 2, 4), start: 3, end: 5 };
  assert.ok(errorCodes(validateSourcePointer(utf16Pointer, run([record]))).includes("POINTER_QUOTE_MISMATCH"));
});

for (const [label, start, end] of [
  ["empty", 1, 1],
  ["reversed", 3, 1],
  ["beyond end", 0, 5],
  ["off-by-one at end", 4, 5],
  ["negative", -1, 1],
  ["fractional", 0.5, 1],
  ["NaN", NaN, 1],
  ["infinite", 0, Infinity],
  ["unsafe integer", 0, Number.MAX_SAFE_INTEGER + 1],
] as const) {
  test(`invalid ${label} range is rejected without pointer repair`, () => {
    const record = source({ extractedText: "abcd" });
    const result = validateSourcePointer({ ...pointer(record), start, end }, run([record]));
    assert.equal(result.ok, false);
  });
}

for (const [label, text, quote] of [
  ["normalization", "e\u0301", "é"],
  ["case folding", "AB", "ab"],
  ["trimming", " AB ", "AB"],
  ["smart quote substitution", "“yes”", "\"yes\""],
  ["newline normalization", "A\r\nB", "A\nB"],
] as const) {
  test(`quote comparison never performs ${label}`, () => {
    const record = source({ extractedText: text });
    assert.ok(errorCodes(validateSourcePointer({ ...pointer(record), quote }, run([record]))).includes("POINTER_QUOTE_MISMATCH"));
  });
}

test("wrong workspace, project, source and exact version references are rejected", () => {
  const record = source();
  for (const [field, value, code] of [
    ["workspaceId", "workspace-other", "WRONG_WORKSPACE"],
    ["projectId", "project-other", "WRONG_PROJECT"],
    ["sourceId", "source-other", "SOURCE_VERSION_NOT_FOUND"],
    ["versionId", "version-other", "SOURCE_VERSION_NOT_FOUND"],
  ] as const) {
    const citation = { ...pointer(record), source: { ...pointer(record).source, [field]: value } };
    assert.ok(errorCodes(validateSourcePointer(citation, run([record]))).includes(code));
  }
});

test("partial and unavailable sources cannot validate even readable individual quotes", () => {
  const record = partialPdf();
  assert.ok(errorCodes(validateSourcePointer(pointer(record, 0, 1), run([record]))).includes("LOCAL_ADMISSION_REQUIRED"));
  const unavailable = source({
    extractedText: "",
    extraction: { status: "unavailable", unavailableReason: "Original text unavailable." },
  });
  const citation = { ...pointer(unavailable), end: 1, quote: "invented" };
  assert.ok(errorCodes(validateSourcePointer(citation, run([unavailable]))).includes("SOURCE_TEXT_UNAVAILABLE"));
});

test("candidate evidence preserves both polarities and never clears human publication review", () => {
  const record = source({ extractedText: "Added page. Layout already included." });
  const input = candidates([record]);
  const claim = input.claims[0]!;
  const value = must(validateCandidateClaims({
    ...input,
    claims: [{
      ...claim,
      supportingEvidence: [pointer(record, 0, 11)],
      chargeWeakeningEvidence: [{ ...pointer(record, 12, 36), polarity: "charge-weakening" }],
    }],
  }, run([record])));
  assert.equal(value.claims[0]?.chargeWeakeningEvidence[0]?.quote, "Layout already included.");
  assert.equal(value.claims[0]?.counterEvidenceObservation, "cited");
  assert.equal(value.claims[0]?.reviewState, "human-review-required");
  assert.equal(value.publicationEligibility, "blocked");
  assert.ok(diagnosticCodes(value).includes("HUMAN_REVIEW_REQUIRED"));
});

test("absence of cited counter-evidence is explicitly limited to admitted sources", () => {
  const record = source();
  const value = must(validateCandidateClaims(candidates([record]), run([record])));
  assert.equal(value.claims[0]?.counterEvidenceObservation, "none-cited-in-admitted-sources");
  assert.equal(value.coverage.counterEvidenceScope, "admitted-sources-only");
});

test("candidate gaps remain explicit and block publication", () => {
  const record = source();
  const input = candidates([record]);
  const value = must(validateCandidateClaims({
    ...input,
    coverage: { ...input.coverage, missingContext: ["Earlier client promise unavailable."] },
  }, run([record])));
  assert.ok(diagnosticCodes(value).includes("CANDIDATE_CONTEXT_GAP"));
  assert.deepEqual(value.coverage.missingContext, ["Earlier client promise unavailable."]);
});

test("applicable amendments must appear in candidate coverage even without cited text", () => {
  const original = source();
  const amendment = source({ sourceId: "amendment-1", versionId: "amendment-v1" });
  assert.ok(errorCodes(validateCandidateClaims(candidates([original]), run([original, amendment]))).includes("CANDIDATE_COVERAGE_INCOMPLETE"));
  assert.equal(validateCandidateClaims(candidates([original, amendment]), run([original, amendment])).ok, true);
});

test("candidate coverage rejects duplicate, stale and wrong-project references", () => {
  const record = source();
  const input = candidates([record]);
  for (const references of [
    [pointer(record).source, pointer(record).source],
    [{ ...pointer(record).source, versionId: "stale-version" }],
    [{ ...pointer(record).source, projectId: "wrong-project" }],
  ]) {
    assert.equal(validateCandidateClaims({
      ...input,
      coverage: { ...input.coverage, sources: references },
    }, run([record])).ok, false);
  }
});

test("candidate identifiers must be unique and root association must match", () => {
  const record = source();
  const input = candidates([record]);
  assert.ok(errorCodes(validateCandidateClaims({
    ...input,
    claims: [input.claims[0], input.claims[0]],
  }, run([record]))).includes("DUPLICATE_CLAIM"));
  assert.ok(errorCodes(validateCandidateClaims({ ...input, projectId: "other-project" }, run([record]))).includes("WRONG_PROJECT"));
});

test("unverifiable evidence withholds the entire candidate instead of removing its bad citation", () => {
  const record = source();
  const input = candidates([record]);
  const claim = input.claims[0]!;
  const result = validateCandidateClaims({
    ...input,
    claims: [{
      ...claim,
      chargeWeakeningEvidence: [{ ...pointer(record), quote: "invented", polarity: "charge-weakening" }],
    }],
  }, run([record]));
  assert.ok(errorCodes(result).includes("POINTER_QUOTE_MISMATCH"));
});

test("there is no source lookup or URL fetch, including for missing versions", () => {
  let fetchCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    fetchCalls += 1;
    throw new Error("Network access must not occur.");
  };
  try {
    const base = source();
    const record = source({
      provenance: { ...base.provenance, originReference: "https://example.invalid/private-source" },
    });
    assert.equal(validateCandidateClaims(candidates([record]), run([record])).ok, true);
    assert.equal(validateSourcePointer({
      ...pointer(record),
      source: { ...pointer(record).source, versionId: "missing-version" },
    }, run([record])).ok, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
