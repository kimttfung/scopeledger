import { createHash } from "node:crypto";
import type {
  SourceIntakeInput,
  SourceIntakeRecord,
} from "@scopeledger/db";
import type {
  PutSourceObjectInput,
  PutSourceObjectResult,
} from "@scopeledger/object-storage-adapter";

export const MAX_SOURCE_BYTES = 10_000_000;
export const MAX_SOURCE_MULTIPART_BYTES = MAX_SOURCE_BYTES + 256_000;

const allowedFields = new Set([
  "file",
  "projectRequestLocator",
  "provenanceOrigin",
  "originReference",
  "contentAttestation",
  "acceptanceBasis",
  "studioSharing",
  "modelProcessing",
  "modelInputReviewStatus",
  "modelReviewBasis",
]);
const allowedMediaTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
]);
const provenanceOrigins = new Set([
  "agreement",
  "amendment",
  "correspondence",
  "request",
  "prior-decision",
  "correction",
  "other",
]);
const permissionStates = new Set([
  "permitted",
  "denied",
  "unresolved",
]);
const modelReviewStatuses = new Set([
  "cleared",
  "not-reviewed",
  "unresolved",
  "prohibited-financial-data",
]);
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

type ProviderAccess =
  | Readonly<{ ok: true; subjectDigest: string }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type ProviderSourceTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  requestId: string;
  providerActorId: string;
  grantAction: "inspect" | "publish";
  grantEpoch: number;
}>;

export type TargetAuthorization =
  | "authorized"
  | "scope-not-found"
  | "grant-required";

export type ProviderSourceSummary = Readonly<{
  locator: string;
  displayReference: string;
  originalName: string | null;
  mediaType: string;
  byteLength: number;
  provenanceOrigin: SourceIntakeRecord["provenance"]["origin"];
  originReference: string | null;
  studioSharing: SourceIntakeRecord["permissions"]["studioSharing"];
  modelProcessing: SourceIntakeRecord["permissions"]["modelProcessing"];
  modelInputReviewStatus:
    SourceIntakeRecord["permissions"]["modelInputReview"]["status"];
  recordedAt: string;
}>;

export type ProviderSourceDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAccess>;
  resolveTarget: (
    locator: string,
    action: ProviderSourceTarget["grantAction"],
  ) => ProviderSourceTarget | null;
  authorizeTarget: (
    target: ProviderSourceTarget,
  ) => Promise<TargetAuthorization>;
  listSourceIntake: (
    target: ProviderSourceTarget,
  ) => Promise<readonly SourceIntakeRecord[]>;
  putSourceObject: (
    input: PutSourceObjectInput,
  ) => Promise<PutSourceObjectResult>;
  persistSourceIntake: (
    input: SourceIntakeInput,
  ) => Promise<Readonly<{
    duplicate: boolean;
    source: SourceIntakeRecord;
  }>>;
  now: () => Date;
}>;

export type ProviderSourceSubmission = Readonly<{
  file: File;
  projectRequestLocator: string;
  provenanceOrigin: SourceIntakeInput["provenance"]["origin"];
  originReference: string | null;
  acceptanceBasis: string;
  studioSharing: SourceIntakeInput["permissions"]["studioSharing"];
  modelProcessing: SourceIntakeInput["permissions"]["modelProcessing"];
  modelInputReviewStatus:
    SourceIntakeInput["permissions"]["modelInputReview"]["status"];
  modelReviewBasis: string;
}>;

type ValidationFailure = Readonly<{
  ok: false;
  status: number;
  code: string;
  message: string;
}>;

type ValidationSuccess<T> = Readonly<{
  ok: true;
  value: T;
}>;

type FormValue = string | File;

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const sourceIdPattern = /^source_([a-f0-9]{32})_([a-f0-9]{48})$/u;
const sourceLocatorPattern = /^sl1_([A-Za-z0-9_-]{1,152})$/u;

function json(body: object, status: number): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function failure(
  status: number,
  code: string,
  message: string,
): ValidationFailure {
  return { ok: false, status, code, message };
}

