import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRecordExportV1,
  exportProjectRecords,
  RECORD_EXPORT_JSON_SCHEMA_V1,
  RecordsExportError,
  renderRecordExportHtml,
  serializeRecordExportJson,
  validateRecordExportV1,
} from "../../../packages/records-export/src/index.js";
import type {
  ProjectHistoryProjection,
  RecordsProjectionReader,
} from "../../../packages/records-export/src/index.js";

function projection(reverse = false): ProjectHistoryProjection {
  const value: ProjectHistoryProjection = {
    schemaVersion: "scopeledger.records-projection.v1",
    project: {
      projectKey: "internal-project-id",
      displayName: "Café <launch> & review",
      createdAt: "2026-11-01T10:00:00.000Z",
    },
    requests: [{
      requestKey: "internal-request-id",
      title: "Website <script>alert('x')</script>",
      createdAt: "2026-11-01T10:01:00.000Z",
    }],
    sources: [
      {
        sourceKey: "source-available",
        version: 1,
        sourceKind: "provider-upload",
        availability: "available",
        mediaType: "application/pdf",
        provenanceOrigin: "agreement",
        suppliedByRole: "provider",
        providerReviewed: true,
        recordedAt: "2026-11-01T10:02:00.000Z",
        unavailableParts: [],
      },
      {
        sourceKey: "source-unavailable",
        version: 1,
        sourceKind: "client-supplied",
        availability: "unavailable",
        mediaType: null,
        provenanceOrigin: "correspondence",
        suppliedByRole: "client",
        providerReviewed: true,
        recordedAt: "2026-11-01T10:03:00.000Z",
        unavailableParts: [{
          label: "Attachment 2",
          reason: "The attachment was not retained.",
        }],
      },
      {
        sourceKey: "source-provider-note",
        version: 1,
        sourceKind: "provider-note",
        availability: "available",
        mediaType: "text/plain",
        provenanceOrigin: "other",
        suppliedByRole: "provider",
        providerReviewed: true,
        recordedAt: "2026-11-01T10:04:00.000Z",
        unavailableParts: [],
      },
    ],
    units: [{
      unitKey: "internal-unit-id",
      requestKey: "internal-request-id",
      currentVersion: 2,
      acceptedVersion: 2,
    }],
    drafts: [{
      requestKey: "internal-request-id",
      unitKey: "internal-unit-id",
      revision: 1,
      state: "ready-for-client-review",
      title: "Launch draft",
      summary: "Review with owner@example.test using s3://private-bucket/object.pdf and api_key=sk-1234567890abcdefghijkl.",
      scope: ["Produce the <main> page"],
      exclusions: ["No credential transfer"],
      sourceKeys: [{ sourceKey: "source-available", version: 1 }],
      createdAt: "2026-11-01T10:05:00.000Z",
    }],
    publications: [
      {
        requestKey: "internal-request-id",
        unitKey: "internal-unit-id",
        version: 1,
        title: "Initial scope",
        scope: ["Initial page"],
        exclusions: [],
        rationale: "Initial proposal",
        treatment: "payable",
        timingDescription: "Five working days",
        deliveryDependencies: ["Client supplies images"],
        sourceKeys: [{ sourceKey: "source-available", version: 1 }],
        prerequisiteKeys: [],
        money: { currency: "USD", gross: "450.00" },
        publishedAt: "2026-11-01T10:06:00.000Z",
      },
      {
        requestKey: "internal-request-id",
        unitKey: "internal-unit-id",
        version: 2,
        title: "Revised scope",
        scope: ["Final landing page"],
        exclusions: ["Hosting"],
        rationale: "Client correction accepted",
        treatment: "payable",
        timingDescription: "Three working days after readiness",
        deliveryDependencies: ["Approved images"],
        sourceKeys: [
          { sourceKey: "source-available", version: 1 },
          { sourceKey: "source-unavailable", version: 1 },
        ],
        prerequisiteKeys: ["approved-images"],
        money: { currency: "USD", gross: "300.00" },
        publishedAt: "2026-11-01T10:09:00.000Z",
      },
    ],
    corrections: [{
      correctionKey: "internal-correction-id",
      requestKey: "internal-request-id",
      unitKey: "internal-unit-id",
      scope: "known",
      statement: "The layout was already included.",
      claimedSourceType: "correspondence",
      sourceAvailability: "unavailable",
      sourceGapExplanation: "The old message is unavailable.",
      admittedAt: "2026-11-01T10:07:00.000Z",
    }],
    correctionResponses: [{
      correctionKey: "internal-correction-id",
      revision: 1,
      disposition: "accept",
      sourceReview: "Reviewed available project records.",
      explanation: "Revised the payable amount.",
      recordedAt: "2026-11-01T10:08:00.000Z",
    }],
    questions: [{
      questionKey: "internal-question-id",
      requestKey: "internal-request-id",
      unitKey: "internal-unit-id",
      unitVersion: 2,
      exactText: "Does this include the responsive state?",
      modelProcessing: "denied",
      askedAt: "2026-11-01T10:10:00.000Z",
    }],
    decisions: [{
      unitKey: "internal-unit-id",
      version: 2,
      decision: "approve",
      attestationStatement: "I reviewed this exact version.",
      resolvedCorrections: [{
        correctionKey: "internal-correction-id",
        responseRevision: 1,
      }],
      recordedAt: "2026-11-01T10:11:00.000Z",
    }],
    obligations: [{
      obligationKey: "internal-obligation-id",
      unitKey: "internal-unit-id",
      version: 2,
      currency: "USD",
      gross: "300.00",
      collectible: true,
      replacesObligationKey: null,
      recordedAt: "2026-11-01T10:11:00.000Z",
    }],
    payments: [{
      paymentKey: "internal-payment-operation-id",
      obligationKey: "internal-obligation-id",
      unitKey: "internal-unit-id",
      version: 2,
      currency: "USD",
      gross: "300.00",
      verification: "paypal-verified",
      verifiedAt: "2026-11-01T10:12:00.000Z",
    }],
    holds: [{
      unitKey: "internal-unit-id",
      active: false,
      createdAt: "2026-11-01T10:07:00.000Z",
      resolvedAt: "2026-11-01T10:09:00.000Z",
    }],
    prerequisites: [{
      unitKey: "internal-unit-id",
      version: 2,
      prerequisiteKey: "approved-images",
      satisfied: true,
      recordedAt: "2026-11-01T10:13:00.000Z",
    }],
    workStarts: [{
      workStartKey: "internal-work-start-sequence",
      unitKey: "internal-unit-id",
      version: 2,
      startedAt: "2026-11-01T10:14:00.000Z",
    }],
    analysisCandidates: [{
      analysisKey: "internal-analysis-run-id",
      status: "candidate-ready",
      candidateCount: 2,
      humanReviewRequired: true,
      publicationBlocked: true,
      createdAt: "2026-11-01T10:04:30.000Z",
    }],
    analysisReviews: [{
      reviewKey: "internal-analysis-review-id",
      analysisKey: "internal-analysis-run-id",
      disposition: "edit",
      note: "Provider reviewed the candidates.",
      reviewedAt: "2026-11-01T10:05:30.000Z",
    }],
    capabilities: {
      delivery: "unsupported",
      deliveryAcceptance: "unsupported",
    },
  };
  if (!reverse) return value;
  return {
    ...value,
    sources: [...value.sources].reverse(),
    publications: [...value.publications].reverse(),
    correctionResponses: [...value.correctionResponses].reverse(),
  };
}

