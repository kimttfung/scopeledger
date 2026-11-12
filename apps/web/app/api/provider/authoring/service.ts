export type ProviderAuthoringAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type AuthoringProject = Readonly<{
  projectId: string;
  displayName: string;
  createdAt: string;
}>;

export type AuthoringRequest = Readonly<{
  projectId: string;
  requestId: string;
  title: string;
  createdAt: string;
}>;

export type AuthoringDraft = Readonly<{
  projectId: string;
  requestId: string;
  unitId: string;
  revision: number;
  state: "in-progress" | "ready-for-client-review";
  title: string;
  summary: string;
  scope: readonly string[];
  exclusions: readonly string[];
  sourceReferences: readonly Readonly<{
    locator: string;
    displayReference: string;
    version: number;
  }>[];
  draftReference: string;
  createdAt: string;
}>;

type AuthoringAction = "inspect" | "publish";
type DraftSourceReference = Readonly<{
  sourceId: string;
  version: number;
}>;

export type AuthoringDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAuthoringAccess>;
  authorize: (
    input: Readonly<{ action: AuthoringAction; projectId: string | null }>,
  ) => Promise<boolean>;
  listProjects: () => Promise<readonly AuthoringProject[]>;
  createProject: (
    input: Readonly<{ displayName: string }>,
  ) => Promise<AuthoringProject>;
  listRequests: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<readonly AuthoringRequest[]>;
  createRequest: (
    input: Readonly<{ projectId: string; title: string }>,
  ) => Promise<AuthoringRequest>;
  listDrafts: (
    input: Readonly<{ projectId: string; requestId: string }>,
  ) => Promise<readonly AuthoringDraft[]>;
  resolveSourceLocators: (
    input: Readonly<{
      projectId: string;
      requestId: string;
      locators: readonly string[];
    }>,
  ) => Promise<readonly DraftSourceReference[]>;
  createDraft: (
    input: Readonly<{
      projectId: string;
      requestId: string;
      unitId: string | null;
      title: string;
      summary: string;
      scope: readonly string[];
      exclusions: readonly string[];
      sourceReferences: readonly DraftSourceReference[];
    }>,
  ) => Promise<AuthoringDraft>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
}

function providerFailure(
  access: Exclude<ProviderAuthoringAccess, { ok: true }>,
): Response {
  switch (access.code) {
    case "AUTHENTICATION_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Sign in before accessing provider authoring.",
      }, access.status);
    case "PROVIDER_ASSURANCE_REQUIRED":
      return json({
        ok: false,
        code: access.code,
        message: "Verified email and MFA assurance are required.",
      }, access.status);
    default:
      return json({
        ok: false,
        code: access.code,
        message: "Provider authentication is unavailable.",
      }, access.status);
  }
}

async function providerAccess(
  dependencies: AuthoringDependencies,
): Promise<Response | null> {
  try {
    const access = await dependencies.verifyProvider();
    return access.ok ? null : providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
}

async function productAccess(
  dependencies: AuthoringDependencies,
  action: AuthoringAction,
  projectId: string | null,
): Promise<Response | null> {
  try {
    if (await dependencies.authorize({ action, projectId })) return null;
    return json({
      ok: false,
      code: "PROVIDER_GRANT_REQUIRED",
      message: "The protected demo provider grant is not active.",
    }, 403);
  } catch {
    return json({
      ok: false,
      code: "AUTHORING_AUTHORITY_UNAVAILABLE",
      message: "Provider authoring authority could not be verified.",
    }, 503);
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : null;
}

function persistenceFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_AUTHORING_INPUT",
        message: "The authoring content is invalid or outside the allowed bounds.",
      }, 422);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "AUTHORING_RESOURCE_NOT_FOUND",
        message: "The selected authoring resource is not available.",
      }, 404);
    case "PROJECT_CONFLICT":
    case "REQUEST_CONFLICT":
    case "DRAFT_CONFLICT":
      return json({
        ok: false,
        code: "AUTHORING_CONFLICT",
        message: "The selected authoring identity conflicts with durable content.",
      }, 409);
    case "STALE_DRAFT_REVISION":
      return json({
        ok: false,
        code: "STALE_DRAFT_REVISION",
        message: "A newer immutable draft revision exists. Refresh before continuing.",
      }, 409);
    case "SOURCE_SCOPE_MISMATCH":
      return json({
        ok: false,
        code: "SOURCE_SCOPE_MISMATCH",
        message: "A selected source does not belong to this exact project request.",
      }, 409);
    case "STALE_SOURCE_SELECTION":
      return json({
        ok: false,
        code: "STALE_SOURCE_SELECTION",
        message: "A selected source is no longer admitted here. Refresh the source list.",
      }, 409);
    default:
      return json({
        ok: false,
        code: "AUTHORING_UNAVAILABLE",
        message: "Provider authoring is temporarily unavailable.",
      }, 503);
  }
}

