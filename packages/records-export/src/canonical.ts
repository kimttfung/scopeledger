import { RecordsExportError } from "./errors.js";

function assertCanonicalValue(
  value: unknown,
  seen: Set<object>,
  depth = 0,
): void {
  if (depth > 64) {
    throw new RecordsExportError(
      "INVALID_RECORD",
      "Record nesting exceeds the canonical JSON limit",
    );
  }
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new RecordsExportError(
        "INVALID_RECORD",
        "Canonical record numbers must be safe integers",
      );
    }
    return;
  }
  if (
    typeof value !== "object"
    || seen.has(value)
    || (!Array.isArray(value)
      && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RecordsExportError(
      "INVALID_RECORD",
      "Record contains an unsupported JSON value",
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      value.length > 10_000
      || Object.getOwnPropertyNames(value).length !== value.length + 1
    ) {
      throw new RecordsExportError(
        "INVALID_RECORD",
        "Record array is sparse or exceeds the canonical limit",
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, index);
      if (!property?.enumerable || !("value" in property)) {
        throw new RecordsExportError(
          "INVALID_RECORD",
          "Record arrays cannot contain accessors",
        );
      }
      assertCanonicalValue(property.value, seen, depth + 1);
    }
  } else {
    const names = Object.getOwnPropertyNames(value);
    if (names.length > 1_000 || Object.getOwnPropertySymbols(value).length > 0) {
      throw new RecordsExportError(
        "INVALID_RECORD",
        "Record object exceeds the canonical field limit",
      );
    }
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (!property?.enumerable || !("value" in property)) {
        throw new RecordsExportError(
          "INVALID_RECORD",
          "Record objects cannot contain hidden fields or accessors",
        );
      }
      assertCanonicalValue(property.value, seen, depth + 1);
    }
  }
  seen.delete(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
    .join(",")}}`;
}

export function canonicalRecordJson(value: unknown): string {
  assertCanonicalValue(value, new Set());
  return serialize(value);
}