function isFile(value: FormValue): value is File {
  return value instanceof Blob
    && "name" in value
    && typeof value.name === "string";
}

function exactlyOne(
  formData: FormData,
  name: string,
): FormValue | null {
  const values = formData.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

function validText(
  value: string,
  maximum: number,
  options: Readonly<{
    allowEmpty?: boolean;
    allowLines?: boolean;
    requireTrimmed?: boolean;
  }> = {},
): boolean {
  const points = Array.from(value);
  const controls = options.allowLines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  return points.length <= maximum
    && (options.allowEmpty === true || value.trim().length > 0)
    && (options.requireTrimmed !== true || value === value.trim())
    && !invalidUnicode.test(value)
    && !controls.test(value);
}

function requiredString(
  formData: FormData,
  name: string,
): string | null {
  const value = exactlyOne(formData, name);
  return typeof value === "string" ? value : null;
}

export function validateProviderSourceHeaders(
  headers: Headers,
): ValidationFailure | ValidationSuccess<null> {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return failure(
      415,
      "MULTIPART_REQUIRED",
      "Upload one source using multipart form data.",
    );
  }
  const rawLength = headers.get("content-length");
  if (!rawLength || !/^[0-9]+$/u.test(rawLength)) {
    return failure(
      411,
      "CONTENT_LENGTH_REQUIRED",
      "A bounded upload length is required.",
    );
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return failure(
      400,
      "INVALID_CONTENT_LENGTH",
      "The upload length is invalid.",
    );
  }
  if (contentLength > MAX_SOURCE_MULTIPART_BYTES) {
    return failure(
      413,
      "SOURCE_TOO_LARGE",
      "The source must be 10 MB or smaller.",
    );
  }
  return { ok: true, value: null };
}

export function validateProviderSourceFormData(
  formData: FormData,
): ValidationFailure | ValidationSuccess<ProviderSourceSubmission> {
  if ([...formData.keys()].some((name) => !allowedFields.has(name))) {
    return failure(
      400,
      "UNEXPECTED_FORM_FIELD",
      "The source upload contains an unsupported field.",
    );
  }

  const file = exactlyOne(formData, "file");
  const projectRequestLocator = requiredString(
    formData,
    "projectRequestLocator",
  );
  const provenanceOrigin = requiredString(formData, "provenanceOrigin");
  const originReferenceValue = requiredString(formData, "originReference");
  const contentAttestation = requiredString(formData, "contentAttestation");
  const acceptanceBasis = requiredString(formData, "acceptanceBasis");
  const studioSharing = requiredString(formData, "studioSharing");
  const modelProcessing = requiredString(formData, "modelProcessing");
  const modelInputReviewStatus = requiredString(
    formData,
    "modelInputReviewStatus",
  );
  const modelReviewBasis = requiredString(formData, "modelReviewBasis");

  if (
    file === null
    || projectRequestLocator === null
    || provenanceOrigin === null
    || originReferenceValue === null
    || contentAttestation === null
    || acceptanceBasis === null
    || studioSharing === null
    || modelProcessing === null
    || modelInputReviewStatus === null
    || modelReviewBasis === null
  ) {
    return failure(
      400,
      "INVALID_SOURCE_FORM",
      "The source upload is incomplete or contains duplicate fields.",
    );
  }
  if (!isFile(file) || file.size < 1) {
    return failure(422, "SOURCE_REQUIRED", "Choose one non-empty source.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return failure(
      413,
      "SOURCE_TOO_LARGE",
      "The source must be 10 MB or smaller.",
    );
  }
  if (
    !validText(file.name, 255, { requireTrimmed: true })
    || !validText(projectRequestLocator, 200, { requireTrimmed: true })
  ) {
    return failure(
      422,
      "INVALID_SOURCE_METADATA",
      "The source filename or project locator is invalid.",
    );
  }

  const mediaType = file.type.toLowerCase();
  if (!allowedMediaTypes.has(mediaType)) {
    return failure(
      415,
      "UNSUPPORTED_SOURCE_MEDIA_TYPE",
      "Only PDF, plain text, and Markdown sources are supported.",
    );
  }
  if (!provenanceOrigins.has(provenanceOrigin)) {
    return failure(
      422,
      "INVALID_PROVENANCE",
      "The source provenance is invalid.",
    );
  }
  if (
    !validText(originReferenceValue, 2_000, {
      allowEmpty: true,
      allowLines: true,
    })
    || !validText(acceptanceBasis, 2_000, { allowLines: true })
    || !validText(modelReviewBasis, 2_000, { allowLines: true })
  ) {
    return failure(
      422,
      "INVALID_SOURCE_ATTESTATION",
      "The source attestation is invalid or too long.",
    );
  }
  if (contentAttestation !== "provider-permitted-source") {
    return failure(
      422,
      "CONTENT_ATTESTATION_REQUIRED",
      "Confirm that the provider may import this source.",
    );
  }
  if (
    !permissionStates.has(studioSharing)
    || !permissionStates.has(modelProcessing)
    || !modelReviewStatuses.has(modelInputReviewStatus)
  ) {
    return failure(
      422,
      "INVALID_SOURCE_PERMISSIONS",
      "The source permissions are invalid.",
    );
  }
  if (
    (modelProcessing === "permitted")
    !== (modelInputReviewStatus === "cleared")
  ) {
    return failure(
      422,
      "INVALID_MODEL_REVIEW",
      "Model permission requires an explicit cleared review.",
    );
  }

  return {
    ok: true,
    value: {
      file,
      projectRequestLocator,
      provenanceOrigin:
        provenanceOrigin as ProviderSourceSubmission["provenanceOrigin"],
      originReference: originReferenceValue === ""
        ? null
        : originReferenceValue,
      acceptanceBasis,
      studioSharing:
        studioSharing as ProviderSourceSubmission["studioSharing"],
      modelProcessing:
        modelProcessing as ProviderSourceSubmission["modelProcessing"],
      modelInputReviewStatus:
        modelInputReviewStatus as ProviderSourceSubmission["modelInputReviewStatus"],
      modelReviewBasis,
    },
  };
}

