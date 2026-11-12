import { RecordsExportError } from "./errors.js";
import {
  RECORD_EXPORT_LABELS,
  RECORD_EXPORT_SCHEMA_VERSION,
  RECORD_EXPORT_SERIALIZATION_VERSION,
} from "./types.js";
import type { RecordExportV1 } from "./types.js";

export const RECORD_EXPORT_JSON_SCHEMA_V1 = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://scopeledger.local/schemas/project-record-v1.schema.json",
  title: "ScopeLedger project record v1",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "serializationVersion",
    "labels",
    "project",
    "capabilities",
    "facts",
    "gaps",
    "timeline",
  ],
  properties: {
    schemaVersion: { const: RECORD_EXPORT_SCHEMA_VERSION },
    serializationVersion: { const: RECORD_EXPORT_SERIALIZATION_VERSION },
    labels: {
      type: "object",
      additionalProperties: false,
      required: ["title", "notices"],
      properties: {
        title: { const: RECORD_EXPORT_LABELS.title },
        notices: {
          type: "array",
          prefixItems: RECORD_EXPORT_LABELS.notices.map((notice) => ({
            const: notice,
          })),
          minItems: RECORD_EXPORT_LABELS.notices.length,
          maxItems: RECORD_EXPORT_LABELS.notices.length,
        },
      },
    },
    project: {
      type: "object",
      additionalProperties: false,
      required: ["recordRef", "displayName", "createdAt", "attribution"],
      properties: {
        recordRef: { $ref: "#/$defs/recordRef" },
        displayName: { type: "string" },
        createdAt: {
          oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
        attribution: { const: "provider-reviewed" },
      },
    },
    capabilities: {
      type: "object",
      additionalProperties: false,
      required: ["delivery", "deliveryAcceptance"],
      properties: {
        delivery: { const: "unsupported" },
        deliveryAcceptance: { const: "unsupported" },
      },
    },
    facts: {
      type: "object",
      additionalProperties: false,
      required: [
        "requests",
        "sources",
        "drafts",
        "publications",
        "corrections",
        "questions",
        "agreements",
        "obligations",
        "payments",
        "readiness",
        "workStarts",
        "analysisCandidates",
        "analysisReviews",
        "delivery",
        "deliveryAcceptance",
      ],
      properties: {
        ...Object.fromEntries([
          "requests",
          "sources",
          "drafts",
          "publications",
          "corrections",
          "questions",
          "agreements",
          "obligations",
          "payments",
          "readiness",
          "workStarts",
          "analysisCandidates",
          "analysisReviews",
        ].map((name) => [name, {
          type: "array",
          items: { $ref: "#/$defs/fact" },
        }])),
        delivery: { type: "array", maxItems: 0 },
        deliveryAcceptance: { type: "array", maxItems: 0 },
      },
    },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recordRef", "category", "status", "reason"],
        properties: {
          recordRef: { $ref: "#/$defs/recordRef" },
          category: {
            enum: [
              "source",
              "project",
              "request",
              "delivery",
              "delivery-acceptance",
            ],
          },
          status: {
            enum: ["unavailable", "redacted", "unsupported", "incomplete"],
          },
          reason: { type: "string" },
        },
      },
    },
    timeline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "recordRef",
          "kind",
          "occurredAt",
          "attribution",
          "summary",
        ],
        properties: {
          recordRef: { $ref: "#/$defs/recordRef" },
          kind: { type: "string" },
          occurredAt: { type: "string", format: "date-time" },
          attribution: { $ref: "#/$defs/attribution" },
          summary: { type: "string" },
        },
      },
    },
  },
  $defs: {
    recordRef: { type: "string", pattern: "^rec_[a-f0-9]{24}$" },
    attribution: {
      enum: [
        "provider-reviewed",
        "client-supplied",
        "client-decided",
        "ai-candidate",
        "paypal-verified",
        "system-recorded",
      ],
    },
    fact: {
      type: "object",
      required: ["recordRef", "occurredAt", "attribution"],
      properties: {
        recordRef: { $ref: "#/$defs/recordRef" },
        occurredAt: {
          oneOf: [{ type: "string", format: "date-time" }, { type: "null" }],
        },
        attribution: { $ref: "#/$defs/attribution" },
      },
    },
  },
} as const);

