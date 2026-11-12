import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  ParserError,
  extractPdf,
  sealParsedPdfSource,
} from "@scopeledger/parser-adapter";

async function pdf(pages: readonly string[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const value of pages) {
    const page = document.addPage([612, 792]);
    page.drawText(value, {
      x: 48,
      y: 720,
      size: 12,
      font,
    });
  }
  return document.save();
}

test("extracts complete contiguous text and page ranges in a separate process", async () => {
  process.env.SCOPELEDGER_PRIVATE_SECRET = "must-not-enter-parser-output";
  const input = await pdf(["Included layout.", "Additional populated page."]);
  const parsed = await extractPdf(input);
  assert.equal(parsed.declaredPageCount, 2);
  assert.equal(parsed.pages[0]?.start, 0);
  assert.equal(parsed.pages[1]?.start, parsed.pages[0]?.end);
  assert.equal(parsed.pages[1]?.end, Array.from(parsed.extractedText).length);
  assert.match(parsed.extractedText, /Included layout/);
  assert.match(parsed.extractedText, /Additional populated page/);
  assert.equal(parsed.extractedText.includes("must-not-enter-parser-output"), false);
  delete process.env.SCOPELEDGER_PRIVATE_SECRET;
});

test("rejects non-PDF bytes and files over the exact limit before dispatch", async () => {
  await assert.rejects(
    () => extractPdf(new TextEncoder().encode("not a PDF")),
    (error: unknown) => error instanceof ParserError
      && error.code === "TYPE_MISMATCH",
  );
  const oversized = new Uint8Array(10_000_001);
  oversized.set(new TextEncoder().encode("%PDF-1.7"));
  await assert.rejects(
    () => extractPdf(oversized),
    (error: unknown) => error instanceof ParserError
      && error.code === "FILE_TOO_LARGE",
  );
});

test("rejects malformed PDFs and declared page counts above 50", async () => {
  await assert.rejects(
    () => extractPdf(new TextEncoder().encode("%PDF-1.7 malformed")),
    (error: unknown) => error instanceof ParserError
      && error.code === "PARSER_FAILED",
  );
  const manyPages = await pdf(Array.from({ length: 51 }, (_, index) => `Page ${index + 1}`));
  await assert.rejects(
    () => extractPdf(manyPages),
    (error: unknown) => error instanceof ParserError
      && error.code === "PAGE_LIMIT_EXCEEDED",
  );
});

test("invalid timeout configuration fails before parsing", async () => {
  const input = await pdf(["Timeout configuration."]);
  await assert.rejects(
    () => extractPdf(input, { timeoutMilliseconds: 1 }),
    (error: unknown) => error instanceof ParserError
      && error.code === "INVALID_INPUT",
  );
});

test("parser output seals into the immutable source contract without granting model authority", async () => {
  const parsed = await extractPdf(await pdf(["Synthetic agreement text."]));
  const sealed = sealParsedPdfSource(parsed, {
    workspaceId: "workspace",
    projectId: "project",
    sourceId: "source",
    versionId: "v1",
    provenance: {
      origin: "agreement",
      suppliedBy: "provider",
      recordedAt: "2026-11-11T12:00:00Z",
      claimedDate: null,
      effectiveDate: null,
      acceptance: {
        kind: "provider-attested-import",
        attestedBy: "provider",
        basis: "Synthetic parser integration fixture.",
      },
      originReference: null,
      extractorReference: "caller-value-must-be-replaced",
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "unresolved",
      modelInputReview: { status: "not-reviewed" },
    },
  });
  assert.equal(sealed.ok, true);
  if (!sealed.ok) return;
  assert.equal(
    sealed.value.provenance.extractorReference,
    "scopeledger.pdfjs.v1",
  );
  assert.equal(sealed.value.permissions.modelProcessing, "unresolved");
  assert.equal(sealed.value.permissions.modelInputReview.status, "not-reviewed");
  assert.ok(Object.isFrozen(sealed.value));
});
