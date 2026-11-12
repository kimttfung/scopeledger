import type {
  ProjectRecordExport,
  RecordExportV1,
} from "../../../packages/records-export/src/index.js";

export const recordDocument = {
  schemaVersion: "scopeledger.project-record.v1",
  serializationVersion: "scopeledger.canonical-json.v1",
  labels: {
    title: "ScopeLedger project record",
    notices: [
      "This record is not a legal opinion.",
      "This record is not a delivery receipt.",
      "This record is not a dispute submission.",
      "This record is not proof of satisfactory delivery.",
    ],
  },
  project: {
    recordRef: `rec_${"1".repeat(24)}`,
    displayName: "Cedar Roastery website",
    createdAt: "2026-11-02T10:00:00.000Z",
    attribution: "provider-reviewed",
  },
  capabilities: {
    delivery: "unsupported",
    deliveryAcceptance: "unsupported",
  },
  facts: {
    requests: [{
      recordRef: `rec_${"2".repeat(24)}`,
      occurredAt: "2026-11-02T10:01:00.000Z",
      attribution: "provider-reviewed",
      title: "Case-study request",
    }],
    sources: [{
      recordRef: `rec_${"3".repeat(24)}`,
      occurredAt: "2026-11-02T10:02:00.000Z",
      attribution: "provider-reviewed",
      sourceRef: `rec_${"3".repeat(24)}`,
      version: 1,
      sourceKind: "redacted-provider-note",
      availability: "redacted",
      mediaType: null,
      provenanceOrigin: "Provider record",
      contentStatus: "redacted",
    }],
    drafts: [],
    publications: [],
    corrections: [],
    questions: [],
    agreements: [],
    obligations: [],
    payments: [],
    readiness: [],
    workStarts: [],
    analysisCandidates: [],
    analysisReviews: [],
    delivery: [],
    deliveryAcceptance: [],
  },
  gaps: [{
    recordRef: `rec_${"3".repeat(24)}`,
    category: "source",
    status: "redacted",
    reason: "Private provider-note content is not included in this export.",
  }],
  timeline: [{
    recordRef: `rec_${"2".repeat(24)}`,
    kind: "request",
    occurredAt: "2026-11-02T10:01:00.000Z",
    attribution: "provider-reviewed",
    summary: "Request recorded: Case-study request",
  }],
} as const satisfies RecordExportV1;

export const projectExport = Object.freeze({
  document: recordDocument,
  json: JSON.stringify(recordDocument),
  html: "<!doctype html><html lang=\"en\"><body>Safe project record</body></html>",
}) satisfies ProjectRecordExport;
