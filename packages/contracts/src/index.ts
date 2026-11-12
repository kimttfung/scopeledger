import { createHash } from "node:crypto";
import { z } from "zod";

export type ErrorCode =
  | "INVALID_INPUT" | "ACCESS_DENIED" | "NOT_FOUND" | "STALE_UNIT_VERSION"
  | "STALE_CONTEXT" | "REVIEW_HOLD" | "DECISION_CONFLICT" | "IDEMPOTENCY_CONFLICT"
  | "PAYMENT_OUTCOME_UNKNOWN" | "COLLECTION_CONFLICT" | "STALE_LEASE"
  | "RECONCILIATION_REQUIRED" | "RETIREMENT_DISABLED" | "FINANCIAL_MISMATCH";

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly references: readonly string[] = [],
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
export const commandIdentifier = z.uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const revision = z.number().int().safe().min(1).max(2_147_483_647);
export const text = z.string().min(1).refine(
  (value) => [...value].length <= 10_000,
  "Text must contain at most 10,000 Unicode code points",
).refine(
  (value) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
  "Text must contain valid Unicode scalar values",
);
export const moneySchema = z.string().regex(/^(0|[1-9][0-9]{0,9})\.[0-9]{2}$/);
export const MAX_MINOR_UNITS = 999_999_999_999n;

export function minorUnits(value: string): bigint {
  const parsed = moneySchema.safeParse(value);
  if (!parsed.success) throw new ProtocolError("INVALID_INPUT", "Expected bounded exact USD decimal money");
  const amount = BigInt(value.replace(".", ""));
  if (amount > MAX_MINOR_UNITS) throw new ProtocolError("INVALID_INPUT", "Money exceeds the protocol bound");
  return amount;
}

export function decimalMoney(value: bigint): string {
  if (value < 0n || value > MAX_MINOR_UNITS) throw new ProtocolError("INVALID_INPUT", "Money exceeds the protocol bound");
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

const referenceSchema = z.strictObject({ id: identifier, version: revision });
const sourceReferenceSchema = z.strictObject({
  id: identifier, version: revision, locator: text,
  availability: z.enum(["available", "unavailable"]),
});
const lineSchema = z.strictObject({
  id: identifier, description: text,
  quantity: z.string().regex(/^[1-9][0-9]{0,5}$/),
  unitPrice: moneySchema, amount: moneySchema,
});
const financialSchema = z.strictObject({
  currency: z.literal("USD"), merchantId: identifier,
  environment: z.enum(["sandbox", "live"]),
  lines: z.array(lineSchema).min(1).max(100),
  subtotal: moneySchema,
  tax: z.strictObject({
    treatment: z.enum(["none", "exclusive", "inclusive"]),
    amount: moneySchema, declaration: text,
  }),
  gross: moneySchema,
});
const prerequisiteSchema = z.strictObject({
  id: identifier, version: revision, description: text,
  recorderId: identifier, blocks: z.enum(["payment", "start", "payment-and-start"]),
});
const commonSnapshot = {
  schemaVersion: z.literal("scopeledger.published-unit.v1"),
  serializationVersion: z.literal("scopeledger.canonical-json.v1"),
  workspaceId: identifier, projectId: identifier, clientId: identifier, unitId: identifier,
  version: revision, contextRevision: revision,
  title: text,
  scope: z.array(text).min(1).max(100),
  exclusions: z.array(text).max(100),
  dependencies: z.array(z.strictObject({ unitId: identifier, explanation: text })).max(100),
  baselineReferences: z.array(referenceSchema).min(1).max(100),
  sourceReferences: z.array(sourceReferenceSchema).min(1).max(100),
  rationale: text,
  approver: z.strictObject({
    actorId: identifier, nominationEpoch: revision, condition: text,
  }),
  timing: z.strictObject({ description: text, deliveryDependencies: z.array(text).max(100) }),
  prerequisites: z.array(prerequisiteSchema).max(100),
  reconciliation: z.array(z.strictObject({ concernId: identifier, responseRevision: revision })).max(100),
};

export const publishedUnitSchema = z.discriminatedUnion("treatment", [
  z.strictObject({
    ...commonSnapshot, treatment: z.literal("payable"),
    payment: z.strictObject({ policy: z.literal("full-prepayment"), financial: financialSchema }),
    financialEffect: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("new") }),
      z.strictObject({ kind: z.literal("unpaid-replacement"), replacesObligationId: identifier }),
    ]),
  }),
  z.strictObject({
    ...commonSnapshot, treatment: z.literal("additional-waived"),
    payment: z.strictObject({ policy: z.literal("not-required"), explanation: text }),
    financialEffect: z.strictObject({ kind: z.literal("no-obligation") }),
  }),
]).superRefine((snapshot, context) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [path], message: "Duplicate identity" });
  };
  unique(snapshot.prerequisites.map((entry) => entry.id), "prerequisites");
  unique(snapshot.reconciliation.map((entry) => entry.concernId), "reconciliation");
  unique(snapshot.dependencies.map((entry) => entry.unitId), "dependencies");
  unique(snapshot.baselineReferences.map((entry) => `${entry.id}:${entry.version}`), "baselineReferences");
  unique(snapshot.sourceReferences.map((entry) => `${entry.id}:${entry.version}`), "sourceReferences");
  if (snapshot.dependencies.some((entry) => entry.unitId === snapshot.unitId)) {
    context.addIssue({ code: "custom", path: ["dependencies"], message: "A unit cannot depend on itself" });
  }
  if (snapshot.treatment !== "payable") return;
  const financial = snapshot.payment.financial;
  unique(financial.lines.map((entry) => entry.id), "payment");
  let total = 0n;
  for (const [index, line] of financial.lines.entries()) {
    const expected = minorUnits(line.unitPrice) * BigInt(line.quantity);
    if (expected === 0n || expected > MAX_MINOR_UNITS || expected !== minorUnits(line.amount)) {
      context.addIssue({ code: "custom", path: ["payment", "financial", "lines", index], message: "Positive line amount must equal exact unit price times quantity within the money bound" });
    }
    total += minorUnits(line.amount);
  }
  const subtotal = minorUnits(financial.subtotal);
  const tax = minorUnits(financial.tax.amount);
  const gross = minorUnits(financial.gross);
  if (total !== subtotal || total > MAX_MINOR_UNITS) {
    context.addIssue({ code: "custom", path: ["payment", "financial", "subtotal"], message: "Subtotal must equal exact line sum within the money bound" });
  }
  const expectedGross = financial.tax.treatment === "exclusive" ? subtotal + tax : subtotal;
  if (gross <= 0n || gross !== expectedGross || expectedGross > MAX_MINOR_UNITS
      || (financial.tax.treatment === "none" && tax !== 0n)
      || (financial.tax.treatment === "inclusive" && tax > subtotal)) {
    context.addIssue({ code: "custom", path: ["payment", "financial"], message: "Invalid declared tax treatment or gross arithmetic" });
  }
});

