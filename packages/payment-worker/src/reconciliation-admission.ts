import type { DispatchAdmission } from "@scopeledger/domain";

export function captureNormalizationAdmission(
  admission: DispatchAdmission,
): DispatchAdmission {
  const normalizationOnlyAdmission = {
    operationId: admission.operationId,
    providerKey: admission.providerKey,
    kind: admission.kind,
    request: admission.request,
    requestHash: admission.requestHash,
  };
  // The adapter's read-only normalizer accepts omitted dispatch flags.
  return Object.freeze(normalizationOnlyAdmission) as DispatchAdmission;
}