test("canonical JSON and HTML are deterministic across reader ordering", () => {
  const first = buildRecordExportV1(projection());
  const second = buildRecordExportV1(projection(true));

  assert.equal(serializeRecordExportJson(first), serializeRecordExportJson(second));
  assert.equal(renderRecordExportHtml(first), renderRecordExportHtml(second));
  assert.deepEqual(
    first.timeline.map((item) => item.occurredAt),
    [...first.timeline.map((item) => item.occurredAt)].sort(),
  );
  assert.equal(first.schemaVersion, "scopeledger.project-record.v1");
  assert.equal(
    RECORD_EXPORT_JSON_SCHEMA_V1.$id,
    "https://scopeledger.local/schemas/project-record-v1.schema.json",
  );
});

test("HTML escapes active text and JSON redacts email and private paths", () => {
  const document = buildRecordExportV1(projection());
  const json = serializeRecordExportJson(document);
  const html = renderRecordExportHtml(document);

  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.match(html, /Café &lt;launch&gt; &amp; review/);
  assert.doesNotMatch(json, /owner@example\.test/);
  assert.doesNotMatch(json, /s3:\/\/private-bucket/);
  assert.doesNotMatch(json, /sk-1234567890abcdefghijkl/);
  assert.match(json, /\[redacted email\]/);
  assert.match(json, /\[redacted private path\]/);
  assert.match(json, /\[redacted credential\]/);
});

