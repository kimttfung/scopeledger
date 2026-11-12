import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateAutomatedAdmission,
  evaluateCoverageManifest,
  sourceReference,
} from "@scopeledger/analysis";
import {
  diagnosticCodes,
  errorCodes,
  humanReview,
  inventory,
  manifest,
  must,
  partialPdf,
  pdfSource,
  run,
  source,
} from "./fixtures.js";

test("complete above-limit manual manifests retain all sources without admitting automation", () => {
  const records = [pdfSource(51), pdfSource(50, 100, "amendment")];
  assert.equal(must(evaluateAutomatedAdmission(run(records))).status, "manual-required");
  const value = must(evaluateCoverageManifest(manifest(records), inventory(records)));
  assert.equal(value.publicationEligibility, "not-blocked-by-local-source-coverage");
  assert.deepEqual(value.diagnostics, []);
  assert.equal(value.sources.length, 2);
  assert.equal(value.manifest.entries[1]?.disposition.status, "reviewed");
});

test("manual review needs no model permission and preserves human-authored provenance", () => {
  const base = source();
  const record = source({ permissions: { ...base.permissions, modelProcessing: "denied" } });
  const value = must(evaluateCoverageManifest(manifest([record]), inventory([record])));
  assert.equal(value.publicationEligibility, "not-blocked-by-local-source-coverage");
  const disposition = value.manifest.entries[0]?.disposition;
  assert.equal(disposition?.status, "reviewed");
  if (disposition?.status === "reviewed") {
    assert.equal(disposition.review.provenance, "human-authored/manual-preparation");
  }
});

test("missing and duplicate entries cannot masquerade as complete coverage", () => {
  const records = [source(), source({ sourceId: "applicable-amendment" })];
  const missing = must(evaluateCoverageManifest(manifest([records[0]!]), inventory(records)));
  assert.equal(missing.publicationEligibility, "blocked");
  assert.ok(diagnosticCodes(missing).includes("MANIFEST_COVERAGE_INCOMPLETE"));
  const complete = manifest(records);
  const duplicate = must(evaluateCoverageManifest({
    ...complete,
    entries: [...complete.entries, complete.entries[0]],
  }, inventory(records)));
  assert.ok(diagnosticCodes(duplicate).includes("MANIFEST_COVERAGE_INCOMPLETE"));
});

for (const materiality of ["material", "unknown", "non-material"] as const) {
  test(`${materiality} unresolved context remains explicit with appropriate publication diagnostics`, () => {
    const record = source();
    const value = must(evaluateCoverageManifest({
      ...manifest([record]),
      entries: [{
        source: sourceReference(record),
        materiality,
        disposition: { status: "unresolved", reason: "An earlier promise needs human reconciliation." },
      }],
    }, inventory([record])));
    assert.equal(value.publicationEligibility, materiality === "non-material"
      ? "not-blocked-by-local-source-coverage"
      : "blocked");
    assert.equal(value.manifest.entries[0]?.disposition.status, "unresolved");
    assert.ok(diagnosticCodes(value).includes(materiality === "non-material"
      ? "NONMATERIAL_SOURCE_UNRESOLVED"
      : "SOURCE_UNRESOLVED"));
  });
}

test("inapplicability is explicitly attributed rather than deleting the source", () => {
  const record = source();
  const value = must(evaluateCoverageManifest({
    ...manifest([record]),
    entries: [{
      source: sourceReference(record),
      materiality: "material",
      disposition: {
        status: "inapplicable",
        reason: "Human review identifies a different engagement; not applicable to this request.",
        review: humanReview,
      },
    }],
  }, inventory([record])));
  assert.equal(value.sources.length, 1);
  assert.equal(value.publicationEligibility, "not-blocked-by-local-source-coverage");
});

test("valid supersession names an available reviewed replacement and a human basis", () => {
  const old = source();
  const current = source({ versionId: "version-2" });
  const complete = manifest([old, current]);
  const value = must(evaluateCoverageManifest({
    ...complete,
    entries: [{
      source: sourceReference(old),
      materiality: "material",
      disposition: {
        status: "superseded",
        by: sourceReference(current),
        reason: "Synthetic explicit human-reviewed replacement, not inferred from dates.",
        review: humanReview,
      },
    }, complete.entries[1]],
  }, inventory([old, current])));
  assert.equal(value.publicationEligibility, "not-blocked-by-local-source-coverage");
  assert.equal(value.sources.length, 2);
});

test("a complete attributed supersession chain may terminate at a reviewed version", () => {
  const records = [source(), source({ versionId: "version-2" }), source({ versionId: "version-3" })];
  const complete = manifest(records);
  const value = must(evaluateCoverageManifest({
    ...complete,
    entries: complete.entries.map((entry, index) => {
      const next = records[index + 1];
      return next === undefined ? entry : {
        ...entry,
        disposition: {
          status: "superseded",
          by: sourceReference(next),
          reason: "Synthetic attributed replacement chain.",
          review: humanReview,
        },
      };
    }),
  }, inventory(records)));
  assert.equal(value.publicationEligibility, "not-blocked-by-local-source-coverage");
  assert.equal(value.sources.length, 3);
});

