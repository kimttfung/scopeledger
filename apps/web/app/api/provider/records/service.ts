import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  RecordsExportError,
  type ProjectRecordExport,
} from "@scopeledger/records-export";

const locatorPattern = /^slr1h_[A-Za-z0-9_-]{43}$/u;
const secretPattern = /^[a-f0-9]{64}$/iu;
const MAX_PROJECT_CANDIDATES = 256;

export type ProviderRecordsAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type ProviderRecordTarget = Readonly<{
  workspaceId: string;
  projectId: string;
  displayName: string | null;
  grantEpoch: number;
}>;

export type ProviderRecordProject = Readonly<{
  projectLocator: string;
  displayName: string;
}>;

export type ProviderRecordsFailureCode =
  | "AUTHENTICATION_UNAVAILABLE"
  | "AUTHENTICATION_REQUIRED"
  | "PROVIDER_ASSURANCE_REQUIRED"
  | "PROVIDER_GRANT_REQUIRED"
  | "RECORD_NOT_AVAILABLE"
  | "RECORD_EXPORT_STATE_CHANGED"
  | "RECORD_EXPORT_TOO_LARGE"
  | "RECORDS_UNAVAILABLE";

export type ProviderRecordsFailure = Readonly<{
  ok: false;
  status: 401 | 403 | 404 | 409 | 413 | 503;
  code: ProviderRecordsFailureCode;
}>;

export type ProviderRecordsListResult =
  | Readonly<{
    ok: true;
    projects: readonly ProviderRecordProject[];
  }>
  | ProviderRecordsFailure;

export type ProviderRecordResult =
  | Readonly<{
    ok: true;
    project: ProviderRecordProject;
    exported: ProjectRecordExport;
  }>
  | ProviderRecordsFailure;

export type ProviderRecordsDependencies = Readonly<{
  verifyProvider: () => Promise<ProviderRecordsAccess>;
  verifyProductGrant: () => Promise<boolean>;
  listAuthorizedProjects: () => Promise<readonly ProviderRecordTarget[]>;
  isProjectGrantCurrent: (
    target: ProviderRecordTarget,
  ) => Promise<boolean>;
  exportProject: (
    target: ProviderRecordTarget,
  ) => Promise<ProjectRecordExport>;
  locatorCodec: ProviderRecordsLocatorCodec;
}>;

export const privateProviderRecordsHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "Surrogate-Control": "no-store",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
});

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length
    && timingSafeEqual(leftBuffer, rightBuffer);
}