test("role-safe export excludes internal, provider, session, and digest fields", () => {
  const tainted = {
    ...projection(),
    internalGrant: "grant-secret",
    sessionId: "session-secret",
    project: {
      ...projection().project,
      providerId: "provider-secret",
      email: "private@example.test",
    },
    payments: projection().payments.map((payment) => ({
      ...payment,
      merchantId: "merchant-secret",
      orderId: "paypal-order-secret",
      captureId: "paypal-capture-secret",
      evidenceDigest: "a".repeat(64),
    })),
    analysisCandidates: projection().analysisCandidates.map((analysis) => ({
      ...analysis,
      modelReference: "private-model-secret",
      requestedBySubjectDigest: "b".repeat(64),
    })),
    sources: projection().sources.map((source) => ({
      ...source,
      originalName: "/Users/private/contracts/client.pdf",
      privateObjectPath: "s3://private/object",
      contentDigest: "c".repeat(64),
    })),
  } as unknown as ProjectHistoryProjection;
  const output = serializeRecordExportJson(buildRecordExportV1(tainted));

  for (const secret of [
    "internal-project-id",
    "internal-request-id",
    "internal-unit-id",
    "internal-obligation-id",
    "internal-payment-operation-id",
    "grant-secret",
    "session-secret",
    "provider-secret",
    "private@example.test",
    "merchant-secret",
    "paypal-order-secret",
    "paypal-capture-secret",
    "private-model-secret",
    "/Users/private",
    "s3://private/object",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
  ]) {
    assert.doesNotMatch(output, new RegExp(secret.replaceAll("/", "\\/")));
  }
});

test("reader API accepts only an already-scoped project and returns both contracts", async () => {
  const calls: unknown[] = [];
  const reader: RecordsProjectionReader = {
    readProject: async (scope, limits) => {
      calls.push({ scope, limits });
      return projection();
    },
  };
  const exported = await exportProjectRecords(reader, {
    workspaceId: "workspace-one",
    projectId: "project-one",
  });

  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { scope: unknown }).scope, {
    workspaceId: "workspace-one",
    projectId: "project-one",
  });
  assert.equal(exported.document.schemaVersion, "scopeledger.project-record.v1");
  assert.equal(exported.json, serializeRecordExportJson(exported.document));
  assert.equal(exported.html, renderRecordExportHtml(exported.document));
});

test("unavailable and redacted gaps never reconstruct source text", () => {
  const document = buildRecordExportV1(projection());
  const unavailable = document.facts.sources.find((source) =>
    source.availability === "unavailable");
  const redacted = document.facts.sources.find((source) =>
    source.availability === "redacted");

  assert.equal(unavailable?.contentStatus, "unavailable");
  assert.equal(redacted?.sourceKind, "redacted-provider-note");
  assert.equal(redacted?.mediaType, null);
  assert.ok(document.gaps.some((gap) =>
    gap.status === "unavailable"
    && gap.reason.includes("no text was reconstructed")));
  assert.ok(document.gaps.some((gap) =>
    gap.status === "redacted"
    && gap.reason.includes("Private provider-note content")));
});

