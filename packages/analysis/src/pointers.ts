import { CandidateClaimsSchema, SourcePointerSchema } from "./schemas.js";
import type { CandidateClaims, SourcePointer } from "./schemas.js";
import {
  evaluateAutomatedAdmission,
  referenceKey,
  scopeDiagnostics,
} from "./admission.js";
import type { AutomatedAdmission } from "./admission.js";
import { diagnostic, failure, invalidSchema, success } from "./results.js";
import type { AnalysisDiagnostic, DeepReadonly, ValidationResult } from "./results.js";

export interface ValidatedSourcePointer extends SourcePointer {
  readonly validation: "source-pointer-validated";
  readonly semanticMeaning: "not-validated";
}

export interface ValidatedCandidateReview {
  readonly provenance: "untrusted-structured-candidate";
  readonly claims: readonly (CandidateClaims["claims"][number] & {
    readonly reviewState: "human-review-required";
    readonly counterEvidenceObservation: "cited" | "none-cited-in-admitted-sources";
  })[];
  readonly coverage: CandidateClaims["coverage"];
  readonly publicationEligibility: "blocked";
  readonly diagnostics: readonly AnalysisDiagnostic[];
}

function sourcePointIndex(admission: DeepReadonly<AutomatedAdmission>): ReadonlyMap<string, readonly string[]> {
  return new Map(admission.sources.map((source) => [referenceKey(source), Array.from(source.extractedText)]));
}

function pointerDiagnostics(
  pointer: SourcePointer,
  admission: DeepReadonly<AutomatedAdmission>,
  sourcePoints: ReadonlyMap<string, readonly string[]>,
  at: string,
): AnalysisDiagnostic[] {
  const errors = scopeDiagnostics(pointer.source, admission, at);
  if (errors.length > 0) return errors;
  const points = sourcePoints.get(referenceKey(pointer.source));
  if (points === undefined) return [diagnostic("SOURCE_VERSION_NOT_FOUND", at)];
  if (pointer.start >= pointer.end || pointer.end > points.length) {
    return [diagnostic("INVALID_POINTER_RANGE", at)];
  }
  if (points.slice(pointer.start, pointer.end).join("") !== pointer.quote) {
    return [diagnostic("POINTER_QUOTE_MISMATCH", at)];
  }
  return [];
}

export function validateSourcePointer(
  input: unknown,
  runInput: unknown,
): ValidationResult<ValidatedSourcePointer> {
  const parsed = SourcePointerSchema.safeParse(input);
  if (!parsed.success) return invalidSchema();
  const admission = evaluateAutomatedAdmission(runInput);
  if (!admission.ok) return admission;
  if (admission.value.status !== "local-validation-admitted") {
    return failure([diagnostic("LOCAL_ADMISSION_REQUIRED"), ...admission.value.diagnostics]);
  }
  const errors = pointerDiagnostics(parsed.data, admission.value, sourcePointIndex(admission.value), "$");
  if (errors.length > 0) return failure(errors);
  return success({
    ...parsed.data,
    validation: "source-pointer-validated",
    semanticMeaning: "not-validated",
  });
}

/** Shape and pointer fidelity only; candidate text never grants commercial or execution authority. */
export function validateCandidateClaims(
  input: unknown,
  runInput: unknown,
): ValidationResult<ValidatedCandidateReview> {
  const parsed = CandidateClaimsSchema.safeParse(input);
  if (!parsed.success) return invalidSchema();
  const candidates = parsed.data;
  const admission = evaluateAutomatedAdmission(runInput);
  if (!admission.ok) return admission;
  if (admission.value.status !== "local-validation-admitted") {
    return failure([diagnostic("LOCAL_ADMISSION_REQUIRED"), ...admission.value.diagnostics]);
  }

  const errors = scopeDiagnostics(candidates, admission.value, "$");
  const sourcePoints = sourcePointIndex(admission.value);
  const sourceKeys = new Set(admission.value.sources.map(referenceKey));
  const coverageKeys = new Set<string>();
  for (const [index, reference] of candidates.coverage.sources.entries()) {
    const at = `coverage.sources.${index}`;
    errors.push(...scopeDiagnostics(reference, admission.value, at));
    const key = referenceKey(reference);
    if (!sourceKeys.has(key)) errors.push(diagnostic("SOURCE_VERSION_NOT_FOUND", at));
    if (coverageKeys.has(key)) errors.push(diagnostic("CANDIDATE_COVERAGE_INCOMPLETE", at));
    coverageKeys.add(key);
  }
  if (coverageKeys.size !== sourceKeys.size || [...sourceKeys].some((key) => !coverageKeys.has(key))) {
    errors.push(diagnostic("CANDIDATE_COVERAGE_INCOMPLETE", "coverage.sources"));
  }

  const claimIds = new Set<string>();
  for (const [index, claim] of candidates.claims.entries()) {
    const at = `claims.${index}`;
    if (claimIds.has(claim.claimId)) errors.push(diagnostic("DUPLICATE_CLAIM", at));
    claimIds.add(claim.claimId);
    for (const [evidenceIndex, pointer] of claim.supportingEvidence.entries()) {
      errors.push(...pointerDiagnostics(pointer, admission.value, sourcePoints, `${at}.supportingEvidence.${evidenceIndex}`));
    }
    for (const [evidenceIndex, pointer] of claim.chargeWeakeningEvidence.entries()) {
      errors.push(...pointerDiagnostics(pointer, admission.value, sourcePoints, `${at}.chargeWeakeningEvidence.${evidenceIndex}`));
    }
  }
  if (errors.length > 0) return failure(errors);

  const diagnostics = [diagnostic("HUMAN_REVIEW_REQUIRED")];
  if (candidates.coverage.missingContext.length > 0) diagnostics.push(diagnostic("CANDIDATE_CONTEXT_GAP"));
  return success({
    provenance: "untrusted-structured-candidate",
    claims: candidates.claims.map((claim) => ({
      ...claim,
      reviewState: "human-review-required",
      counterEvidenceObservation: claim.chargeWeakeningEvidence.length > 0 ? "cited" : "none-cited-in-admitted-sources",
    })),
    coverage: candidates.coverage,
    publicationEligibility: "blocked",
    diagnostics,
  });
}
