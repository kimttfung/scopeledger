import { createHash } from "node:crypto";
import { canonicalRecordJson } from "./canonical.js";
import { RecordsExportError } from "./errors.js";
import {
  DEFAULT_EXPORT_LIMITS,
  RECORD_EXPORT_LABELS,
  RECORD_EXPORT_SCHEMA_VERSION,
  RECORD_EXPORT_SERIALIZATION_VERSION,
  RECORDS_PROJECTION_VERSION,
} from "./types.js";
import type {
  Attribution,
  ExportLimits,
  ProjectHistoryProjection,
  ProjectRecordExport,
  ProjectScope,
  RecordExportV1,
  RecordGap,
  RecordsProjectionReader,
} from "./types.js";
import { renderRecordExportHtml } from "./html.js";
import { validateRecordExportV1 } from "./schema.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const moneyPattern = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const emailPattern = /[^\s<>"'@]+@[^\s<>"'@]+/gu;
const privateUrlPattern = /\b(?:s3|gs|az|file):\/\/[^\s<>"']+/giu;
const privatePathPattern =
  /(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s<>"']+/gu;
const credentialPattern =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gu;
const assignedCredentialPattern =
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s<>"']+/giu;

const maximumLimits: ExportLimits = Object.freeze({
  maxRecordsPerKind: 5_000,
  maxTotalRecords: 20_000,
  maxTextCodePoints: 10_000,
  maxJsonBytes: 16_000_000,
  maxHtmlBytes: 32_000_000,
});

type TimelineEntry = RecordExportV1["timeline"][number];

const timelineKindOrder: Readonly<Record<TimelineEntry["kind"], number>> =
  Object.freeze({
    project: 0,
    request: 1,
    source: 2,
    draft: 3,
    publication: 4,
    correction: 5,
    "correction-response": 6,
    question: 7,
    agreement: 8,
    obligation: 9,
    payment: 10,
    readiness: 11,
    "work-start": 12,
    "analysis-candidate": 13,
    "analysis-review": 14,
  });

function fail(
  code: ConstructorParameters<typeof RecordsExportError>[0],
  message: string,
  references: readonly string[] = [],
): never {
  throw new RecordsExportError(code, message, references);
}

function limits(input: Partial<ExportLimits> | undefined): ExportLimits {
  const merged = { ...DEFAULT_EXPORT_LIMITS, ...input };
  for (const key of Object.keys(DEFAULT_EXPORT_LIMITS) as (keyof ExportLimits)[]) {
    const value = merged[key];
    if (
      !Number.isSafeInteger(value)
      || value < 1
      || value > maximumLimits[key]
    ) {
      fail("BOUND_EXCEEDED", `Export limit ${key} is invalid`);
    }
  }
  if (merged.maxRecordsPerKind > merged.maxTotalRecords) {
    fail(
      "BOUND_EXCEEDED",
      "Per-kind export limit cannot exceed the total record limit",
    );
  }
  return Object.freeze(merged);
}

function validateScope(scope: ProjectScope): void {
  if (
    !identifierPattern.test(scope.workspaceId)
    || !identifierPattern.test(scope.projectId)
  ) {
    fail("INVALID_SCOPE", "Expected a bounded scoped project identity");
  }
}

function recordRef(kind: string, ...identity: readonly (string | number)[]): string {
  return `rec_${createHash("sha256")
    .update(JSON.stringify([kind, ...identity]))
    .digest("hex")
    .slice(0, 24)}`;
}

function safeText(
  value: unknown,
  name: string,
  configuredLimits: ExportLimits,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string" || invalidUnicode.test(value)) {
    fail("INCOMPLETE_PROJECTION", `${name} is not valid export text`);
  }
  if (!options.allowEmpty && value.length === 0) {
    fail("INCOMPLETE_PROJECTION", `${name} is empty`);
  }
  if ([...value].length > configuredLimits.maxTextCodePoints) {
    fail("BOUND_EXCEEDED", `${name} exceeds the export text bound`);
  }
  const sanitized = value
    .replace(emailPattern, "[redacted email]")
    .replace(privateUrlPattern, "[redacted private path]")
    .replace(privatePathPattern, "[redacted private path]")
    .replace(assignedCredentialPattern, "[redacted credential]")
    .replace(credentialPattern, "[redacted credential]");
  return sanitized;
}

function integer(
  value: unknown,
  name: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail("INCOMPLETE_PROJECTION", `${name} is not a bounded integer`);
  }
  return Number(value);
}