export type PublishedUnit = z.infer<typeof publishedUnitSchema>;
export type PayableUnit = Extract<PublishedUnit, { treatment: "payable" }>;

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ProtocolError("INVALID_INPUT", "Input failed runtime validation", result.error.issues.map((issue) => issue.path.join(".")));
  }
  return result.data;
}

function assertJson(value: unknown, seen: Set<object>, depth = 0): void {
  if (depth > 64) throw new ProtocolError("INVALID_INPUT", "JSON nesting exceeds the canonical protocol limit");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string") parseInput(text.or(z.literal("")), value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new ProtocolError("INVALID_INPUT", "Canonical numbers must be safe integers");
    return;
  }
  if (typeof value !== "object" || seen.has(value)) throw new ProtocolError("INVALID_INPUT", "Expected acyclic JSON without undefined or unsupported values");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new ProtocolError("INVALID_INPUT", "Only plain JSON objects are canonical");
  }
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new ProtocolError("INVALID_INPUT", "Symbol keys are not canonical");
  if (Array.isArray(value)) {
    if (value.length > 10_000 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
      throw new ProtocolError("INVALID_INPUT", "Expected a bounded JSON array without extra properties");
    }
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, index);
      if (!property || !property.enumerable || !("value" in property)) throw new ProtocolError("INVALID_INPUT", "Sparse/accessor arrays are not canonical");
      assertJson(property.value, seen, depth + 1);
    }
  } else {
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > 1_000) throw new ProtocolError("INVALID_INPUT", "Object exceeds the canonical field limit");
    for (const key of keys) {
      parseInput(text.or(z.literal("")), key);
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property?.enumerable || !("value" in property)) throw new ProtocolError("INVALID_INPUT", "Accessors and hidden properties are not canonical JSON");
      assertJson(property.value, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
}

/** v1 sorts object keys by ECMAScript code units; array order and text bytes are identity. */
export function canonicalJson(value: unknown): string {
  assertJson(value, new Set());
  return serialize(value);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

export function freezePublishedUnit(input: unknown): {
  snapshot: PublishedUnit; bytes: Buffer; digest: string;
} {
  assertJson(input, new Set());
  const snapshot = parseInput(publishedUnitSchema, input);
  const bytes = Buffer.from(canonicalJson(snapshot), "utf8");
  freezeJson(snapshot);
  return { snapshot, bytes, digest: sha256(bytes) };
}

export const actorSchema = z.strictObject({
  workspaceId: identifier, projectId: identifier, actorId: identifier, grantEpoch: revision,
});
export type Actor = z.infer<typeof actorSchema>;
export const payerSchema = actorSchema.extend({
  obligationId: identifier, payerEpoch: revision, nominationEpoch: revision,
});
export type Payer = z.infer<typeof payerSchema>;
export const leaseSchema = z.strictObject({
  workspaceId: identifier, projectId: identifier, operationId: commandIdentifier,
  token: commandIdentifier, generation: revision,
});
export type Lease = z.infer<typeof leaseSchema>;
export const observationSchema = z.strictObject({
  operationId: commandIdentifier,
  evidence: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("synthetic-fault"), scenario: text }),
    z.strictObject({ kind: z.literal("authenticated-adapter"), verificationReference: identifier }),
  ]),
  merchantId: identifier, environment: z.enum(["sandbox", "live"]),
  currency: z.literal("USD"), gross: moneySchema,
  orderId: identifier,
  outcome: z.enum(["order-created", "completed", "pending", "unknown"]),
  captureId: identifier.optional(),
});
export type PaymentObservation = z.infer<typeof observationSchema>;
export { z };
