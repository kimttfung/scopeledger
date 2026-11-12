type CommercialTreatment = "included" | "waived" | "payable" | "unresolved";
type ConsentRequirement = "required" | "not-required" | "not-applicable";
type TaxTreatment =
  | "none"
  | "exclusive"
  | "inclusive"
  | "not-applicable"
  | "unresolved";

type ProviderAuthoringAccess =
  | Readonly<{ ok: true }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
  }>;

export type CommercialPreparationInput = Readonly<{
  projectId: string;
  requestId: string;
  unitId: string;
  draftRevision: number;
  idempotencyKey: string;
  treatment: CommercialTreatment;
  independenceExplanation: string;
  dependencies: readonly Readonly<{
    unitId: string;
    explanation: string;
  }>[];
  clientVisibleRationale: string;
  delivery: Readonly<{
    description: string;
    dependencies: readonly string[];
  }>;
  prerequisites: readonly Readonly<{
    id: string;
    version: number;
    description: string;
    blocks: "payment" | "start" | "payment-and-start";
  }>[];
  consentRequirement: ConsentRequirement;
  paymentExplanation: string;
  tax: Readonly<{
    treatment: TaxTreatment;
    amount: string;
    declaration: string;
  }>;
  price: Readonly<{
    description: string;
    amount: string;
  }> | null;
  sourceCoverage: readonly Readonly<{
    sourceLocator: string;
    locator: string;
    materiality: "material" | "supporting";
    coverageStatus: "covered" | "unresolved";
    analysisStatus:
      | "not-used"
      | "human-reviewed"
      | "model-output-reviewed"
      | "unresolved";
    analysisReference: string | null;
    explanation: string;
  }>[];
}>;

export type CommercialPreparationPreview = Readonly<{
  preparationLocator: string;
  revision: number;
  draftRevision: number;
  treatment: CommercialTreatment;
  publicationReadiness: "ready" | "blocked" | "not-applicable";
  publicationAllowed: boolean;
  preparedAt: string;
  draft: Readonly<{
    title: string;
    summary: string;
    scope: readonly string[];
    exclusions: readonly string[];
    sources: readonly Readonly<{
      displayReference: string;
      locator: string;
      materiality: "material" | "supporting";
      coverageStatus: "covered" | "unresolved";
      analysisStatus:
        | "not-used"
        | "human-reviewed"
        | "model-output-reviewed"
        | "unresolved";
      analysisReference: string | null;
      explanation: string;
    }>[];
  }>;
  terms: Readonly<{
    independenceExplanation: string;
    dependencies: readonly Readonly<{ explanation: string }>[];
    clientVisibleRationale: string;
    delivery: Readonly<{
      description: string;
      dependencies: readonly string[];
    }>;
    prerequisites: readonly Readonly<{
      id: string;
      version: number;
      description: string;
      blocks: "payment" | "start" | "payment-and-start";
    }>[];
    consentRequirement: ConsentRequirement;
    paymentExplanation: string;
    tax: Readonly<{
      treatment: TaxTreatment;
      amount: string;
      declaration: string;
    }>;
    price: Readonly<{
      currency: "USD";
      paymentPolicy: "full-prepayment";
      description: string;
      amount: string;
      gross: string;
    }> | null;
  }>;
}>;

export type CommercialPublication = Readonly<{
  treatment: "waived" | "payable";
  version: number;
  publishedAt: string;
  review: Readonly<{
    projectLocator: string;
    requestLocator: string;
    unitLocator: string;
    url: string;
  }>;
}>;

export type CommercialDependencies = Readonly<{
  requireSameOrigin: (request: Request) => void;
  verifyProvider: () => Promise<ProviderAuthoringAccess>;
  authorize: (projectId: string) => Promise<boolean>;
  prepareCommercial: (
    input: CommercialPreparationInput,
  ) => Promise<CommercialPreparationPreview>;
  publishCommercial: (input: Readonly<{
    projectId: string;
    requestId: string;
    unitId: string;
    draftRevision: number;
    idempotencyKey: string;
    preparationLocator: string;
  }>) => Promise<CommercialPublication>;
}>;

