import assert from "node:assert/strict";
import { File } from "node:buffer";
import test from "node:test";
import {
  MAX_MULTIPART_BYTES,
  executeAnalysisUpload,
  parserFailure,
  validateAnalysisFormData,
  validateAnalysisRequestHeaders,
} from "../../../apps/web/app/api/analysis/analysis-service.js";

function uploadFile(
  bytes = new TextEncoder().encode("%PDF-1.7 synthetic"),
  type = "application/pdf",
): File {
  return new File([bytes], "synthetic.pdf", { type });
}

function form(options: {
  attested?: string;
  gemini?: string;
  file?: File;
  extra?: boolean;
} = {}): FormData {
  const value = new FormData();
  value.set("file", options.file ?? uploadFile());
  value.set("contentAttested", options.attested ?? "true");
  value.set("geminiPermitted", options.gemini ?? "false");
  if (options.extra) value.set("workspaceId", "browser-controlled");
  return value;
}

const parsedPdf = {
  declaredByteLength: 20,
  declaredPageCount: 1,
  extractedText: "Included layout. Populated page is additional.",
  pages: [{ pageNumber: 1, start: 0, end: 46 }],
  unavailablePages: [],
  extractorReference: "scopeledger.pdfjs.v1",
} as const;

type TestSourceMetadata = {
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
  permissions: {
    modelProcessing: string;
    modelInputReview: { status: string };
  };
  [key: string]: unknown;
};

function sealedSource(input: unknown) {
  const metadata = input as TestSourceMetadata;
  return {
    schemaVersion: 1 as const,
    ...metadata,
    extractedText: parsedPdf.extractedText,
    extraction: { status: "complete" as const, unavailableReason: null },
  };
}

test("requires bounded multipart requests", () => {
  const valid = validateAnalysisRequestHeaders(new Headers({
    "content-type": "multipart/form-data; boundary=scopeledger",
    "content-length": "512",
  }));
  assert.equal(valid.ok, true);

  const missingLength = validateAnalysisRequestHeaders(new Headers({
    "content-type": "multipart/form-data; boundary=scopeledger",
  }));
  assert.deepEqual(missingLength, {
    ok: false,
    status: 411,
    code: "CONTENT_LENGTH_REQUIRED",
    message: "A bounded upload length is required.",
  });

  const oversized = validateAnalysisRequestHeaders(new Headers({
    "content-type": "multipart/form-data; boundary=scopeledger",
    "content-length": String(MAX_MULTIPART_BYTES + 1),
  }));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "FILE_TOO_LARGE");
});

test("accepts only the PDF and bounded attestation flags", () => {
  assert.equal(validateAnalysisFormData(form()).ok, true);

  const unattested = validateAnalysisFormData(form({ attested: "false" }));
  assert.equal(unattested.ok, false);
  if (!unattested.ok) {
    assert.equal(unattested.code, "CONTENT_ATTESTATION_REQUIRED");
  }

  const browserMetadata = validateAnalysisFormData(form({ extra: true }));
  assert.equal(browserMetadata.ok, false);
  if (!browserMetadata.ok) {
    assert.equal(browserMetadata.code, "UNEXPECTED_FORM_FIELD");
  }

  const nonPdf = validateAnalysisFormData(form({
    file: uploadFile(new TextEncoder().encode("plain text"), "text/plain"),
  }));
  assert.equal(nonPdf.ok, false);
  if (!nonPdf.ok) assert.equal(nonPdf.code, "PDF_REQUIRED");

  const oversized = validateAnalysisFormData(form({
    file: uploadFile(new Uint8Array(10_000_001)),
  }));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "FILE_TOO_LARGE");
});

test("parser-only execution seals fixed server metadata and never calls Gemini", async () => {
  const metadataInputs: unknown[] = [];
  let generated = 0;
  const execution = await executeAnalysisUpload(
    { file: uploadFile(), geminiPermitted: false },
    {
      extractPdf: async () => parsedPdf,
      sealParsedPdfSource: (_parsed, input) => {
        metadataInputs.push(input);
        return { ok: true, value: sealedSource(input) };
      },
      generateCandidates: async () => {
        generated += 1;
        throw new Error("must not run");
      },
      now: () => new Date("2026-11-11T12:00:00.000Z"),
    },
  );

  assert.equal(execution.status, 200);
  assert.equal(execution.body.ok, true);
  assert.equal(generated, 0);
  assert.equal(metadataInputs.length, 1);
  const metadata = metadataInputs[0] as TestSourceMetadata;
  assert.equal(metadata.workspaceId, "demo-provider-workspace");
  assert.equal(metadata.projectId, "synthetic-pdf-review");
  const permissions = metadata.permissions;
  assert.equal(permissions.modelProcessing, "denied");
  assert.equal(permissions.modelInputReview.status, "not-reviewed");
  if (execution.body.ok) {
    assert.equal(execution.body.parser.codePointCount, 46);
    assert.equal(execution.body.model.status, "not-requested");
    assert.equal(execution.body.model.publicationBlocked, true);
  }
});