test("supersession cannot point to itself, a missing version, wrong project, or a cycle", () => {
  const first = source();
  const second = source({ versionId: "version-2" });
  const complete = manifest([first, second]);
  for (const target of [
    sourceReference(first),
    { ...sourceReference(second), versionId: "missing" },
    { ...sourceReference(second), projectId: "other-project" },
  ]) {
    const value = must(evaluateCoverageManifest({
      ...complete,
      entries: [{
        ...complete.entries[0],
        disposition: { status: "superseded", by: target, reason: "Synthetic claimed replacement.", review: humanReview },
      }, complete.entries[1]],
    }, inventory([first, second])));
    assert.equal(value.publicationEligibility, "blocked");
    assert.ok(diagnosticCodes(value).includes("INVALID_SUPERSESSION"));
  }
  const cycle = must(evaluateCoverageManifest({
    ...complete,
    entries: complete.entries.map((entry, index) => ({
      ...entry,
      disposition: {
        status: "superseded",
        by: sourceReference(index === 0 ? second : first),
        reason: "Synthetic cycle must not be accepted.",
        review: humanReview,
      },
    })),
  }, inventory([first, second])));
  assert.ok(diagnosticCodes(cycle).includes("INVALID_SUPERSESSION"));
});

test("supersession chains must terminate at reviewed context, not unresolved or inapplicable entries", () => {
  const first = source();
  const second = source({ versionId: "version-2" });
  const complete = manifest([first, second]);
  for (const disposition of [
    { status: "unresolved", reason: "The replacement is not reviewed." },
    { status: "inapplicable", reason: "The replacement is not applicable.", review: humanReview },
  ]) {
    const value = must(evaluateCoverageManifest({
      ...complete,
      entries: [{
        ...complete.entries[0],
        disposition: {
          status: "superseded",
          by: sourceReference(second),
          reason: "Claimed replacement.",
          review: humanReview,
        },
      }, { ...complete.entries[1], disposition }],
    }, inventory([first, second])));
    assert.ok(diagnosticCodes(value).includes("INVALID_SUPERSESSION"));
  }
});

test("marking a partial or unavailable source reviewed cannot clear a missing-context blocker", () => {
  const unavailable = source({
    extractedText: "",
    extraction: { status: "unavailable", unavailableReason: "Original missing." },
  });
  for (const record of [partialPdf(), unavailable]) {
    const value = must(evaluateCoverageManifest(manifest([record]), inventory([record])));
    assert.equal(value.publicationEligibility, "blocked");
    assert.ok(diagnosticCodes(value).includes("SOURCE_TEXT_UNAVAILABLE"));
  }
});

test("both supporting and charge-weakening human evidence review confirmations are necessary", () => {
  const record = source();
  const complete = manifest([record]);
  const entry = complete.entries[0]!;
  for (const field of ["supportingEvidenceReviewed", "chargeWeakeningEvidenceReviewed"]) {
    const value = must(evaluateCoverageManifest({
      ...complete,
      entries: [{ ...entry, disposition: { ...entry.disposition, [field]: false } }],
    }, inventory([record])));
    assert.equal(value.publicationEligibility, "blocked");
    assert.ok(diagnosticCodes(value).includes("EVIDENCE_REVIEW_INCOMPLETE"));
  }
});

test("studio-sharing restrictions apply to manual reviews independently of model permission", () => {
  const base = source();
  const record = source({ permissions: { ...base.permissions, studioSharing: "denied" } });
  const value = must(evaluateCoverageManifest(manifest([record]), inventory([record])));
  assert.equal(value.publicationEligibility, "blocked");
  assert.ok(diagnosticCodes(value).includes("STUDIO_SHARING_NOT_PERMITTED"));
});

test("manifest association, source references and empty inventories cannot create eligibility", () => {
  const record = source();
  const complete = manifest([record]);
  assert.ok(errorCodes(evaluateCoverageManifest({
    ...complete, projectId: "other-project",
  }, inventory([record]))).includes("WRONG_PROJECT"));
  const unknown = must(evaluateCoverageManifest({
    ...complete,
    entries: [{
      ...complete.entries[0],
      source: { ...sourceReference(record), versionId: "unknown-version" },
    }],
  }, inventory([record])));
  assert.equal(unknown.publicationEligibility, "blocked");
  assert.ok(diagnosticCodes(unknown).includes("SOURCE_VERSION_NOT_FOUND"));
  assert.equal(must(evaluateCoverageManifest(manifest([]), inventory([]))).publicationEligibility, "blocked");
});

test("inapplicable/superseded entries cannot omit their reason and review provenance", () => {
  const record = source();
  const complete = manifest([record]);
  for (const disposition of [
    { status: "inapplicable", reason: "" },
    { status: "superseded", by: sourceReference(record), reason: "Claimed replacement." },
    { status: "reviewed", representation: "manual-context-reviewed" },
  ]) {
    assert.equal(evaluateCoverageManifest({
      ...complete,
      entries: [{ ...complete.entries[0], disposition }],
    }, inventory([record])).ok, false);
  }
});