function validIdentifier(value: string): boolean {
  return identifierPattern.test(value);
}

function boundedText(
  value: unknown,
  maximum: number,
  options: Readonly<{
    preserveWhitespace?: boolean;
    allowLines?: boolean;
  }> = {},
): string | null {
  if (typeof value !== "string" || invalidUnicode.test(value)) return null;
  const controls = options.allowLines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\u0000-\u001f\u007f]/u;
  if (
    Array.from(value).length < 1
    || Array.from(value).length > maximum
    || controls.test(value)
    || (!options.preserveWhitespace && value !== value.trim())
    || value.trim().length === 0
  ) {
    return null;
  }
  return value;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function sameOriginFailure(): Response {
  return json({
    ok: false,
    code: "SAME_ORIGIN_REQUIRED",
    message: "This operation must originate from the ScopeLedger application.",
  }, 403);
}

async function authorizeRead(
  dependencies: AuthoringDependencies,
  projectId: string | null,
): Promise<Response | null> {
  return (await providerAccess(dependencies))
    ?? productAccess(dependencies, "inspect", projectId);
}

async function authorizeWrite(
  request: Request,
  dependencies: AuthoringDependencies,
  projectId: string | null,
): Promise<Response | null> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return sameOriginFailure();
  }
  return (await providerAccess(dependencies))
    ?? productAccess(dependencies, "publish", projectId);
}

function invalidLocator(): Response {
  return json({
    ok: false,
    code: "AUTHORING_RESOURCE_NOT_FOUND",
    message: "The selected authoring resource is not available.",
  }, 404);
}

export async function handleProjectsGet(
  dependencies: AuthoringDependencies,
): Promise<Response> {
  const accessFailure = await authorizeRead(dependencies, null);
  if (accessFailure) return accessFailure;
  try {
    return json({ ok: true, projects: await dependencies.listProjects() });
  } catch (error) {
    return persistenceFailure(error);
  }
}

export async function handleProjectsPost(
  request: Request,
  dependencies: AuthoringDependencies,
): Promise<Response> {
  const accessFailure = await authorizeWrite(request, dependencies, null);
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (!exactObject(input, ["displayName"])) {
    return json({
      ok: false,
      code: "INVALID_AUTHORING_INPUT",
      message: "A project display name is required; authority fields are server-owned.",
    }, 422);
  }
  const displayName = boundedText(input.displayName, 200);
  if (!displayName) {
    return json({
      ok: false,
      code: "INVALID_AUTHORING_INPUT",
      message: "Project display name must contain 1 to 200 valid characters.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      project: await dependencies.createProject({ displayName }),
    }, 201);
  } catch (error) {
    return persistenceFailure(error);
  }
}

export async function handleRequestsGet(
  projectId: string,
  dependencies: AuthoringDependencies,
): Promise<Response> {
  if (!validIdentifier(projectId)) return invalidLocator();
  const accessFailure = await authorizeRead(dependencies, projectId);
  if (accessFailure) return accessFailure;
  try {
    return json({
      ok: true,
      requests: await dependencies.listRequests({ projectId }),
    });
  } catch (error) {
    return persistenceFailure(error);
  }
}