function validInternalId(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTarget(target: ProviderRecordTarget): boolean {
  return validInternalId(target.workspaceId)
    && validInternalId(target.projectId)
    && Number.isSafeInteger(target.grantEpoch)
    && target.grantEpoch > 0;
}

export class ProviderRecordsLocatorCodec {
  private readonly secret: Buffer;

  constructor(secret: string) {
    if (!secretPattern.test(secret)) {
      throw new Error(
        "Provider records locator secret must be a 32-byte hexadecimal value",
      );
    }
    this.secret = Buffer.from(secret, "hex");
  }

  project(target: Pick<ProviderRecordTarget, "workspaceId" | "projectId">) {
    const digest = createHmac("sha256", this.secret)
      .update(
        [
          "scopeledger.provider-records.v1",
          target.workspaceId,
          target.projectId,
        ].join("\u0000"),
      )
      .digest("base64url");
    return `slr1h_${digest}`;
  }

  matchesProject(
    candidate: string,
    target: Pick<ProviderRecordTarget, "workspaceId" | "projectId">,
  ): boolean {
    return safeEqual(candidate, this.project(target));
  }
}

export function validProviderProjectLocator(locator: string): boolean {
  return locatorPattern.test(locator);
}

export function isProviderRecordsPrefetch(headers: Headers): boolean {
  return headers.get("purpose")?.toLowerCase() === "prefetch"
    || headers.get("sec-purpose")?.toLowerCase().includes("prefetch") === true
    || headers.get("next-router-prefetch") === "1"
    || headers.get("x-middleware-prefetch") === "1";
}

function failure(
  status: ProviderRecordsFailure["status"],
  code: ProviderRecordsFailureCode,
): ProviderRecordsFailure {
  return Object.freeze({ ok: false, status, code });
}

async function providerAccess(
  dependencies: ProviderRecordsDependencies,
): Promise<ProviderRecordsFailure | null> {
  let access: ProviderRecordsAccess;
  try {
    access = await dependencies.verifyProvider();
  } catch {
    return failure(503, "AUTHENTICATION_UNAVAILABLE");
  }
  if (!access.ok) return failure(access.status, access.code);
  try {
    return await dependencies.verifyProductGrant()
      ? null
      : failure(403, "PROVIDER_GRANT_REQUIRED");
  } catch {
    return failure(503, "RECORDS_UNAVAILABLE");
  }
}

function publicProject(
  target: ProviderRecordTarget,
  codec: ProviderRecordsLocatorCodec,
): ProviderRecordProject {
  const projectLocator = codec.project(target);
  const supplied = target.displayName;
  const containsPrivateValue = typeof supplied === "string" && (
    /[^\s<>"'@]+@[^\s<>"'@]+/u.test(supplied)
    || /\b(?:s3|gs|az|file):\/\/[^\s<>"']+/iu.test(supplied)
    || /(?:^|[\s("'`])(?:\/(?:Users|home|var|private|opt|srv|mnt|Volumes)\/|[A-Za-z]:\\)/u
      .test(supplied)
    || /\b[a-f0-9]{64}\b/iu.test(supplied)
    || /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/iu.test(supplied)
  );
  const validDisplayName = typeof supplied === "string"
    && supplied === supplied.trim()
    && Array.from(supplied).length >= 1
    && Array.from(supplied).length <= 200
    && !/[\u0000-\u001f\u007f]/u.test(supplied)
    && !containsPrivateValue;
  return Object.freeze({
    projectLocator,
    displayName: validDisplayName
      ? supplied
      : `Project record · ${projectLocator.slice(-8).toUpperCase()}`,
  });
}

async function authorizedTargets(
  dependencies: ProviderRecordsDependencies,
): Promise<readonly ProviderRecordTarget[]> {
  const targets = await dependencies.listAuthorizedProjects();
  if (
    targets.length > MAX_PROJECT_CANDIDATES
    || targets.some((target) => !validTarget(target))
  ) {
    throw new Error("INVALID_PROVIDER_RECORD_TARGETS");
  }
  const locators = new Set<string>();
  for (const target of targets) {
    const locator = dependencies.locatorCodec.project(target);
    if (locators.has(locator)) {
      throw new Error("DUPLICATE_PROVIDER_RECORD_LOCATOR");
    }
    locators.add(locator);
  }
  return targets;
}

export async function listProviderRecordProjects(
  dependencies: ProviderRecordsDependencies,
): Promise<ProviderRecordsListResult> {
  const accessFailure = await providerAccess(dependencies);
  if (accessFailure) return accessFailure;
  try {
    const targets = await authorizedTargets(dependencies);
    return Object.freeze({
      ok: true,
      projects: Object.freeze(targets.map((target) =>
        publicProject(target, dependencies.locatorCodec))),
    });
  } catch {
    return failure(503, "RECORDS_UNAVAILABLE");
  }
}

function exportFailure(error: unknown): ProviderRecordsFailure {
  if (error instanceof RecordsExportError) {
    if (error.code === "BOUND_EXCEEDED" || error.code === "OUTPUT_TOO_LARGE") {
      return failure(413, "RECORD_EXPORT_TOO_LARGE");
    }
    return failure(409, "RECORD_EXPORT_STATE_CHANGED");
  }
  return failure(503, "RECORDS_UNAVAILABLE");
}

export async function loadProviderProjectRecord(
  projectLocator: string,
  dependencies: ProviderRecordsDependencies,
): Promise<ProviderRecordResult> {
  if (!validProviderProjectLocator(projectLocator)) {
    return failure(404, "RECORD_NOT_AVAILABLE");
  }
  const accessFailure = await providerAccess(dependencies);
  if (accessFailure) return accessFailure;

  let targets: readonly ProviderRecordTarget[];
  try {
    targets = await authorizedTargets(dependencies);
  } catch {
    return failure(503, "RECORDS_UNAVAILABLE");
  }
  const target = targets.find((candidate) =>
    dependencies.locatorCodec.matchesProject(projectLocator, candidate));
  if (!target) return failure(404, "RECORD_NOT_AVAILABLE");

  try {
    const exported = await dependencies.exportProject(target);
    const [productGrantCurrent, projectGrantCurrent] = await Promise.all([
      dependencies.verifyProductGrant(),
      dependencies.isProjectGrantCurrent(target),
    ]);
    if (!productGrantCurrent || !projectGrantCurrent) {
      return failure(403, "PROVIDER_GRANT_REQUIRED");
    }
    return Object.freeze({
      ok: true,
      project: publicProject(target, dependencies.locatorCodec),
      exported,
    });
  } catch (error) {
    return exportFailure(error);
  }
}

function errorMessage(code: ProviderRecordsFailureCode): string {
  switch (code) {
    case "AUTHENTICATION_REQUIRED":
      return "Sign in before accessing provider project records.";
    case "PROVIDER_ASSURANCE_REQUIRED":
      return "Verified email and MFA assurance are required.";
    case "PROVIDER_GRANT_REQUIRED":
      return "The protected provider product grant is not active.";
    case "RECORD_NOT_AVAILABLE":
      return "The selected project record is not available.";
    case "RECORD_EXPORT_STATE_CHANGED":
      return "The project record changed or is incomplete. Refresh before exporting.";
    case "RECORD_EXPORT_TOO_LARGE":
      return "The project record is too large for this export profile.";
    case "AUTHENTICATION_UNAVAILABLE":
      return "Provider authentication is unavailable.";
    default:
      return "Provider project records are temporarily unavailable.";
  }
}

function jsonResponse(body: object, status = 200): Response {
  return Response.json(body, {
    status,
    headers: privateProviderRecordsHeaders,
  });
}

export function providerRecordsUnavailableResponse(): Response {
  return jsonResponse({
    ok: false,
    code: "RECORDS_UNAVAILABLE",
    message: errorMessage("RECORDS_UNAVAILABLE"),
  }, 503);
}

export async function handleProviderRecordsListGet(
  request: Request,
  dependencies: ProviderRecordsDependencies,
): Promise<Response> {
  if (isProviderRecordsPrefetch(request.headers)) {
    return jsonResponse({
      ok: false,
      code: "RECORDS_PREFETCH_REJECTED",
    }, 403);
  }
  const result = await listProviderRecordProjects(dependencies);
  if (!result.ok) {
    return jsonResponse({
      ok: false,
      code: result.code,
      message: errorMessage(result.code),
    }, result.status);
  }
  return jsonResponse({
    ok: true,
    projects: result.projects,
  });
}

function downloadFilename(
  projectLocator: string,
  format: "json" | "html",
): string {
  return `scopeledger-project-record-${projectLocator.slice(-12).toLowerCase()}.${format}`;
}

export async function handleProviderRecordDownload(
  request: Request,
  projectLocator: string,
  format: "json" | "html",
  dependencies: ProviderRecordsDependencies,
): Promise<Response> {
  if (isProviderRecordsPrefetch(request.headers)) {
    return jsonResponse({
      ok: false,
      code: "RECORDS_PREFETCH_REJECTED",
    }, 403);
  }
  const result = await loadProviderProjectRecord(
    projectLocator,
    dependencies,
  );
  if (!result.ok) {
    return jsonResponse({
      ok: false,
      code: result.code,
      message: errorMessage(result.code),
    }, result.status);
  }

  const body = format === "json"
    ? result.exported.json
    : result.exported.html;
  const headers = new Headers(privateProviderRecordsHeaders);
  headers.set(
    "Content-Type",
    format === "json"
      ? "application/json; charset=utf-8"
      : "text/html; charset=utf-8",
  );
  headers.set(
    "Content-Disposition",
    `attachment; filename="${downloadFilename(projectLocator, format)}"`,
  );
  headers.set("Content-Language", "en");
  if (format === "html") {
    headers.set(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  }
  return new Response(body, { status: 200, headers });
}