test("Gemini opt-in returns exact quotes, polarity, and blocked review state", async () => {
  let run: unknown;
  const execution = await executeAnalysisUpload(
    { file: uploadFile(), geminiPermitted: true },
    {
      extractPdf: async () => parsedPdf,
      sealParsedPdfSource: (_parsed, metadata) => ({
        ok: true,
        value: sealedSource(metadata),
      }),
      generateCandidates: async (input) => {
        run = input;
        return {
          review: {
            claims: [{
              claimId: "claim-1",
              interpretation: "The populated page is described as additional.",
              supportingEvidence: [{
                source: {
                  workspaceId: "demo-provider-workspace",
                  projectId: "synthetic-pdf-review",
                  sourceId: "provider-upload",
                  versionId: "v1",
                },
                start: 17,
                end: 46,
                quote: "Populated page is additional.",
                polarity: "supporting",
              }],
              chargeWeakeningEvidence: [{
                source: {
                  workspaceId: "demo-provider-workspace",
                  projectId: "synthetic-pdf-review",
                  sourceId: "provider-upload",
                  versionId: "v1",
                },
                start: 0,
                end: 16,
                quote: "Included layout.",
                polarity: "charge-weakening",
              }],
              uncertainty: {
                status: "limited",
                explanation: "Provider interpretation is still required.",
                questions: ["Which source governs this request?"],
              },
              reviewState: "human-review-required",
            }],
            coverage: { missingContext: ["Original agreement not represented."] },
            publicationEligibility: "blocked",
          },
        };
      },
      now: () => new Date("2026-11-11T12:00:00.000Z"),
    },
  );

  assert.equal(execution.status, 200);
  assert.equal(execution.body.ok, true);
  const submittedRun = run as {
    workspaceId: string;
    projectId: string;
    sources: Array<{
      permissions: {
        modelProcessing: string;
        modelInputReview: { status: string };
      };
    }>;
  };
  assert.equal(submittedRun.workspaceId, "demo-provider-workspace");
  assert.equal(submittedRun.projectId, "synthetic-pdf-review");
  assert.equal(submittedRun.sources[0]?.permissions.modelProcessing, "permitted");
  assert.equal(
    submittedRun.sources[0]?.permissions.modelInputReview.status,
    "cleared",
  );
  if (execution.body.ok && execution.body.model.status === "completed") {
    assert.deepEqual(
      execution.body.model.candidates[0]?.evidence.map((item) => [
        item.quote,
        item.polarity,
      ]),
      [
        ["Populated page is additional.", "supporting"],
        ["Included layout.", "charge-weakening"],
      ],
    );
    assert.equal(
      execution.body.model.candidates[0]?.reviewState,
      "human-review-required",
    );
    assert.equal(execution.body.model.publicationBlocked, true);
  }
});

test("model failures retain parser results and an honest manual fallback", async () => {
  const execution = await executeAnalysisUpload(
    { file: uploadFile(), geminiPermitted: true },
    {
      extractPdf: async () => parsedPdf,
      sealParsedPdfSource: (_parsed, metadata) => ({
        ok: true,
        value: sealedSource(metadata),
      }),
      generateCandidates: async () => {
        throw Object.assign(new Error("provider detail must not escape"), {
          code: "PROVIDER_REJECTED",
        });
      },
    },
  );
  assert.equal(execution.status, 502);
  assert.equal(execution.body.ok, false);
  if (!execution.body.ok) {
    assert.equal(execution.body.code, "MODEL_PROCESSING_FAILED");
    assert.equal(execution.body.parser?.declaredPageCount, 1);
    assert.equal(execution.body.manualFallback.available, true);
    assert.equal(
      JSON.stringify(execution.body).includes("provider detail must not escape"),
      false,
    );
  }
});

test("parser failures map to stable safe codes", () => {
  const mismatch = parserFailure({ code: "TYPE_MISMATCH", secret: "hidden" });
  assert.equal(mismatch.status, 415);
  assert.equal(mismatch.body.code, "PDF_TYPE_MISMATCH");
  assert.equal(JSON.stringify(mismatch.body).includes("hidden"), false);

  const malformed = parserFailure({ code: "PARSER_FAILED" });
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.code, "PDF_PARSE_FAILED");
});