const recordRefPattern = /^rec_[a-f0-9]{24}$/;
const moneyPattern = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const attributions = new Set([
  "provider-reviewed",
  "client-supplied",
  "client-decided",
  "ai-candidate",
  "paypal-verified",
  "system-recorded",
]);
const factNames = [
  "requests",
  "sources",
  "drafts",
  "publications",
  "corrections",
  "questions",
  "agreements",
  "obligations",
  "payments",
  "readiness",
  "workStarts",
  "analysisCandidates",
  "analysisReviews",
  "delivery",
  "deliveryAcceptance",
] as const;

function invalid(message: string): never {
  throw new RecordsExportError("INVALID_RECORD", message);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    invalid(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    invalid(`${name} has unsupported or missing fields`);
  }
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") invalid(`${name} must be a string`);
  return value;
}

function reference(value: unknown, name: string): string {
  const result = string(value, name);
  if (!recordRefPattern.test(result)) invalid(`${name} is not a record reference`);
  return result;
}

function instant(value: unknown, name: string, nullable = false): void {
  if (nullable && value === null) return;
  const text = string(value, name);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    invalid(`${name} is not a canonical instant`);
  }
}

function attribution(value: unknown, name: string): void {
  if (typeof value !== "string" || !attributions.has(value)) {
    invalid(`${name} is not a supported attribution`);
  }
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") invalid(`${name} must be a boolean`);
  return value;
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    invalid(`${name} must be a bounded integer`);
  }
  return Number(value);
}