test("agreement, payment, readiness, work start, delivery, and acceptance remain separate", () => {
  const document = buildRecordExportV1(projection());

  assert.equal(document.facts.agreements.length, 1);
  assert.equal(document.facts.agreements[0]?.attribution, "client-decided");
  assert.equal(document.facts.obligations[0]?.gross, "300.00");
  assert.equal(document.facts.payments[0]?.gross, "300.00");
  assert.equal(document.facts.payments[0]?.attribution, "paypal-verified");
  assert.equal(document.facts.readiness[0]?.status, "recorded-basis-ready");
  assert.equal(document.facts.readiness[0]?.liveCheckRequired, true);
  assert.equal(document.facts.workStarts.length, 1);
  assert.deepEqual(document.facts.delivery, []);
  assert.deepEqual(document.facts.deliveryAcceptance, []);
  assert.equal(document.capabilities.delivery, "unsupported");
  assert.ok(document.gaps.some((gap) => gap.category === "delivery"));
  assert.ok(document.gaps.some((gap) =>
    gap.category === "delivery-acceptance"));
  assert.deepEqual(document.labels.notices, [
    "This record is not a legal opinion.",
    "This record is not a delivery receipt.",
    "This record is not a dispute submission.",
    "This record is not proof of satisfactory delivery.",
  ]);
});

test("AI candidates and provider review retain distinct attribution", () => {
  const document = buildRecordExportV1(projection());

  assert.equal(
    document.facts.analysisCandidates[0]?.attribution,
    "ai-candidate",
  );
  assert.equal(
    document.facts.analysisCandidates[0]?.publicationBlocked,
    true,
  );
  assert.equal(
    document.facts.analysisReviews[0]?.attribution,
    "provider-reviewed",
  );
});

test("bounds fail explicitly before silent truncation", async () => {
  assert.throws(
    () => buildRecordExportV1(projection(), {
      limits: { maxRecordsPerKind: 1 },
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "BOUND_EXCEEDED",
  );
  const document = buildRecordExportV1(projection());
  assert.throws(
    () => serializeRecordExportJson(document, {
      limits: { maxJsonBytes: 10 },
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "OUTPUT_TOO_LARGE",
  );
  const reader: RecordsProjectionReader = {
    readProject: async () => projection(),
  };
  await assert.rejects(
    exportProjectRecords(reader, {
      workspaceId: "bad workspace",
      projectId: "project",
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "INVALID_SCOPE",
  );
});

test("schema validation rejects version drift and extra fields", () => {
  const document = buildRecordExportV1(projection());
  assert.equal(validateRecordExportV1(document), document);

  assert.throws(
    () => validateRecordExportV1({
      ...document,
      schemaVersion: "scopeledger.project-record.v2",
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "INVALID_RECORD",
  );
  assert.throws(
    () => validateRecordExportV1({
      ...document,
      providerNotes: ["must not be accepted"],
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "INVALID_RECORD",
  );
  assert.throws(
    () => validateRecordExportV1({
      ...document,
      facts: {
        ...document.facts,
        payments: document.facts.payments.map((payment) => ({
          ...payment,
          gross: "300",
        })),
      },
    }),
    (error: unknown) =>
      error instanceof RecordsExportError && error.code === "INVALID_RECORD",
  );
});

test("incomplete references fail instead of omitting affected facts", () => {
  const incomplete = {
    ...projection(),
    sources: projection().sources.filter((source) =>
      source.sourceKey !== "source-unavailable"),
  };
  assert.throws(
    () => buildRecordExportV1(incomplete),
    (error: unknown) =>
      error instanceof RecordsExportError
      && error.code === "INCOMPLETE_PROJECTION",
  );
});