const responseHeaders = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const preparationLocatorPattern = /^slcp1_[A-Za-z0-9_-]{43}$/u;
const moneyPattern = /^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/u;
const invalidUnicode =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function json(body: object, status = 200): Response {
  return Response.json(body, { status, headers: responseHeaders });
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

function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || invalidUnicode.test(value)) return null;
  const length = Array.from(value).length;
  return length > 0
    && length <= maximum
    && value.trim().length > 0
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    ? value
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value)
    ? value
    : null;
}

function positiveRevision(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : null;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const entries = value.map((entry) => boundedText(entry, 10_000));
  return entries.some((entry) => entry === null)
    ? null
    : entries as string[];
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function preparationBody(
  value: unknown,
): Omit<
  CommercialPreparationInput,
  "projectId" | "requestId" | "unitId"
> | null {
  if (!exactObject(value, [
    "idempotencyKey",
    "draftRevision",
    "treatment",
    "independenceExplanation",
    "dependencies",
    "clientVisibleRationale",
    "delivery",
    "prerequisites",
    "consentRequirement",
    "paymentExplanation",
    "tax",
    "price",
    "sourceCoverage",
  ])) {
    return null;
  }
  const idempotencyKey = typeof value.idempotencyKey === "string"
    && uuidPattern.test(value.idempotencyKey)
    ? value.idempotencyKey
    : null;
  const draftRevision = positiveRevision(value.draftRevision);
  const treatment = typeof value.treatment === "string"
    && ["included", "waived", "payable", "unresolved"].includes(value.treatment)
    ? value.treatment as CommercialTreatment
    : null;
  const independenceExplanation = boundedText(
    value.independenceExplanation,
    10_000,
  );
  const clientVisibleRationale = boundedText(
    value.clientVisibleRationale,
    10_000,
  );
  const paymentExplanation = boundedText(value.paymentExplanation, 10_000);
  if (
    !idempotencyKey
    || !draftRevision
    || !treatment
    || !independenceExplanation
    || !clientVisibleRationale
    || !paymentExplanation
    || !Array.isArray(value.dependencies)
    || value.dependencies.length > 100
    || !Array.isArray(value.prerequisites)
    || value.prerequisites.length > 100
    || !Array.isArray(value.sourceCoverage)
    || value.sourceCoverage.length < 1
    || value.sourceCoverage.length > 100
  ) {
    return null;
  }

  const dependencies = value.dependencies.map((entry) => {
    if (!exactObject(entry, ["unitId", "explanation"])) return null;
    const unitId = identifier(entry.unitId);
    const explanation = boundedText(entry.explanation, 10_000);
    return unitId && explanation ? { unitId, explanation } : null;
  });
  const prerequisites = value.prerequisites.map((entry) => {
    if (!exactObject(entry, ["id", "version", "description", "blocks"])) {
      return null;
    }
    const id = identifier(entry.id);
    const version = positiveRevision(entry.version);
    const description = boundedText(entry.description, 10_000);
    const blocks = typeof entry.blocks === "string"
      && ["payment", "start", "payment-and-start"].includes(entry.blocks)
      ? entry.blocks as "payment" | "start" | "payment-and-start"
      : null;
    return id && version && description && blocks
      ? { id, version, description, blocks }
      : null;
  });
  const sourceCoverage = value.sourceCoverage.map((entry) => {
    if (!exactObject(entry, [
      "sourceLocator",
      "locator",
      "materiality",
      "coverageStatus",
      "analysisStatus",
      "analysisReference",
      "explanation",
    ])) {
      return null;
    }
    const sourceLocator = boundedText(entry.sourceLocator, 200);
    const locator = boundedText(entry.locator, 10_000);
    const materiality = typeof entry.materiality === "string"
      && ["material", "supporting"].includes(entry.materiality)
      ? entry.materiality as "material" | "supporting"
      : null;
    const coverageStatus = typeof entry.coverageStatus === "string"
      && ["covered", "unresolved"].includes(entry.coverageStatus)
      ? entry.coverageStatus as "covered" | "unresolved"
      : null;
    const analysisStatus = typeof entry.analysisStatus === "string"
      && [
        "not-used",
        "human-reviewed",
        "model-output-reviewed",
        "unresolved",
      ].includes(entry.analysisStatus)
      ? entry.analysisStatus as CommercialPreparationInput[
        "sourceCoverage"
      ][number]["analysisStatus"]
      : null;
    const analysisReference = entry.analysisReference === null
      ? null
      : boundedText(entry.analysisReference, 2_000);
    const explanation = boundedText(entry.explanation, 10_000);
    if (
      !sourceLocator
      || !locator
      || !materiality
      || !coverageStatus
      || !analysisStatus
      || analysisReference === null && entry.analysisReference !== null
      || !explanation
      || (
        analysisStatus === "model-output-reviewed"
          ? analysisReference === null
          : ["not-used", "unresolved"].includes(analysisStatus)
            && analysisReference !== null
      )
    ) {
      return null;
    }
    return {
      sourceLocator,
      locator,
      materiality,
      coverageStatus,
      analysisStatus,
      analysisReference,
      explanation,
    };
  });
  if (
    dependencies.some((entry) => entry === null)
    || prerequisites.some((entry) => entry === null)
    || sourceCoverage.some((entry) => entry === null)
    || !unique(dependencies.map((entry) => entry!.unitId))
    || !unique(prerequisites.map((entry) => entry!.id))
    || !unique(sourceCoverage.map((entry) => entry!.sourceLocator))
  ) {
    return null;
  }

  if (!exactObject(value.delivery, ["description", "dependencies"])) {
    return null;
  }
  const deliveryDescription = boundedText(value.delivery.description, 10_000);
  const deliveryDependencies = stringArray(value.delivery.dependencies);
  if (!deliveryDescription || !deliveryDependencies) return null;

  const consentRequirement = typeof value.consentRequirement === "string"
    && ["required", "not-required", "not-applicable"].includes(
      value.consentRequirement,
    )
    ? value.consentRequirement as ConsentRequirement
    : null;
  if (!consentRequirement) return null;

  if (!exactObject(value.tax, ["treatment", "amount", "declaration"])) {
    return null;
  }
  const taxTreatment = typeof value.tax.treatment === "string"
    && [
      "none",
      "exclusive",
      "inclusive",
      "not-applicable",
      "unresolved",
    ].includes(value.tax.treatment)
    ? value.tax.treatment as TaxTreatment
    : null;
  const taxAmount = typeof value.tax.amount === "string"
    && moneyPattern.test(value.tax.amount)
    ? value.tax.amount
    : null;
  const taxDeclaration = boundedText(value.tax.declaration, 10_000);
  if (!taxTreatment || !taxAmount || !taxDeclaration) return null;

  let price: CommercialPreparationInput["price"] = null;
  if (value.price !== null) {
    if (!exactObject(value.price, ["description", "amount"])) return null;
    const description = boundedText(value.price.description, 10_000);
    const amount = typeof value.price.amount === "string"
      && moneyPattern.test(value.price.amount)
      && value.price.amount !== "0.00"
      ? value.price.amount
      : null;
    if (!description || !amount) return null;
    price = { description, amount };
  }

  const validTreatment = treatment === "payable"
    ? price !== null
      && consentRequirement === "required"
      && ["none", "exclusive", "inclusive"].includes(taxTreatment)
    : price === null
      && taxAmount === "0.00"
      && (
        treatment === "waived"
          ? ["required", "not-required"].includes(consentRequirement)
            && taxTreatment === "not-applicable"
          : treatment === "included"
            ? consentRequirement === "not-applicable"
              && taxTreatment === "not-applicable"
            : consentRequirement === "not-applicable"
              && ["not-applicable", "unresolved"].includes(taxTreatment)
      );
  if (!validTreatment) return null;

  return {
    idempotencyKey,
    draftRevision,
    treatment,
    independenceExplanation,
    dependencies: dependencies as CommercialPreparationInput["dependencies"],
    clientVisibleRationale,
    delivery: {
      description: deliveryDescription,
      dependencies: deliveryDependencies,
    },
    prerequisites: prerequisites as CommercialPreparationInput["prerequisites"],
    consentRequirement,
    paymentExplanation,
    tax: {
      treatment: taxTreatment,
      amount: taxAmount,
      declaration: taxDeclaration,
    },
    price,
    sourceCoverage:
      sourceCoverage as CommercialPreparationInput["sourceCoverage"],
  };
}

async function requestBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function providerFailure(
  access: Exclude<ProviderAuthoringAccess, { ok: true }>,
): Response {
  const message = access.code === "AUTHENTICATION_REQUIRED"
    ? "Sign in before preparing or publishing commercial terms."
    : access.code === "PROVIDER_ASSURANCE_REQUIRED"
      ? "Verified email and MFA assurance are required."
      : "Provider authentication is unavailable.";
  return json({ ok: false, code: access.code, message }, access.status);
}

async function authorizeMutation(
  request: Request,
  projectId: string,
  dependencies: CommercialDependencies,
): Promise<Response | null> {
  try {
    dependencies.requireSameOrigin(request);
  } catch {
    return json({
      ok: false,
      code: "SAME_ORIGIN_REQUIRED",
      message: "This operation must originate from the ScopeLedger application.",
    }, 403);
  }
  try {
    const access = await dependencies.verifyProvider();
    if (!access.ok) return providerFailure(access);
  } catch {
    return json({
      ok: false,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    }, 503);
  }
  try {
    if (await dependencies.authorize(projectId)) return null;
    return json({
      ok: false,
      code: "PROVIDER_GRANT_REQUIRED",
      message: "The protected demo provider publish grant is not active.",
    }, 403);
  } catch {
    return json({
      ok: false,
      code: "AUTHORING_AUTHORITY_UNAVAILABLE",
      message: "Provider publication authority could not be verified.",
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

function commercialFailure(error: unknown): Response {
  switch (errorCode(error)) {
    case "BASELINE_REQUIRED":
      return json({
        ok: false,
        code: "COMMERCIAL_BASELINE_REQUIRED",
        message: "Confirm at least one admitted source as a provider baseline before commercial preparation.",
      }, 409);
    case "INVALID_INPUT":
      return json({
        ok: false,
        code: "INVALID_COMMERCIAL_INPUT",
        message: "Commercial terms are inconsistent or outside allowed bounds.",
      }, 422);
    case "NOT_FOUND":
      return json({
        ok: false,
        code: "COMMERCIAL_RESOURCE_NOT_FOUND",
        message: "The selected draft or preparation is not available.",
      }, 404);
    case "IDEMPOTENCY_CONFLICT":
      return json({
        ok: false,
        code: "COMMERCIAL_REPLAY_CONFLICT",
        message: "This operation identity was already used with different content.",
      }, 409);
    case "STALE_CONTEXT":
    case "STALE_UNIT_VERSION":
      return json({
        ok: false,
        code: "COMMERCIAL_STATE_CHANGED",
        message: "Draft, source, authority, preparation, or publication state changed. Refresh and prepare again.",
      }, 409);
    case "REVIEW_HOLD":
      return json({
        ok: false,
        code: "COMMERCIAL_PUBLICATION_BLOCKED",
        message: "These prepared terms cannot be published under the current treatment or coverage state.",
      }, 409);
    case "ACCESS_DENIED":
      return json({
        ok: false,
        code: "COMMERCIAL_AUTHORITY_CHANGED",
        message: "Provider or client-approver authority changed before publication.",
      }, 409);
    case "COLLECTION_CONFLICT":
      return json({
        ok: false,
        code: "COMMERCIAL_COLLECTION_CONFLICT",
        message: "Existing accepted terms require a supported amendment path.",
      }, 409);
    case "PAYMENT_OUTCOME_UNKNOWN":
      return json({
        ok: false,
        code: "COMMERCIAL_EXTERNAL_FINANCIAL_RESOLUTION_REQUIRED",
        message: "The prior accepted obligation has payment history. The correction hold remains active; resolve the financial basis externally before publishing changed terms. ScopeLedger did not create a balance, refund, cancellation, or recollection.",
      }, 409);
    default:
      return json({
        ok: false,
        code: "COMMERCIAL_PUBLICATION_UNAVAILABLE",
        message: "Commercial preparation or publication is temporarily unavailable.",
      }, 503);
  }
}

function validPath(
  projectId: string,
  requestId: string,
  unitId: string,
): boolean {
  return identifierPattern.test(projectId)
    && identifierPattern.test(requestId)
    && identifierPattern.test(unitId);
}

export async function handleCommercialPreparePost(
  request: Request,
  projectId: string,
  requestId: string,
  unitId: string,
  dependencies: CommercialDependencies,
): Promise<Response> {
  if (!validPath(projectId, requestId, unitId)) {
    return json({
      ok: false,
      code: "COMMERCIAL_RESOURCE_NOT_FOUND",
      message: "The selected draft is not available.",
    }, 404);
  }
  const accessFailure = await authorizeMutation(
    request,
    projectId,
    dependencies,
  );
  if (accessFailure) return accessFailure;
  const input = preparationBody(await requestBody(request));
  if (!input) {
    return json({
      ok: false,
      code: "INVALID_COMMERCIAL_INPUT",
      message: "Provide only bounded treatment, delivery, coverage, tax, price, and payment terms.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      preparation: await dependencies.prepareCommercial({
        projectId,
        requestId,
        unitId,
        ...input,
      }),
    }, 201);
  } catch (error) {
    return commercialFailure(error);
  }
}

export async function handleCommercialPublishPost(
  request: Request,
  projectId: string,
  requestId: string,
  unitId: string,
  dependencies: CommercialDependencies,
): Promise<Response> {
  if (!validPath(projectId, requestId, unitId)) {
    return json({
      ok: false,
      code: "COMMERCIAL_RESOURCE_NOT_FOUND",
      message: "The selected preparation is not available.",
    }, 404);
  }
  const accessFailure = await authorizeMutation(
    request,
    projectId,
    dependencies,
  );
  if (accessFailure) return accessFailure;
  const input = await requestBody(request);
  if (
    !exactObject(input, [
      "idempotencyKey",
      "draftRevision",
      "preparationLocator",
      "confirmed",
    ])
    || typeof input.idempotencyKey !== "string"
    || !uuidPattern.test(input.idempotencyKey)
    || !positiveRevision(input.draftRevision)
    || typeof input.preparationLocator !== "string"
    || !preparationLocatorPattern.test(input.preparationLocator)
    || input.confirmed !== true
  ) {
    return json({
      ok: false,
      code: "INVALID_PUBLICATION_CONFIRMATION",
      message: "Explicit confirmation of one exact prepared revision is required.",
    }, 422);
  }
  try {
    return json({
      ok: true,
      publication: await dependencies.publishCommercial({
        projectId,
        requestId,
        unitId,
        draftRevision: Number(input.draftRevision),
        idempotencyKey: input.idempotencyKey,
        preparationLocator: input.preparationLocator,
      }),
    }, 201);
  } catch (error) {
    return commercialFailure(error);
  }
}