function oneOf(
  value: unknown,
  allowed: readonly string[],
  name: string,
): string {
  const result = string(value, name);
  if (!allowed.includes(result)) invalid(`${name} is unsupported`);
  return result;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${name} must be an array`);
  return value;
}

function stringItems(value: unknown, name: string): void {
  array(value, name).forEach((item, index) => {
    string(item, `${name}[${index}]`);
  });
}

function money(value: unknown, name: string): void {
  const result = string(value, name);
  if (!moneyPattern.test(result)) invalid(`${name} must be exact USD money`);
}

function fact(value: unknown, name: string): void {
  const row = object(value, name);
  reference(row.recordRef, `${name}.recordRef`);
  instant(row.occurredAt, `${name}.occurredAt`, true);
  attribution(row.attribution, `${name}.attribution`);
}

function validateFactFields(
  collection: typeof factNames[number],
  value: unknown,
  name: string,
): void {
  const row = object(value, name);
  const common = ["recordRef", "occurredAt", "attribution"] as const;
  const fields: Readonly<Record<typeof factNames[number], readonly string[]>> = {
    requests: [...common, "title"],
    sources: [
      ...common,
      "sourceRef",
      "version",
      "sourceKind",
      "availability",
      "mediaType",
      "provenanceOrigin",
      "contentStatus",
    ],
    drafts: [
      ...common,
      "requestRef",
      "unitRef",
      "revision",
      "state",
      "title",
      "summary",
      "scope",
      "exclusions",
      "sourceRefs",
    ],
    publications: [
      ...common,
      "requestRef",
      "unitRef",
      "version",
      "title",
      "scope",
      "exclusions",
      "rationale",
      "treatment",
      "timingDescription",
      "deliveryDependencies",
      "sourceRefs",
      "money",
    ],
    corrections: [
      ...common,
      "requestRef",
      "unitRef",
      "scope",
      "statement",
      "claimedSourceType",
      "sourceAvailability",
      "sourceGapExplanation",
      "responses",
    ],
    questions: [
      ...common,
      "requestRef",
      "unitRef",
      "unitVersion",
      "exactText",
      "modelProcessing",
      "communicationEffect",
    ],
    agreements: [
      ...common,
      "unitRef",
      "version",
      "decision",
      "attestationStatement",
      "resolvedCorrectionRefs",
    ],
    obligations: [
      ...common,
      "unitRef",
      "version",
      "currency",
      "gross",
      "collectible",
      "replacesObligationRef",
    ],
    payments: [
      ...common,
      "obligationRef",
      "unitRef",
      "version",
      "currency",
      "gross",
      "verification",
    ],
    readiness: [
      ...common,
      "unitRef",
      "currentVersion",
      "acceptedVersion",
      "status",
      "activeHoldCount",
      "liveCheckRequired",
    ],
    workStarts: [...common, "unitRef", "version"],
    analysisCandidates: [
      ...common,
      "status",
      "candidateCount",
      "humanReviewRequired",
      "publicationBlocked",
    ],
    analysisReviews: [
      ...common,
      "analysisRef",
      "disposition",
      "note",
    ],
    delivery: common,
    deliveryAcceptance: common,
  };
  exactKeys(row, fields[collection], name);
  switch (collection) {
    case "requests":
      string(row.title, `${name}.title`);
      break;
    case "sources":
      reference(row.sourceRef, `${name}.sourceRef`);
      integer(row.version, `${name}.version`, 1);
      oneOf(row.sourceKind, [
        "provider-upload",
        "client-supplied",
        "external-reference",
        "analysis-provider-upload",
        "redacted-provider-note",
      ], `${name}.sourceKind`);
      oneOf(
        row.availability,
        ["available", "unavailable", "partial", "redacted"],
        `${name}.availability`,
      );
      if (row.mediaType !== null) string(row.mediaType, `${name}.mediaType`);
      string(row.provenanceOrigin, `${name}.provenanceOrigin`);
      oneOf(row.contentStatus, [
        "not-exported",
        "unavailable",
        "partially-unavailable",
        "redacted",
      ], `${name}.contentStatus`);
      break;
    case "drafts":
      reference(row.requestRef, `${name}.requestRef`);
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.revision, `${name}.revision`, 1);
      oneOf(
        row.state,
        ["in-progress", "ready-for-client-review"],
        `${name}.state`,
      );
      string(row.title, `${name}.title`);
      string(row.summary, `${name}.summary`);
      stringItems(row.scope, `${name}.scope`);
      stringItems(row.exclusions, `${name}.exclusions`);
      array(row.sourceRefs, `${name}.sourceRefs`).forEach((item, index) =>
        reference(item, `${name}.sourceRefs[${index}]`));
      break;
    case "publications": {
      reference(row.requestRef, `${name}.requestRef`);
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.version, `${name}.version`, 1);
      string(row.title, `${name}.title`);
      stringItems(row.scope, `${name}.scope`);
      stringItems(row.exclusions, `${name}.exclusions`);
      string(row.rationale, `${name}.rationale`);
      oneOf(
        row.treatment,
        ["payable", "additional-waived"],
        `${name}.treatment`,
      );
      string(row.timingDescription, `${name}.timingDescription`);
      stringItems(
        row.deliveryDependencies,
        `${name}.deliveryDependencies`,
      );
      array(row.sourceRefs, `${name}.sourceRefs`).forEach((item, index) =>
        reference(item, `${name}.sourceRefs[${index}]`));
      if (row.money !== null) {
        const financial = object(row.money, `${name}.money`);
        exactKeys(financial, ["currency", "gross"], `${name}.money`);
        if (financial.currency !== "USD") invalid(`${name}.money.currency`);
        money(financial.gross, `${name}.money.gross`);
      }
      break;
    }
    case "corrections":
      reference(row.requestRef, `${name}.requestRef`);
      reference(row.unitRef, `${name}.unitRef`);
      oneOf(row.scope, ["known", "unknown"], `${name}.scope`);
      string(row.statement, `${name}.statement`);
      string(row.claimedSourceType, `${name}.claimedSourceType`);
      oneOf(
        row.sourceAvailability,
        ["available", "unavailable"],
        `${name}.sourceAvailability`,
      );
      if (row.sourceGapExplanation !== null) {
        string(row.sourceGapExplanation, `${name}.sourceGapExplanation`);
      }
      array(row.responses, `${name}.responses`).forEach((item, index) => {
        const responseName = `${name}.responses[${index}]`;
        const response = object(item, responseName);
        exactKeys(response, [
          "recordRef",
          "revision",
          "disposition",
          "sourceReview",
          "explanation",
          "recordedAt",
          "attribution",
        ], responseName);
        reference(response.recordRef, `${responseName}.recordRef`);
        integer(response.revision, `${responseName}.revision`, 1);
        oneOf(response.disposition, [
          "accept",
          "partial",
          "maintain",
          "request-information",
        ], `${responseName}.disposition`);
        string(response.sourceReview, `${responseName}.sourceReview`);
        string(response.explanation, `${responseName}.explanation`);
        instant(response.recordedAt, `${responseName}.recordedAt`);
        if (response.attribution !== "provider-reviewed") {
          invalid(`${responseName}.attribution is unsupported`);
        }
      });
      break;
    case "questions":
      reference(row.requestRef, `${name}.requestRef`);
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.unitVersion, `${name}.unitVersion`, 1);
      string(row.exactText, `${name}.exactText`);
      oneOf(
        row.modelProcessing,
        ["permitted", "denied"],
        `${name}.modelProcessing`,
      );
      if (row.communicationEffect !== "communication-only") {
        invalid(`${name}.communicationEffect is unsupported`);
      }
      break;
    case "agreements":
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.version, `${name}.version`, 1);
      oneOf(row.decision, ["approve", "decline"], `${name}.decision`);
      string(row.attestationStatement, `${name}.attestationStatement`);
      stringItems(row.resolvedCorrectionRefs, `${name}.resolvedCorrectionRefs`);
      break;
    case "obligations":
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.version, `${name}.version`, 1);
      if (row.currency !== "USD") invalid(`${name}.currency is unsupported`);
      money(row.gross, `${name}.gross`);
      boolean(row.collectible, `${name}.collectible`);
      if (row.replacesObligationRef !== null) {
        reference(row.replacesObligationRef, `${name}.replacesObligationRef`);
      }
      break;
    case "payments":
      reference(row.obligationRef, `${name}.obligationRef`);
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.version, `${name}.version`, 1);
      if (row.currency !== "USD") invalid(`${name}.currency is unsupported`);
      money(row.gross, `${name}.gross`);
      oneOf(
        row.verification,
        ["paypal-verified", "synthetic-proof"],
        `${name}.verification`,
      );
      break;
    case "readiness":
      reference(row.unitRef, `${name}.unitRef`);
      if (row.currentVersion !== null) {
        integer(row.currentVersion, `${name}.currentVersion`, 1);
      }
      if (row.acceptedVersion !== null) {
        integer(row.acceptedVersion, `${name}.acceptedVersion`, 1);
      }
      oneOf(row.status, [
        "awaiting-agreement",
        "review-hold",
        "awaiting-payment",
        "awaiting-prerequisite",
        "recorded-basis-ready",
      ], `${name}.status`);
      integer(row.activeHoldCount, `${name}.activeHoldCount`);
      if (boolean(row.liveCheckRequired, `${name}.liveCheckRequired`) !== true) {
        invalid(`${name}.liveCheckRequired must be true`);
      }
      break;
    case "workStarts":
      reference(row.unitRef, `${name}.unitRef`);
      integer(row.version, `${name}.version`, 1);
      break;
    case "analysisCandidates":
      oneOf(row.status, [
        "manual-review-ready",
        "candidate-ready",
        "model-failed",
      ], `${name}.status`);
      integer(row.candidateCount, `${name}.candidateCount`);
      if (
        boolean(row.humanReviewRequired, `${name}.humanReviewRequired`) !== true
        || boolean(row.publicationBlocked, `${name}.publicationBlocked`) !== true
      ) {
        invalid(`${name} safety flags must be true`);
      }
      break;
    case "analysisReviews":
      reference(row.analysisRef, `${name}.analysisRef`);
      oneOf(
        row.disposition,
        ["accept", "edit", "reject", "manual"],
        `${name}.disposition`,
      );
      string(row.note, `${name}.note`);
      break;
    case "delivery":
    case "deliveryAcceptance":
      break;
  }
}

export function validateRecordExportV1(input: unknown): RecordExportV1 {
  const root = object(input, "record");
  exactKeys(root, [
    "schemaVersion",
    "serializationVersion",
    "labels",
    "project",
    "capabilities",
    "facts",
    "gaps",
    "timeline",
  ], "record");
  if (root.schemaVersion !== RECORD_EXPORT_SCHEMA_VERSION) {
    invalid("record.schemaVersion is unsupported");
  }
  if (root.serializationVersion !== RECORD_EXPORT_SERIALIZATION_VERSION) {
    invalid("record.serializationVersion is unsupported");
  }

  const labels = object(root.labels, "record.labels");
  exactKeys(labels, ["title", "notices"], "record.labels");
  if (labels.title !== RECORD_EXPORT_LABELS.title) {
    invalid("record.labels.title is unsupported");
  }
  if (
    !Array.isArray(labels.notices)
    || labels.notices.length !== RECORD_EXPORT_LABELS.notices.length
    || labels.notices.some(
      (notice, index) => notice !== RECORD_EXPORT_LABELS.notices[index],
    )
  ) {
    invalid("record.labels.notices are incomplete");
  }

  const project = object(root.project, "record.project");
  exactKeys(
    project,
    ["recordRef", "displayName", "createdAt", "attribution"],
    "record.project",
  );
  reference(project.recordRef, "record.project.recordRef");
  string(project.displayName, "record.project.displayName");
  instant(project.createdAt, "record.project.createdAt", true);
  if (project.attribution !== "provider-reviewed") {
    invalid("record.project.attribution is unsupported");
  }

  const capabilities = object(root.capabilities, "record.capabilities");
  exactKeys(
    capabilities,
    ["delivery", "deliveryAcceptance"],
    "record.capabilities",
  );
  if (
    capabilities.delivery !== "unsupported"
    || capabilities.deliveryAcceptance !== "unsupported"
  ) {
    invalid("record capabilities must declare unsupported facts");
  }

  const facts = object(root.facts, "record.facts");
  exactKeys(facts, factNames, "record.facts");
  const seen = new Set<string>([String(project.recordRef)]);
  for (const name of factNames) {
    const collection = facts[name];
    if (!Array.isArray(collection)) {
      invalid(`record.facts.${name} must be an array`);
    }
    if (
      (name === "delivery" || name === "deliveryAcceptance")
      && collection.length > 0
    ) {
      invalid(`record.facts.${name} is unsupported in v1`);
    }
    collection.forEach((value, index) => {
      fact(value, `record.facts.${name}[${index}]`);
      validateFactFields(name, value, `record.facts.${name}[${index}]`);
      const row = value as Record<string, unknown>;
      const ref = reference(
        row.recordRef,
        `record.facts.${name}[${index}].recordRef`,
      );
      if (seen.has(ref)) invalid(`duplicate fact record reference ${ref}`);
      seen.add(ref);
    });
  }

  if (!Array.isArray(root.gaps)) invalid("record.gaps must be an array");
  root.gaps.forEach((value, index) => {
    const gap = object(value, `record.gaps[${index}]`);
    exactKeys(
      gap,
      ["recordRef", "category", "status", "reason"],
      `record.gaps[${index}]`,
    );
    reference(gap.recordRef, `record.gaps[${index}].recordRef`);
    oneOf(gap.category, [
      "source",
      "project",
      "request",
      "delivery",
      "delivery-acceptance",
    ], `record.gaps[${index}].category`);
    oneOf(gap.status, [
      "unavailable",
      "redacted",
      "unsupported",
      "incomplete",
    ], `record.gaps[${index}].status`);
    string(gap.reason, `record.gaps[${index}].reason`);
  });

  if (!Array.isArray(root.timeline)) invalid("record.timeline must be an array");
  let previous: string | null = null;
  root.timeline.forEach((value, index) => {
    const item = object(value, `record.timeline[${index}]`);
    exactKeys(
      item,
      ["recordRef", "kind", "occurredAt", "attribution", "summary"],
      `record.timeline[${index}]`,
    );
    reference(item.recordRef, `record.timeline[${index}].recordRef`);
    oneOf(item.kind, [
      "project",
      "request",
      "source",
      "draft",
      "publication",
      "correction",
      "correction-response",
      "question",
      "agreement",
      "obligation",
      "payment",
      "readiness",
      "work-start",
      "analysis-candidate",
      "analysis-review",
    ], `record.timeline[${index}].kind`);
    instant(item.occurredAt, `record.timeline[${index}].occurredAt`);
    attribution(item.attribution, `record.timeline[${index}].attribution`);
    string(item.summary, `record.timeline[${index}].summary`);
    const current = String(item.occurredAt);
    if (previous !== null && current < previous) {
      invalid("record.timeline is not chronological");
    }
    previous = current;
  });

  return input as RecordExportV1;
}
