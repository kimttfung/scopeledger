import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ExtractedSourceInputSchema,
  sealExtractedSourceVersion,
} from "@scopeledger/analysis";
import type {
  ExtractedSourceVersion,
  ValidationResult,
} from "@scopeledger/analysis";
import { z } from "zod";

const execute = promisify(execFile);
const MAX_PDF_BYTES = 10_000_000;
const MAX_PDF_PAGES = 50;
const MAX_OUTPUT_BYTES = 4_000_000;

export type ParserErrorCode =
  | "INVALID_INPUT"
  | "FILE_TOO_LARGE"
  | "TYPE_MISMATCH"
  | "PAGE_LIMIT_EXCEEDED"
  | "PARSER_TIMEOUT"
  | "PARSER_FAILED"
  | "PARSER_OUTPUT_INVALID";

export class ParserError extends Error {
  constructor(
    public readonly code: ParserErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ParserError";
  }
}

const pageSchema = z.strictObject({
  pageNumber: z.number().int().min(1).max(MAX_PDF_PAGES),
  start: z.number().int().min(0),
  end: z.number().int().min(0),
});

const extractionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  format: z.literal("pdf"),
  declaredByteLength: z.number().int().min(1).max(MAX_PDF_BYTES),
  declaredPageCount: z.number().int().min(1).max(MAX_PDF_PAGES),
  extractedText: z.string(),
  pages: z.array(pageSchema).min(1).max(MAX_PDF_PAGES),
  unavailablePages: z.array(z.strictObject({
    pageNumber: z.number().int().min(1).max(MAX_PDF_PAGES),
    reason: z.string().min(1).max(2_000),
  })).max(MAX_PDF_PAGES),
  extractorReference: z.literal("scopeledger.pdfjs.v1"),
}).superRefine((value, context) => {
  const points = Array.from(value.extractedText);
  let end = 0;
  for (const [index, page] of value.pages.entries()) {
    if (
      page.pageNumber !== index + 1
      || page.start !== end
      || page.end <= page.start
      || page.end > points.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pages", index],
        message: "PDF page ranges must be contiguous and exact",
      });
    }
    end = page.end;
  }
  if (
    value.pages.length + value.unavailablePages.length !== value.declaredPageCount
    || end !== points.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["pages"],
      message: "PDF coverage must account for the complete extracted text and page inventory",
    });
  }
});

export type ParsedPdf = Readonly<z.infer<typeof extractionSchema>>;

export type PdfParserOptions = {
  timeoutMilliseconds?: number;
};

const sourceMetadataSchema = ExtractedSourceInputSchema.omit({
  schemaVersion: true,
  document: true,
  extractedText: true,
  extraction: true,
});

function assertPdfSignature(bytes: Uint8Array): void {
  const prefix = Buffer.from(bytes.subarray(0, 1_024)).toString("latin1");
  if (!prefix.includes("%PDF-")) {
    throw new ParserError(
      "TYPE_MISMATCH",
      "Input does not contain a PDF signature in its initial bytes",
    );
  }
}

export async function extractPdf(
  input: Uint8Array,
  options: PdfParserOptions = {},
): Promise<ParsedPdf> {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new ParserError("INVALID_INPUT", "PDF input must contain bytes");
  }
  if (input.byteLength > MAX_PDF_BYTES) {
    throw new ParserError("FILE_TOO_LARGE", "PDF exceeds the 10 MB parser limit");
  }
  assertPdfSignature(input);
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  if (
    !Number.isInteger(timeoutMilliseconds)
    || timeoutMilliseconds < 100
    || timeoutMilliseconds > 60_000
  ) {
    throw new ParserError("INVALID_INPUT", "Parser timeout is invalid");
  }

  const directory = await mkdtemp(join(tmpdir(), "scopeledger-parser-"));
  const inputPath = join(directory, "input.pdf");
  const workerPath = fileURLToPath(new URL("./pdf-worker.mjs", import.meta.url));
  try {
    await writeFile(inputPath, input, { mode: 0o400 });
    let stdout: string;
    try {
      const result = await execute(
        process.execPath,
        [
          "--max-old-space-size=256",
          workerPath,
          inputPath,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: timeoutMilliseconds,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: {
            PATH: process.env.PATH ?? "",
            NODE_ENV: "production",
            SCOPELEDGER_PARSER_CHILD: "1",
          },
        },
      );
      stdout = result.stdout;
    } catch (error) {
      if (
        error
        && typeof error === "object"
        && "killed" in error
        && error.killed === true
      ) {
        throw new ParserError("PARSER_TIMEOUT", "PDF parser exceeded its time limit");
      }
      const message = error && typeof error === "object" && "stderr" in error
        && typeof error.stderr === "string"
        ? error.stderr
        : "";
      if (message.includes("PAGE_LIMIT_EXCEEDED")) {
        throw new ParserError(
          "PAGE_LIMIT_EXCEEDED",
          "PDF exceeds the 50-page parser limit",
        );
      }
      throw new ParserError("PARSER_FAILED", "PDF parser process failed");
    }
    let output: unknown;
    try {
      output = JSON.parse(stdout);
    } catch {
      throw new ParserError(
        "PARSER_OUTPUT_INVALID",
        "PDF parser returned invalid JSON",
      );
    }
    const parsed = extractionSchema.safeParse(output);
    if (!parsed.success) {
      throw new ParserError(
        "PARSER_OUTPUT_INVALID",
        "PDF parser output failed the extraction contract",
      );
    }
    return Object.freeze(parsed.data);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function sealParsedPdfSource(
  parsedInput: unknown,
  metadataInput: unknown,
): ValidationResult<ExtractedSourceVersion> {
  const parsed = extractionSchema.safeParse(parsedInput);
  const metadata = sourceMetadataSchema.safeParse(metadataInput);
  if (!parsed.success || !metadata.success) {
    return sealExtractedSourceVersion(null);
  }
  return sealExtractedSourceVersion({
    schemaVersion: 1,
    ...metadata.data,
    provenance: {
      ...metadata.data.provenance,
      extractorReference: parsed.data.extractorReference,
    },
    document: {
      format: "pdf",
      declaredByteLength: parsed.data.declaredByteLength,
      declaredPageCount: parsed.data.declaredPageCount,
      pages: parsed.data.pages,
      unavailablePages: parsed.data.unavailablePages,
    },
    extractedText: parsed.data.extractedText,
    extraction: {
      status: parsed.data.unavailablePages.length > 0
        ? "partial"
        : "complete",
      unavailableReason: parsed.data.unavailablePages.length > 0
        ? "One or more PDF pages were unavailable during isolated extraction."
        : null,
    },
  });
}
