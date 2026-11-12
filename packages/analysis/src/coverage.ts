import { CoverageManifestSchema, SourceInventorySchema } from "./schemas.js";
import type { CoverageManifest, ExtractedSourceVersion } from "./schemas.js";
import { inventoryDiagnostics, referenceKey, scopeDiagnostics } from "./admission.js";
import { diagnostic, failure, invalidSchema, success } from "./results.js";
import type { AnalysisDiagnostic, ValidationResult } from "./results.js";

export interface CoverageAssessment {
  readonly scope: "supplied-source-inventory-only";
  readonly sources: readonly ExtractedSourceVersion[];
  readonly manifest: CoverageManifest;
  readonly publicationEligibility: "blocked" | "not-blocked-by-local-source-coverage";
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

/** Review attribution is caller-supplied; this checks completeness, not the reviewer's authority. */
export function evaluateCoverageManifest(
  input: unknown,
  inventoryInput: unknown,
): ValidationResult<CoverageAssessment> {
  const parsed = CoverageManifestSchema.safeParse(input);
  const parsedInventory = SourceInventorySchema.safeParse(inventoryInput);
  if (!parsed.success || !parsedInventory.success) return invalidSchema();
  const manifest = parsed.data;
  const inventory = parsedInventory.data;
  const errors = inventoryDiagnostics(inventory);
  if (manifest.workspaceId !== inventory.workspaceId) errors.push(diagnostic("WRONG_WORKSPACE"));
  if (manifest.projectId !== inventory.projectId) errors.push(diagnostic("WRONG_PROJECT"));
  if (errors.length > 0) return failure(errors);

  const diagnostics: AnalysisDiagnostic[] = [];
  const sources = new Map(inventory.sources.map((source) => [referenceKey(source), source]));
  const entries = new Map<string, CoverageManifest["entries"][number]>();
  if (sources.size === 0) diagnostics.push(diagnostic("MISSING_SOURCES"));
  for (const [index, entry] of manifest.entries.entries()) {
    const at = `entries.${index}`;
    const key = referenceKey(entry.source);
    diagnostics.push(...scopeDiagnostics(entry.source, inventory, at));
    if (!sources.has(key)) diagnostics.push(diagnostic("SOURCE_VERSION_NOT_FOUND", at));
    if (entries.has(key)) diagnostics.push(diagnostic("MANIFEST_COVERAGE_INCOMPLETE", at));
    entries.set(key, entry);
  }
  if (entries.size !== sources.size || [...sources.keys()].some((key) => !entries.has(key))) {
    diagnostics.push(diagnostic("MANIFEST_COVERAGE_INCOMPLETE", "entries"));
  }

  for (const [index, entry] of manifest.entries.entries()) {
    const at = `entries.${index}`;
    const source = sources.get(referenceKey(entry.source));
    const disposition = entry.disposition;
    if (disposition.status === "unresolved") {
      diagnostics.push(entry.materiality === "non-material"
        ? diagnostic("NONMATERIAL_SOURCE_UNRESOLVED", at, "notice")
        : diagnostic("SOURCE_UNRESOLVED", at));
    } else if (disposition.status === "reviewed") {
      if (!disposition.supportingEvidenceReviewed || !disposition.chargeWeakeningEvidenceReviewed) {
        diagnostics.push(diagnostic("EVIDENCE_REVIEW_INCOMPLETE", at));
      }
      if (source !== undefined && source.extraction.status !== "complete") {
        diagnostics.push(diagnostic("SOURCE_TEXT_UNAVAILABLE", at));
      }
      if (source !== undefined && source.permissions.studioSharing !== "permitted") {
        diagnostics.push(diagnostic("STUDIO_SHARING_NOT_PERMITTED", at));
      }
    } else if (disposition.status === "superseded") {
      diagnostics.push(...scopeDiagnostics(disposition.by, inventory, `${at}.disposition.by`));
      const visited = new Set<string>([referenceKey(entry.source)]);
      let nextKey = referenceKey(disposition.by);
      let valid = false;
      while (!visited.has(nextKey)) {
        visited.add(nextKey);
        const next = entries.get(nextKey);
        if (next === undefined || !sources.has(nextKey)) break;
        if (next.disposition.status === "reviewed") {
          valid = true;
          break;
        }
        if (next.disposition.status !== "superseded") break;
        nextKey = referenceKey(next.disposition.by);
      }
      if (!valid) diagnostics.push(diagnostic("INVALID_SUPERSESSION", at));
    }
  }

  return success({
    scope: "supplied-source-inventory-only",
    sources: inventory.sources,
    manifest,
    publicationEligibility: diagnostics.some((entry) => entry.severity === "blocking")
      ? "blocked"
      : "not-blocked-by-local-source-coverage",
    diagnostics,
  });
}