function exactMoney(value: unknown, name: string): string {
  if (typeof value !== "string" || !moneyPattern.test(value)) {
    fail("INCOMPLETE_PROJECTION", `${name} is not exact USD money`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    fail("INCOMPLETE_PROJECTION", `${name} is not a valid instant`);
  }
  return date.toISOString();
}

function optionalInstant(value: unknown, name: string): string | null {
  return value === null ? null : instant(value, name);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareOccurred(
  left: { occurredAt: string | null; recordRef: string },
  right: { occurredAt: string | null; recordRef: string },
): number {
  if (left.occurredAt === null && right.occurredAt !== null) return 1;
  if (left.occurredAt !== null && right.occurredAt === null) return -1;
  return compareText(left.occurredAt ?? "", right.occurredAt ?? "")
    || compareText(left.recordRef, right.recordRef);
}

function lastInstant(values: readonly (string | null)[]): string | null {
  return values.filter((value): value is string => value !== null).sort(compareText).at(-1)
    ?? null;
}

function ensureProjection(
  projection: ProjectHistoryProjection,
  configuredLimits: ExportLimits,
): void {
  if (
    !projection
    || projection.schemaVersion !== RECORDS_PROJECTION_VERSION
  ) {
    fail(
      "UNSUPPORTED_PROJECTION_VERSION",
      "Reader returned an unsupported records projection",
    );
  }
  const collections = [
    projection.requests,
    projection.sources,
    projection.units,
    projection.drafts,
    projection.publications,
    projection.corrections,
    projection.correctionResponses,
    projection.questions,
    projection.decisions,
    projection.obligations,
    projection.payments,
    projection.holds,
    projection.prerequisites,
    projection.workStarts,
    projection.analysisCandidates,
    projection.analysisReviews,
  ];
  if (collections.some((collection) => !Array.isArray(collection))) {
    fail(
      "INCOMPLETE_PROJECTION",
      "Reader omitted a required records collection",
    );
  }
  if (
    !projection.project
    || projection.capabilities?.delivery !== "unsupported"
    || projection.capabilities.deliveryAcceptance !== "unsupported"
  ) {
    fail(
      "INCOMPLETE_PROJECTION",
      "Reader omitted project identity or unsupported capability declarations",
    );
  }
  for (const collection of collections) {
    if (collection.length > configuredLimits.maxRecordsPerKind) {
      fail("BOUND_EXCEEDED", "A projection collection exceeds the per-kind limit");
    }
  }
  const nestedCount = projection.sources.reduce(
      (total, source) => total + source.unavailableParts.length,
      0,
    );
  const total = collections.reduce(
    (count, collection) => count + collection.length,
    1,
  ) + nestedCount;
  if (total > configuredLimits.maxTotalRecords) {
    fail("BOUND_EXCEEDED", "Projection exceeds the total record limit");
  }
}

function sourceAttribution(
  source: ProjectHistoryProjection["sources"][number],
): Attribution {
  if (source.suppliedByRole === "client") return "client-supplied";
  return "provider-reviewed";
}

function timeline(
  entries: readonly TimelineEntry[],
): readonly TimelineEntry[] {
  return [...entries].sort((left, right) =>
    compareText(left.occurredAt, right.occurredAt)
      || timelineKindOrder[left.kind] - timelineKindOrder[right.kind]
      || compareText(left.recordRef, right.recordRef));
}

export function buildRecordExportV1(
  projection: ProjectHistoryProjection,
  options: { limits?: Partial<ExportLimits> } = {},
): RecordExportV1 {
  const configuredLimits = limits(options.limits);
  ensureProjection(projection, configuredLimits);

  const usedRefs = new Set<string>();
  const reserveRef = (
    kind: string,
    ...identity: readonly (string | number)[]
  ): string => {
    const reference = recordRef(kind, ...identity);
    if (usedRefs.has(reference)) {
      fail("INVALID_RECORD", "A bounded record reference collided");
    }
    usedRefs.add(reference);
    return reference;
  };

  const projectReference = reserveRef("project", projection.project.projectKey);
  const requestRefs = new Map<string, string>();
  const unitRefs = new Map<string, string>();
  const sourceRefs = new Map<string, string>();
  const obligationRefs = new Map<string, string>();
  const analysisRefs = new Map<string, string>();
  const gaps: RecordGap[] = [];
  const timelineEntries: TimelineEntry[] = [];
  const projectCreatedAt = optionalInstant(
    projection.project.createdAt,
    "project.createdAt",
  );
  const projectDisplayName = safeText(
    projection.project.displayName ?? "Project record",
    "project.displayName",
    configuredLimits,
  );
  if (projection.project.createdAt === null) {
    gaps.push({
      recordRef: projectReference,
      category: "project",
      status: "incomplete",
      reason: "The persisted project does not include a creation timestamp.",
    });
  } else {
    timelineEntries.push({
      recordRef: projectReference,
      kind: "project",
      occurredAt: projectCreatedAt as string,
      attribution: "provider-reviewed",
      summary: `Project created: ${projectDisplayName}`,
    });
  }

  const requests = projection.requests.map((request) => {
    const reference = reserveRef("request", request.requestKey);
    requestRefs.set(request.requestKey, reference);
    const occurredAt = optionalInstant(request.createdAt, "request.createdAt");
    const title = safeText(
      request.title ?? "Untitled request",
      "request.title",
      configuredLimits,
    );
    if (request.createdAt === null) {
      gaps.push({
        recordRef: reference,
        category: "request",
        status: "incomplete",
        reason: "The persisted request does not include a creation timestamp.",
      });
    } else {
      timelineEntries.push({
        recordRef: reference,
        kind: "request",
        occurredAt: occurredAt as string,
        attribution: "provider-reviewed",
        summary: `Request created: ${title}`,
      });
    }
    return {
      recordRef: reference,
      occurredAt,
      attribution: "provider-reviewed" as const,
      title,
    };
  }).sort(compareOccurred);

  for (const unit of projection.units) {
    if (!requestRefs.has(unit.requestKey)) {
      fail(
        "INCOMPLETE_PROJECTION",
        "A unit references a request missing from the projection",
      );
    }
    unitRefs.set(
      unit.unitKey,
      reserveRef("unit", unit.requestKey, unit.unitKey),
    );
  }

  const sources = projection.sources.map((source) => {
    const version = integer(source.version, "source.version", 1);
    const reference = reserveRef("source", source.sourceKey, version);
    sourceRefs.set(`${source.sourceKey}:${version}`, reference);
    const occurredAt = instant(source.recordedAt, "source.recordedAt");
    const redacted = source.sourceKind === "provider-note";
    const attribution = sourceAttribution(source);
    const availability: RecordExportV1["facts"]["sources"][number]["availability"] =
      redacted ? "redacted" : source.availability;
    const contentStatus: RecordExportV1["facts"]["sources"][number]["contentStatus"] = redacted
      ? "redacted"
      : source.availability === "unavailable"
        ? "unavailable"
        : source.availability === "partial"
          ? "partially-unavailable"
          : "not-exported";
    if (redacted) {
      gaps.push({
        recordRef: reference,
        category: "source",
        status: "redacted",
        reason: "Private provider-note content is not included in this export.",
      });
    } else if (source.availability === "unavailable") {
      gaps.push({
        recordRef: reference,
        category: "source",
        status: "unavailable",
        reason: "The persisted source is unavailable; no text was reconstructed.",
      });
    }
    for (const unavailable of source.unavailableParts) {
      gaps.push({
        recordRef: reference,
        category: "source",
        status: "unavailable",
        reason: `${safeText(
          unavailable.label,
          "source.unavailablePart.label",
          configuredLimits,
        )}: ${safeText(
          unavailable.reason,
          "source.unavailablePart.reason",
          configuredLimits,
        )}`,
      });
    }
    timelineEntries.push({
      recordRef: reference,
      kind: "source",
      occurredAt,
      attribution,
      summary: redacted
        ? "Private provider note recorded (content redacted)"
        : `Source ${source.availability} (${safeText(
          source.provenanceOrigin,
          "source.provenanceOrigin",
          configuredLimits,
        )})`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution,
      sourceRef: reference,
      version,
      sourceKind: redacted
        ? "redacted-provider-note" as const
        : source.sourceKind,
      availability,
      mediaType: redacted || source.mediaType === null
        ? null
        : safeText(
          source.mediaType,
          "source.mediaType",
          configuredLimits,
        ),
      provenanceOrigin: safeText(
        source.provenanceOrigin,
        "source.provenanceOrigin",
        configuredLimits,
      ),
      contentStatus,
    };
  }).sort(compareOccurred);

  const resolveRequest = (key: string): string => {
    const reference = requestRefs.get(key);
    if (!reference) {
      fail("INCOMPLETE_PROJECTION", "A fact references an unknown request");
    }
    return reference;
  };
  const resolveUnit = (key: string): string => {
    const reference = unitRefs.get(key);
    if (!reference) {
      fail("INCOMPLETE_PROJECTION", "A fact references an unknown unit");
    }
    return reference;
  };
  const resolveSource = (key: string, version: number): string => {
    const reference = sourceRefs.get(`${key}:${version}`);
    if (!reference) {
      fail("INCOMPLETE_PROJECTION", "A fact references an unknown source");
    }
    return reference;
  };

  const drafts = projection.drafts.map((draft) => {
    const reference = reserveRef("draft", draft.unitKey, draft.revision);
    const occurredAt = instant(draft.createdAt, "draft.createdAt");
    const title = safeText(draft.title, "draft.title", configuredLimits);
    timelineEntries.push({
      recordRef: reference,
      kind: "draft",
      occurredAt,
      attribution: "provider-reviewed",
      summary: `Draft revision ${draft.revision}: ${title}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "provider-reviewed" as const,
      requestRef: resolveRequest(draft.requestKey),
      unitRef: resolveUnit(draft.unitKey),
      revision: integer(draft.revision, "draft.revision", 1),
      state: draft.state,
      title,
      summary: safeText(draft.summary, "draft.summary", configuredLimits),
      scope: draft.scope.map((item) =>
        safeText(item, "draft.scope", configuredLimits)),
      exclusions: draft.exclusions.map((item) =>
        safeText(item, "draft.exclusions", configuredLimits)),
      sourceRefs: draft.sourceKeys.map((source) =>
        resolveSource(source.sourceKey, source.version)),
    };
  }).sort(compareOccurred);

  const publications = projection.publications.map((publication) => {
    const reference = reserveRef(
      "publication",
      publication.unitKey,
      publication.version,
    );
    const occurredAt = instant(
      publication.publishedAt,
      "publication.publishedAt",
    );
    const title = safeText(
      publication.title,
      "publication.title",
      configuredLimits,
    );
    timelineEntries.push({
      recordRef: reference,
      kind: "publication",
      occurredAt,
      attribution: "provider-reviewed",
      summary: `Published version ${publication.version}: ${title}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "provider-reviewed" as const,
      requestRef: resolveRequest(publication.requestKey),
      unitRef: resolveUnit(publication.unitKey),
      version: integer(publication.version, "publication.version", 1),
      title,
      scope: publication.scope.map((item) =>
        safeText(item, "publication.scope", configuredLimits)),
      exclusions: publication.exclusions.map((item) =>
        safeText(item, "publication.exclusions", configuredLimits)),
      rationale: safeText(
        publication.rationale,
        "publication.rationale",
        configuredLimits,
      ),
      treatment: publication.treatment,
      timingDescription: safeText(
        publication.timingDescription,
        "publication.timingDescription",
        configuredLimits,
      ),
      deliveryDependencies: publication.deliveryDependencies.map((item) =>
        safeText(item, "publication.deliveryDependencies", configuredLimits)),
      sourceRefs: publication.sourceKeys.map((source) =>
        resolveSource(source.sourceKey, source.version)),
      money: publication.money === null
        ? null
        : {
          currency: "USD" as const,
          gross: exactMoney(publication.money.gross, "publication.money.gross"),
        },
    };
  }).sort(compareOccurred);

  const responseByCorrection = new Map<
    string,
    RecordExportV1["facts"]["corrections"][number]["responses"][number][]
  >();
  for (const response of projection.correctionResponses) {
    const reference = reserveRef(
      "correction-response",
      response.correctionKey,
      response.revision,
    );
    const recordedAt = instant(
      response.recordedAt,
      "correctionResponse.recordedAt",
    );
    const mapped = {
      recordRef: reference,
      revision: integer(response.revision, "correctionResponse.revision", 1),
      disposition: response.disposition,
      sourceReview: safeText(
        response.sourceReview,
        "correctionResponse.sourceReview",
        configuredLimits,
      ),
      explanation: safeText(
        response.explanation,
        "correctionResponse.explanation",
        configuredLimits,
      ),
      recordedAt,
      attribution: "provider-reviewed" as const,
    };
    const existing = responseByCorrection.get(response.correctionKey) ?? [];
    existing.push(mapped);
    responseByCorrection.set(response.correctionKey, existing);
    timelineEntries.push({
      recordRef: reference,
      kind: "correction-response",
      occurredAt: recordedAt,
      attribution: "provider-reviewed",
      summary: `Provider response ${response.revision}: ${response.disposition}`,
    });
  }

  const corrections = projection.corrections.map((correction) => {
    const reference = reserveRef("correction", correction.correctionKey);
    const occurredAt = instant(
      correction.admittedAt,
      "correction.admittedAt",
    );
    timelineEntries.push({
      recordRef: reference,
      kind: "correction",
      occurredAt,
      attribution: "client-supplied",
      summary: `Client correction recorded (${correction.scope} impact)`,
    });
    if (correction.sourceAvailability === "unavailable") {
      gaps.push({
        recordRef: reference,
        category: "source",
        status: "unavailable",
        reason: "A correction cites an unavailable source; no text was reconstructed.",
      });
    }
    return {
      recordRef: reference,
      occurredAt,
      attribution: "client-supplied" as const,
      requestRef: resolveRequest(correction.requestKey),
      unitRef: resolveUnit(correction.unitKey),
      scope: correction.scope,
      statement: safeText(
        correction.statement,
        "correction.statement",
        configuredLimits,
      ),
      claimedSourceType: safeText(
        correction.claimedSourceType,
        "correction.claimedSourceType",
        configuredLimits,
      ),
      sourceAvailability: correction.sourceAvailability,
      sourceGapExplanation: correction.sourceGapExplanation === null
        ? null
        : safeText(
          correction.sourceGapExplanation,
          "correction.sourceGapExplanation",
          configuredLimits,
        ),
      responses: (responseByCorrection.get(correction.correctionKey) ?? [])
        .sort((left, right) => left.revision - right.revision),
    };
  }).sort(compareOccurred);
  const projectedCorrectionKeys = new Set(
    projection.corrections.map((correction) => correction.correctionKey),
  );
  for (const correctionKey of responseByCorrection.keys()) {
    if (!projectedCorrectionKeys.has(correctionKey)) {
      fail(
        "INCOMPLETE_PROJECTION",
        "A correction response has no projected correction",
      );
    }
  }

  const questions = projection.questions.map((question) => {
    const reference = reserveRef("question", question.questionKey);
    const occurredAt = instant(question.askedAt, "question.askedAt");
    timelineEntries.push({
      recordRef: reference,
      kind: "question",
      occurredAt,
      attribution: "client-supplied",
      summary: "Client question recorded (communication only)",
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "client-supplied" as const,
      requestRef: resolveRequest(question.requestKey),
      unitRef: resolveUnit(question.unitKey),
      unitVersion: integer(question.unitVersion, "question.unitVersion", 1),
      exactText: safeText(
        question.exactText,
        "question.exactText",
        configuredLimits,
      ),
      modelProcessing: question.modelProcessing,
      communicationEffect: "communication-only" as const,
    };
  }).sort(compareOccurred);

  const correctionsByKey = new Map(
    projection.corrections.map((correction) => [
      correction.correctionKey,
      recordRef("correction", correction.correctionKey),
    ]),
  );
  const agreements = projection.decisions.map((decision) => {
    const reference = reserveRef(
      "agreement",
      decision.unitKey,
      decision.version,
    );
    const occurredAt = instant(decision.recordedAt, "decision.recordedAt");
    timelineEntries.push({
      recordRef: reference,
      kind: "agreement",
      occurredAt,
      attribution: "client-decided",
      summary: `Client decision: ${decision.decision} version ${decision.version}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "client-decided" as const,
      unitRef: resolveUnit(decision.unitKey),
      version: integer(decision.version, "decision.version", 1),
      decision: decision.decision,
      attestationStatement: safeText(
        decision.attestationStatement,
        "decision.attestationStatement",
        configuredLimits,
      ),
      resolvedCorrectionRefs: decision.resolvedCorrections.map((resolution) => {
        const correctionReference = correctionsByKey.get(resolution.correctionKey);
        if (!correctionReference) {
          fail(
            "INCOMPLETE_PROJECTION",
            "A decision resolves an unknown correction",
          );
        }
        return `${correctionReference}:response-${integer(
          resolution.responseRevision,
          "decision.responseRevision",
          1,
        )}`;
      }),
    };
  }).sort(compareOccurred);

  const obligationKeys = new Set(
    projection.obligations.map((obligation) => obligation.obligationKey),
  );
  const obligations = projection.obligations.map((obligation) => {
    if (
      obligation.replacesObligationKey !== null
      && !obligationKeys.has(obligation.replacesObligationKey)
    ) {
      fail(
        "INCOMPLETE_PROJECTION",
        "An obligation replaces a record missing from the projection",
      );
    }
    const reference = reserveRef("obligation", obligation.obligationKey);
    obligationRefs.set(obligation.obligationKey, reference);
    const occurredAt = instant(obligation.recordedAt, "obligation.recordedAt");
    timelineEntries.push({
      recordRef: reference,
      kind: "obligation",
      occurredAt,
      attribution: "system-recorded",
      summary: `Payment obligation recorded: USD ${obligation.gross}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "system-recorded" as const,
      unitRef: resolveUnit(obligation.unitKey),
      version: integer(obligation.version, "obligation.version", 1),
      currency: "USD" as const,
      gross: exactMoney(obligation.gross, "obligation.gross"),
      collectible: obligation.collectible,
      replacesObligationRef: obligation.replacesObligationKey === null
        ? null
        : recordRef("obligation", obligation.replacesObligationKey),
    };
  }).sort(compareOccurred);

  const payments = projection.payments.map((payment) => {
    const obligationReference = obligationRefs.get(payment.obligationKey);
    if (!obligationReference) {
      fail("INCOMPLETE_PROJECTION", "A payment references an unknown obligation");
    }
    const reference = reserveRef("payment", payment.paymentKey);
    const occurredAt = instant(payment.verifiedAt, "payment.verifiedAt");
    const attribution: Attribution = payment.verification === "paypal-verified"
      ? "paypal-verified"
      : "system-recorded";
    timelineEntries.push({
      recordRef: reference,
      kind: "payment",
      occurredAt,
      attribution,
      summary: payment.verification === "paypal-verified"
        ? `PayPal-verified payment: USD ${payment.gross}`
        : `Synthetic payment proof: USD ${payment.gross}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution,
      obligationRef: obligationReference,
      unitRef: resolveUnit(payment.unitKey),
      version: integer(payment.version, "payment.version", 1),
      currency: "USD" as const,
      gross: exactMoney(payment.gross, "payment.gross"),
      verification: payment.verification,
    };
  }).sort(compareOccurred);

  const readiness = projection.units.map((unit) => {
    const reference = reserveRef("readiness", unit.unitKey);
    const unitReference = resolveUnit(unit.unitKey);
    const activeHolds = projection.holds.filter(
      (hold) => hold.unitKey === unit.unitKey && hold.active,
    );
    const acceptedPublication = unit.acceptedVersion === null
      ? null
      : projection.publications.find(
        (publication) =>
          publication.unitKey === unit.unitKey
          && publication.version === unit.acceptedVersion,
      ) ?? null;
    if (unit.acceptedVersion !== null && acceptedPublication === null) {
      fail(
        "INCOMPLETE_PROJECTION",
        "An accepted version is missing its publication",
      );
    }
    const acceptedObligations = unit.acceptedVersion === null
      ? []
      : projection.obligations.filter(
        (obligation) =>
          obligation.unitKey === unit.unitKey
          && obligation.version === unit.acceptedVersion
          && obligation.collectible,
      );
    const paid = acceptedObligations.some((obligation) =>
      projection.payments.some(
        (payment) => payment.obligationKey === obligation.obligationKey,
      ));
    const expectedPrerequisites = acceptedPublication?.prerequisiteKeys ?? [];
    const prerequisitesSatisfied = expectedPrerequisites.every((key) =>
      projection.prerequisites.some(
        (prerequisite) =>
          prerequisite.unitKey === unit.unitKey
          && prerequisite.version === unit.acceptedVersion
          && prerequisite.prerequisiteKey === key
          && prerequisite.satisfied,
      ));
    const status = activeHolds.length > 0
      ? "review-hold" as const
      : unit.acceptedVersion === null
        ? "awaiting-agreement" as const
        : acceptedPublication?.treatment === "payable" && !paid
          ? "awaiting-payment" as const
          : !prerequisitesSatisfied
            ? "awaiting-prerequisite" as const
            : "recorded-basis-ready" as const;
    const occurredAt = lastInstant([
      ...projection.publications
        .filter((item) => item.unitKey === unit.unitKey)
        .map((item) => instant(item.publishedAt, "publication.publishedAt")),
      ...projection.decisions
        .filter((item) => item.unitKey === unit.unitKey)
        .map((item) => instant(item.recordedAt, "decision.recordedAt")),
      ...projection.payments
        .filter((item) => item.unitKey === unit.unitKey)
        .map((item) => instant(item.verifiedAt, "payment.verifiedAt")),
      ...projection.holds
        .filter((item) => item.unitKey === unit.unitKey)
        .flatMap((item) => [
          instant(item.createdAt, "hold.createdAt"),
          optionalInstant(item.resolvedAt, "hold.resolvedAt"),
        ]),
      ...projection.prerequisites
        .filter((item) => item.unitKey === unit.unitKey)
        .map((item) => instant(item.recordedAt, "prerequisite.recordedAt")),
    ]);
    if (occurredAt !== null) {
      timelineEntries.push({
        recordRef: reference,
        kind: "readiness",
        occurredAt,
        attribution: "system-recorded",
        summary: `Recorded readiness basis: ${status}`,
      });
    }
    return {
      recordRef: reference,
      occurredAt,
      attribution: "system-recorded" as const,
      unitRef: unitReference,
      currentVersion: unit.currentVersion === null
        ? null
        : integer(unit.currentVersion, "unit.currentVersion", 1),
      acceptedVersion: unit.acceptedVersion === null
        ? null
        : integer(unit.acceptedVersion, "unit.acceptedVersion", 1),
      status,
      activeHoldCount: activeHolds.length,
      liveCheckRequired: true as const,
    };
  }).sort(compareOccurred);

  const workStarts = projection.workStarts.map((workStart) => {
    const reference = reserveRef("work-start", workStart.workStartKey);
    const occurredAt = instant(workStart.startedAt, "workStart.startedAt");
    timelineEntries.push({
      recordRef: reference,
      kind: "work-start",
      occurredAt,
      attribution: "provider-reviewed",
      summary: `Work start recorded for version ${workStart.version}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "provider-reviewed" as const,
      unitRef: resolveUnit(workStart.unitKey),
      version: integer(workStart.version, "workStart.version", 1),
    };
  }).sort(compareOccurred);

  const analysisCandidates = projection.analysisCandidates.map((analysis) => {
    const reference = reserveRef("analysis-candidate", analysis.analysisKey);
    analysisRefs.set(analysis.analysisKey, reference);
    const occurredAt = instant(analysis.createdAt, "analysis.createdAt");
    const attribution: Attribution = analysis.status === "candidate-ready"
      ? "ai-candidate"
      : "system-recorded";
    timelineEntries.push({
      recordRef: reference,
      kind: "analysis-candidate",
      occurredAt,
      attribution,
      summary: analysis.status === "candidate-ready"
        ? `AI candidate set recorded (${analysis.candidateCount} candidates)`
        : `Analysis run recorded: ${analysis.status}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution,
      status: analysis.status,
      candidateCount: integer(
        analysis.candidateCount,
        "analysis.candidateCount",
      ),
      humanReviewRequired: true as const,
      publicationBlocked: true as const,
    };
  }).sort(compareOccurred);

  const analysisReviews = projection.analysisReviews.map((review) => {
    const analysisReference = analysisRefs.get(review.analysisKey);
    if (!analysisReference) {
      fail(
        "INCOMPLETE_PROJECTION",
        "An analysis review references an unknown analysis run",
      );
    }
    const reference = reserveRef("analysis-review", review.reviewKey);
    const occurredAt = instant(review.reviewedAt, "analysisReview.reviewedAt");
    timelineEntries.push({
      recordRef: reference,
      kind: "analysis-review",
      occurredAt,
      attribution: "provider-reviewed",
      summary: `Provider analysis review: ${review.disposition}`,
    });
    return {
      recordRef: reference,
      occurredAt,
      attribution: "provider-reviewed" as const,
      analysisRef: analysisReference,
      disposition: review.disposition,
      note: safeText(review.note, "analysisReview.note", configuredLimits),
    };
  }).sort(compareOccurred);

  gaps.push(
    {
      recordRef: recordRef("capability", "delivery"),
      category: "delivery",
      status: "unsupported",
      reason: "This persisted schema does not record delivery facts.",
    },
    {
      recordRef: recordRef("capability", "delivery-acceptance"),
      category: "delivery-acceptance",
      status: "unsupported",
      reason: "This persisted schema does not record delivery acceptance facts.",
    },
  );

  const document: RecordExportV1 = Object.freeze({
    schemaVersion: RECORD_EXPORT_SCHEMA_VERSION,
    serializationVersion: RECORD_EXPORT_SERIALIZATION_VERSION,
    labels: RECORD_EXPORT_LABELS,
    project: Object.freeze({
      recordRef: projectReference,
      displayName: projectDisplayName,
      createdAt: projectCreatedAt,
      attribution: "provider-reviewed" as const,
    }),
    capabilities: Object.freeze({
      delivery: "unsupported" as const,
      deliveryAcceptance: "unsupported" as const,
    }),
    facts: Object.freeze({
      requests: Object.freeze(requests),
      sources: Object.freeze(sources),
      drafts: Object.freeze(drafts),
      publications: Object.freeze(publications),
      corrections: Object.freeze(corrections),
      questions: Object.freeze(questions),
      agreements: Object.freeze(agreements),
      obligations: Object.freeze(obligations),
      payments: Object.freeze(payments),
      readiness: Object.freeze(readiness),
      workStarts: Object.freeze(workStarts),
      analysisCandidates: Object.freeze(analysisCandidates),
      analysisReviews: Object.freeze(analysisReviews),
      delivery: Object.freeze([]),
      deliveryAcceptance: Object.freeze([]),
    }),
    gaps: Object.freeze(
      [...gaps].sort((left, right) =>
        compareText(left.category, right.category)
          || compareText(left.recordRef, right.recordRef)
          || compareText(left.reason, right.reason)),
    ),
    timeline: Object.freeze(timeline(timelineEntries)),
  });
  validateRecordExportV1(document);
  const json = canonicalRecordJson(document);
  if (Buffer.byteLength(json, "utf8") > configuredLimits.maxJsonBytes) {
    fail("OUTPUT_TOO_LARGE", "Canonical JSON exceeds the configured byte bound");
  }
  return document;
}

export function serializeRecordExportJson(
  document: RecordExportV1,
  options: { limits?: Partial<ExportLimits> } = {},
): string {
  const configuredLimits = limits(options.limits);
  validateRecordExportV1(document);
  const json = canonicalRecordJson(document);
  if (Buffer.byteLength(json, "utf8") > configuredLimits.maxJsonBytes) {
    fail("OUTPUT_TOO_LARGE", "Canonical JSON exceeds the configured byte bound");
  }
  return json;
}

export async function exportProjectRecords(
  reader: RecordsProjectionReader,
  scope: ProjectScope,
  options: { limits?: Partial<ExportLimits> } = {},
): Promise<ProjectRecordExport> {
  validateScope(scope);
  const configuredLimits = limits(options.limits);
  const projection = await reader.readProject(scope, configuredLimits);
  const document = buildRecordExportV1(projection, {
    limits: configuredLimits,
  });
  const json = serializeRecordExportJson(document, {
    limits: configuredLimits,
  });
  const html = renderRecordExportHtml(document, {
    limits: configuredLimits,
  });
  return Object.freeze({ document, json, html });
}
