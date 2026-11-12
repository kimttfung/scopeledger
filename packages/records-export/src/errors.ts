export type RecordsExportErrorCode =
  | "INVALID_SCOPE"
  | "INCOMPLETE_PROJECTION"
  | "UNSUPPORTED_PROJECTION_VERSION"
  | "BOUND_EXCEEDED"
  | "INVALID_RECORD"
  | "OUTPUT_TOO_LARGE";

export class RecordsExportError extends Error {
  constructor(
    public readonly code: RecordsExportErrorCode,
    message: string,
    public readonly references: readonly string[] = [],
  ) {
    super(message);
    this.name = "RecordsExportError";
  }
}