async function sourceBytes(
  submission: ProviderSourceSubmission,
): Promise<ValidationFailure | ValidationSuccess<Uint8Array>> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await submission.file.arrayBuffer());
  } catch {
    return failure(
      400,
      "INVALID_SOURCE_BYTES",
      "The source bytes could not be read.",
    );
  }
  if (
    bytes.byteLength < 1
    || bytes.byteLength !== submission.file.size
    || bytes.byteLength > MAX_SOURCE_BYTES
  ) {
    return failure(
      bytes.byteLength > MAX_SOURCE_BYTES ? 413 : 400,
      bytes.byteLength > MAX_SOURCE_BYTES
        ? "SOURCE_TOO_LARGE"
        : "INVALID_SOURCE_BYTES",
      bytes.byteLength > MAX_SOURCE_BYTES
        ? "The source must be 10 MB or smaller."
        : "The source bytes are invalid.",
    );
  }

  if (submission.file.type === "application/pdf") {
    const signature = new TextDecoder("ascii").decode(bytes.subarray(0, 5));
    if (signature !== "%PDF-") {
      return failure(
        415,
        "INVALID_PDF_SOURCE",
        "The uploaded PDF does not have a valid PDF signature.",
      );
    }
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) {
        return failure(
          415,
          "INVALID_TEXT_SOURCE",
          "Text sources must contain valid UTF-8 text.",
        );
      }
    } catch {
      return failure(
        415,
        "INVALID_TEXT_SOURCE",
        "Text sources must contain valid UTF-8 text.",
      );
    }
  }
  return { ok: true, value: bytes };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function providerSourceScopePrefix(
  target: Pick<ProviderSourceTarget, "workspaceId" | "projectId" | "requestId">,
): string {
  const scopeDigest = sha256(JSON.stringify([
    target.workspaceId,
    target.projectId,
    target.requestId,
  ]));
  return `source_${scopeDigest.slice(0, 32)}_`;
}

export function formatProviderSourceLocator(
  source: Readonly<{ sourceId: string; version: number }>,
): string {
  return `sl1_${Buffer.from(
    `${source.sourceId}\u0000${source.version}`,
    "utf8",
  ).toString("base64url")}`;
}