export async function handleRequestsPost(
  request: Request,
  projectId: string,
  dependencies: AuthoringDependencies,
): Promise<Response> {
  if (!validIdentifier(projectId)) return invalidLocator();
  const accessFailure = await authorizeWrite(request, dependencies, projectId);
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (!exactObject(input, ["title"])) {
    return json({
      ok: false,
      code: "INVALID_AUTHORING_INPUT",
      message: "A request title is required; request identity is server-owned.",
    }, 422);
  }
  const title = boundedText(input.title, 200);
  if (!title) {
    return json({
      ok: false,
      code: "INVALID_AUTHORING_INPUT",
      message: "Request title must contain 1 to 200 valid characters.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      request: await dependencies.createRequest({ projectId, title }),
    }, 201);
  } catch (error) {
    return persistenceFailure(error);
  }
}

export async function handleDraftsGet(
  projectId: string,
  requestId: string,
  dependencies: AuthoringDependencies,
): Promise<Response> {
  if (!validIdentifier(projectId) || !validIdentifier(requestId)) {
    return invalidLocator();
  }
  const accessFailure = await authorizeRead(dependencies, projectId);
  if (accessFailure) return accessFailure;
  try {
    return json({
      ok: true,
      drafts: await dependencies.listDrafts({ projectId, requestId }),
    });
  } catch (error) {
    return persistenceFailure(error);
  }
}

function draftContent(input: unknown): Readonly<{
  title: string;
  summary: string;
  scope: readonly string[];
  exclusions: readonly string[];
  sourceLocators: readonly string[];
}> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const requiredKeys = ["title", "summary", "scope", "exclusions"];
  const allowedKeys = new Set([...requiredKeys, "sourceLocators"]);
  if (
    requiredKeys.some((key) => !(key in record))
    || Object.keys(record).some((key) => !allowedKeys.has(key))
  ) {
    return null;
  }
  const title = boundedText(record.title, 200);
  const summary = boundedText(record.summary, 10_000, {
    preserveWhitespace: true,
    allowLines: true,
  });
  if (
    !title
    || !summary
    || !Array.isArray(record.scope)
    || record.scope.length < 1
    || record.scope.length > 100
    || !Array.isArray(record.exclusions)
    || record.exclusions.length > 100
  ) {
    return null;
  }
  const scope = record.scope.map((item) => boundedText(item, 10_000, {
    allowLines: true,
  }));
  const exclusions = record.exclusions.map((item) => boundedText(item, 10_000, {
    allowLines: true,
  }));
  const sourceLocators = record.sourceLocators ?? [];
  if (
    scope.some((item) => item === null)
    || exclusions.some((item) => item === null)
    || !Array.isArray(sourceLocators)
    || sourceLocators.length > 100
    || sourceLocators.some((locator) =>
      typeof locator !== "string"
      || boundedText(locator, 160) !== locator)
    || new Set(sourceLocators).size !== sourceLocators.length
  ) {
    return null;
  }
  return {
    title,
    summary,
    scope: scope as string[],
    exclusions: exclusions as string[],
    sourceLocators: sourceLocators as string[],
  };
}

export async function handleDraftsPost(
  request: Request,
  projectId: string,
  requestId: string,
  unitId: string | null,
  dependencies: AuthoringDependencies,
): Promise<Response> {
  if (
    !validIdentifier(projectId)
    || !validIdentifier(requestId)
    || (unitId !== null && !validIdentifier(unitId))
  ) {
    return invalidLocator();
  }
  const accessFailure = await authorizeWrite(request, dependencies, projectId);
  if (accessFailure) return accessFailure;
  const content = draftContent(await requestBody(request));
  if (!content) {
    return json({
      ok: false,
      code: "INVALID_AUTHORING_INPUT",
      message: "Provide bounded title, summary, scope, and exclusion content only.",
    }, 422);
  }
  try {
    const sourceReferences = await dependencies.resolveSourceLocators({
      projectId,
      requestId,
      locators: content.sourceLocators,
    });
    return json({
      ok: true,
      draft: await dependencies.createDraft({
        projectId,
        requestId,
        unitId,
        title: content.title,
        summary: content.summary,
        scope: content.scope,
        exclusions: content.exclusions,
        sourceReferences,
      }),
    }, 201);
  } catch (error) {
    return persistenceFailure(error);
  }
}
