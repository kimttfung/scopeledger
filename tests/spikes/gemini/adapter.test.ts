import assert from "node:assert/strict";
import test from "node:test";
import {
  extractedTextSha256,
} from "@scopeledger/analysis";
import {
  GeminiAdapterError,
  GeminiCandidateClient,
  parseGeminiConfig,
} from "@scopeledger/gemini-adapter";
import type { FetchLike } from "@scopeledger/gemini-adapter";

const extractedText = "Reusable layout is included. Populated page is additional.";
const points = Array.from(extractedText);
const supportingQuote = "Populated page is additional.";
const supportingStart = points.join("").indexOf(supportingQuote);
const sourceReference = {
  workspaceId: "workspace",
  projectId: "project",
  sourceId: "source",
  versionId: "version",
};

function run(options: {
  modelProcessing?: "permitted" | "denied";
} = {}) {
  return {
    schemaVersion: 1,
    workspaceId: "workspace",
    projectId: "project",
    sources: [{
      schemaVersion: 1,
      ...sourceReference,
      provenance: {
        origin: "agreement",
        suppliedBy: "provider",
        recordedAt: "2026-11-11T12:00:00Z",
        claimedDate: null,
        effectiveDate: null,
        acceptance: {
          kind: "provider-attested-import",
          attestedBy: "provider",
          basis: "Synthetic test source accepted for local adapter validation.",
        },
        originReference: null,
        extractorReference: "Synthetic extracted-text fixture.",
      },
      document: { format: "pasted-text" },
      extractedText,
      extractedTextSha256: extractedTextSha256(extractedText),
      extraction: { status: "complete", unavailableReason: null },
      permissions: {
        studioSharing: "permitted",
        modelProcessing: options.modelProcessing ?? "permitted",
        modelInputReview: {
          status: "cleared",
          reviewerId: "provider",
          reviewedAt: "2026-11-11T12:00:00Z",
          basis: "Synthetic source reviewed for permitted model input.",
        },
      },
    }],
    request: {
      kind: "request",
      text: "Please add the populated page.",
    },
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    workspaceId: "workspace",
    projectId: "project",
    claims: [{
      claimId: "claim-1",
      interpretation: "The populated page is described as additional.",
      supportingEvidence: [{
        source: sourceReference,
        start: supportingStart,
        end: supportingStart + Array.from(supportingQuote).length,
        quote: supportingQuote,
        polarity: "supporting",
      }],
      chargeWeakeningEvidence: [],
      uncertainty: {
        status: "limited",
        explanation: "Commercial treatment still requires provider review.",
        questions: [],
      },
    }],
    coverage: {
      sources: [sourceReference],
      missingContext: [],
      counterEvidenceScope: "admitted-sources-only",
    },
    ...overrides,
  };
}

function response(output: unknown): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: JSON.stringify(output) }] },
      finishReason: "STOP",
    }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      totalTokenCount: 150,
    },
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("configuration requires a server-side key and pinned model", () => {
  assert.equal(parseGeminiConfig({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
  }).model, "gemini-3.8-flash");
  assert.throws(
    () => parseGeminiConfig({ apiKey: "", model: "gemini-3.8-flash" }),
    GeminiAdapterError,
  );
  assert.throws(
    () => parseGeminiConfig({ apiKey: "test-key", model: "../model" }),
    GeminiAdapterError,
  );
});

test("admitted source context produces strict human-review-required candidates", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init });
    return response(candidate());
  };
  const client = new GeminiCandidateClient({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
  }, { fetch: fetcher });
  const result = await client.generateCandidateClaims(run());
  assert.equal(result.transport, "synthetic-contract");
  assert.equal(result.review.publicationEligibility, "blocked");
  assert.equal(result.review.claims[0]?.reviewState, "human-review-required");
  assert.deepEqual(result.usage, {
    promptTokens: 100,
    candidateTokens: 50,
    totalTokens: 150,
  });
  assert.equal(
    calls[0]?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
  assert.equal(new Headers(calls[0]?.init?.headers).get("x-goog-api-key"), "test-key");
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    generationConfig: {
      responseMimeType: string;
      responseJsonSchema: unknown;
    };
  };
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.responseJsonSchema);
});

test("denied model permission blocks dispatch before any network call", async () => {
  let calls = 0;
  const client = new GeminiCandidateClient({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
  }, {
    fetch: async () => {
      calls += 1;
      return response(candidate());
    },
  });
  await assert.rejects(
    () => client.generateCandidateClaims(run({ modelProcessing: "denied" })),
    (error: unknown) => error instanceof GeminiAdapterError
      && error.code === "PROCESSING_NOT_PERMITTED",
  );
  assert.equal(calls, 0);
});

test("schema-valid but false source pointers are rejected locally", async () => {
  const invalid = candidate();
  invalid.claims[0]!.supportingEvidence[0]!.quote = "Fabricated quote";
  const client = new GeminiCandidateClient({
    apiKey: "test-key",
    model: "gemini-3.8-flash",
  }, { fetch: async () => response(invalid) });
  await assert.rejects(
    () => client.generateCandidateClaims(run()),
    (error: unknown) => error instanceof GeminiAdapterError
      && error.code === "MODEL_OUTPUT_INVALID",
  );
});

test("model authentication lookup never returns or logs the API key", async () => {
  const client = new GeminiCandidateClient({
    apiKey: "must-not-be-returned",
    model: "gemini-3.8-flash",
  }, {
    fetch: async () => new Response(JSON.stringify({
      name: "models/gemini-3.8-flash",
    }), { status: 200 }),
  });
  const result = await client.checkAuthentication();
  assert.deepEqual(result, {
    authenticated: true,
    model: "gemini-3.8-flash",
  });
  assert.equal(JSON.stringify(result).includes("must-not-be-returned"), false);
});