export function parseProviderSourceLocator(
  locator: string,
): Readonly<{ sourceId: string; version: number }> | null {
  const match = sourceLocatorPattern.exec(locator);
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = decoded.split("\u0000");
  if (
    parts.length !== 2
    || !parts[0]
    || !parts[1]
    || !sourceIdPattern.test(parts[0])
    || !/^[1-9][0-9]{0,9}$/u.test(parts[1])
  ) {
    return null;
  }
  const version = Number(parts[1]);
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || version > 2_147_483_647
  ) {
    return null;
  }
  return Object.freeze({ sourceId: parts[0], version });
}

export function providerSourceDisplayReference(
  source: Readonly<{ sourceId: string; version: number }>,
): string {
  return `SRC-${source.sourceId.slice(-8).toUpperCase()} · v${source.version}`;
}

function sourceSummary(source: SourceIntakeRecord): ProviderSourceSummary {
  return Object.freeze({
    locator: formatProviderSourceLocator(source),
    displayReference: providerSourceDisplayReference(source),
    originalName: source.originalName,
    mediaType: source.mediaType,
    byteLength: source.declaredByteLength,
    provenanceOrigin: source.provenance.origin,
    originReference: source.provenance.originReference,
    studioSharing: source.permissions.studioSharing,
    modelProcessing: source.permissions.modelProcessing,
    modelInputReviewStatus: source.permissions.modelInputReview.status,
    recordedAt: source.recordedAt.toISOString(),
  });
}

function sourceIdentity(input: Readonly<{
  target: ProviderSourceTarget;
  subjectDigest: string;
  submission: ProviderSourceSubmission;
  contentDigest: string;
}>): Readonly<{ sourceId: string; version: 1; versionId: "1" }> {
  const digest = sha256(JSON.stringify({
    workspaceId: input.target.workspaceId,
    projectId: input.target.projectId,
    requestId: input.target.requestId,
    subjectDigest: input.subjectDigest,
    filename: input.submission.file.name,
    mediaType: input.submission.file.type,
    contentDigest: input.contentDigest,
    provenanceOrigin: input.submission.provenanceOrigin,
    originReference: input.submission.originReference,
    acceptanceBasis: input.submission.acceptanceBasis,
    studioSharing: input.submission.studioSharing,
    modelProcessing: input.submission.modelProcessing,
    modelInputReviewStatus: input.submission.modelInputReviewStatus,
    modelReviewBasis: input.submission.modelReviewBasis,
  }));
  return {
    sourceId: `${providerSourceScopePrefix(input.target)}${digest.slice(0, 48)}`,
    version: 1,
    versionId: "1",
  };
}

function authorizationResponse(
  authorization: Exclude<TargetAuthorization, "authorized">,
): Response {
  if (authorization === "scope-not-found") {
    return json({
      ok: false,
      code: "SOURCE_SCOPE_NOT_FOUND",
      message: "The selected provider project request is not available.",
    }, 404);
  }
  return json({
    ok: false,
    code: "PROVIDER_GRANT_REQUIRED",
    message: "The protected provider product grant is not active.",
  }, 403);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function storageFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "CONFLICT":
    case "INTEGRITY_VIOLATION":
      return json({
        ok: false,
        code: "SOURCE_STORAGE_CONFLICT",
        message: "The immutable source binding conflicts with stored data.",
      }, 409);
    case "INVALID_INPUT":
    case "SIZE_LIMIT_EXCEEDED":
      return json({
        ok: false,
        code: "INVALID_SOURCE_STORAGE_INPUT",
        message: "The source could not be admitted to private storage.",
      }, 422);
    default:
      return json({
        ok: false,
        code: "SOURCE_STORAGE_UNAVAILABLE",
        message: "Private source storage is unavailable.",
      }, 503);
  }
}

function persistenceFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "SOURCE_CONFLICT":
      return json({
        ok: false,
        code: "SOURCE_INTAKE_CONFLICT",
        message: "The immutable source intake identity conflicts with stored metadata.",
      }, 409);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "SOURCE_SCOPE_CHANGED",
        message: "The provider project scope changed before intake completed.",
      }, 409);
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_SOURCE_INTAKE",
        message: "The source intake metadata is invalid.",
      }, 422);
    default:
      return json({
        ok: false,
        code: "SOURCE_INTAKE_UNAVAILABLE",
        message: "Durable source intake is unavailable.",
      }, 503);
  }
}

async function providerIdentity(
  dependencies: ProviderSourceDependencies,
  action: "listing" | "uploading",
): Promise<Extract<ProviderAccess, { ok: true }> | Response> {
  try {
    const provider = await dependencies.verifyProvider();
    if (!provider.ok) {
      const message = provider.code === "AUTHENTICATION_REQUIRED"
        ? `Sign in before ${action} provider sources.`
        : provider.code === "PROVIDER_ASSURANCE_REQUIRED"
          ? "Verified email and MFA assurance are required."
          : "Provider authentication is unavailable.";
      return json(
        { ok: false, code: provider.code, message },
        provider.status,
      );
    }
    if (!/^[a-f0-9]{64}$/u.test(provider.subjectDigest)) {
      return json({
        ok: false,
        code: "AUTHENTICATION_UNAVAILABLE",
        message: "Provider authentication is unavailable.",
      }, 503);
    }
    return provider;
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
}

function queryValue(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  return values.length === 1 ? values[0] ?? null : null;
}

export async function handleProviderSourcesGet(
  request: Request,
  dependencies: ProviderSourceDependencies,
): Promise<Response> {
  const provider = await providerIdentity(dependencies, "listing");
  if (provider instanceof Response) return provider;

  const url = new URL(request.url);
  if ([...url.searchParams.keys()].some((key) =>
    key !== "projectId" && key !== "requestId")) {
    return json({
      ok: false,
      code: "INVALID_SOURCE_SCOPE",
      message: "Select one provider project and request.",
    }, 422);
  }
  const projectId = queryValue(url, "projectId");
  const requestId = queryValue(url, "requestId");
  if (
    !projectId
    || !requestId
    || !identifierPattern.test(projectId)
    || !identifierPattern.test(requestId)
  ) {
    return json({
      ok: false,
      code: "INVALID_SOURCE_SCOPE",
      message: "Select one provider project and request.",
    }, 422);
  }
  const target = dependencies.resolveTarget(
    `${projectId}/${requestId}`,
    "inspect",
  );
  if (!target) return authorizationResponse("scope-not-found");

  let authorization: TargetAuthorization;
  try {
    authorization = await dependencies.authorizeTarget(target);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_SCOPE_UNAVAILABLE",
      message: "The provider project scope is unavailable.",
    }, 503);
  }
  if (authorization !== "authorized") {
    return authorizationResponse(authorization);
  }

  try {
    const sources = await dependencies.listSourceIntake(target);
    return json({
      ok: true,
      sources: sources
        .filter((source) => source.availability === "available")
        .map(sourceSummary),
    }, 200);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_INTAKE_UNAVAILABLE",
      message: "Durable source intake is unavailable.",
    }, 503);
  }
}

export async function handleProviderSourcePost(
  request: Request,
  dependencies: ProviderSourceDependencies,
): Promise<Response> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This upload must originate from the ScopeLedger application.",
    }, 403);
  }

  const provider = await providerIdentity(dependencies, "uploading");
  if (provider instanceof Response) return provider;

  const headerValidation = validateProviderSourceHeaders(request.headers);
  if (!headerValidation.ok) {
    return json({
      ok: false,
      code: headerValidation.code,
      message: headerValidation.message,
    }, headerValidation.status);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({
      ok: false,
      code: "INVALID_MULTIPART",
      message: "The multipart source upload could not be read.",
    }, 400);
  }
  const formValidation = validateProviderSourceFormData(formData);
  if (!formValidation.ok) {
    return json({
      ok: false,
      code: formValidation.code,
      message: formValidation.message,
    }, formValidation.status);
  }
  const submission = formValidation.value;
  const target = dependencies.resolveTarget(
    submission.projectRequestLocator,
    "publish",
  );
  if (!target) {
    return authorizationResponse("scope-not-found");
  }

  let authorization: TargetAuthorization;
  try {
    authorization = await dependencies.authorizeTarget(target);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_SCOPE_UNAVAILABLE",
      message: "The provider project scope is unavailable.",
    }, 503);
  }
  if (authorization !== "authorized") {
    return authorizationResponse(authorization);
  }

  const byteValidation = await sourceBytes(submission);
  if (!byteValidation.ok) {
    return json({
      ok: false,
      code: byteValidation.code,
      message: byteValidation.message,
    }, byteValidation.status);
  }
  const bytes = byteValidation.value;
  const contentDigest = sha256(bytes);
  const identity = sourceIdentity({
    target,
    subjectDigest: provider.subjectDigest,
    submission,
    contentDigest,
  });
  const binding = {
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    sourceId: identity.sourceId,
    versionId: identity.versionId,
  };

  let stored: PutSourceObjectResult;
  try {
    stored = await dependencies.putSourceObject({
      bytes,
      metadata: {
        binding,
        browserFilename: submission.file.name,
        mediaType: submission.file.type,
      },
    });
  } catch (error) {
    return storageFailure(error);
  }
  if (
    stored.byteLength !== bytes.byteLength
    || stored.objectId !== `sha256:${contentDigest}`
    || stored.binding.workspaceId !== binding.workspaceId
    || stored.binding.projectId !== binding.projectId
    || stored.binding.sourceId !== binding.sourceId
    || stored.binding.versionId !== binding.versionId
  ) {
    return json({
      ok: false,
      code: "SOURCE_STORAGE_CONFLICT",
      message: "The immutable source binding conflicts with stored data.",
    }, 409);
  }

  try {
    authorization = await dependencies.authorizeTarget(target);
  } catch {
    return json({
      ok: false,
      code: "SOURCE_SCOPE_UNAVAILABLE",
      message: "The provider project scope is unavailable.",
    }, 503);
  }
  if (authorization !== "authorized") {
    return authorizationResponse(authorization);
  }

  const reviewedAt = dependencies.now();
  if (!Number.isFinite(reviewedAt.getTime())) {
    return json({
      ok: false,
      code: "SOURCE_INTAKE_UNAVAILABLE",
      message: "Durable source intake is unavailable.",
    }, 503);
  }
  const modelInputReview: SourceIntakeInput["permissions"]["modelInputReview"] =
    submission.modelInputReviewStatus === "cleared"
      ? {
        status: "cleared",
        reviewerId: target.providerActorId,
        reviewedAt,
        basis: submission.modelReviewBasis,
      }
      : {
        status: submission.modelInputReviewStatus,
        basis: submission.modelReviewBasis,
      };

  let persistence: Awaited<
    ReturnType<ProviderSourceDependencies["persistSourceIntake"]>
  >;
  try {
    persistence = await dependencies.persistSourceIntake({
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      sourceId: identity.sourceId,
      version: identity.version,
      availability: "available",
      reviewedBy: target.providerActorId,
      sourceKind: "provider-upload",
      mediaType: submission.file.type,
      originalName: submission.file.name,
      declaredByteLength: bytes.byteLength,
      contentDigest,
      provenance: {
        origin: submission.provenanceOrigin,
        suppliedBy: target.providerActorId,
        originReference: submission.originReference,
        acceptance: {
          kind: "provider-attested-import",
          basis: submission.acceptanceBasis,
        },
      },
      permissions: {
        studioSharing: submission.studioSharing,
        modelProcessing: submission.modelProcessing,
        modelInputReview,
      },
    });
  } catch (error) {
    return persistenceFailure(error);
  }

  return json({
    ok: true,
    admitted: true,
    duplicate: persistence.duplicate,
    source: sourceSummary(persistence.source),
    effects: {
      modelDispatch: false,
      parserExecution: false,
      publication: false,
      agreement: false,
      payment: false,
      readiness: false,
      workStart: false,
    },
  }, persistence.duplicate ? 200 : 201);
}
