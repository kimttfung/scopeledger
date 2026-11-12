export const MFA_ACR_VALUE =
  "http://schemas.openid.net/pape/policies/2007/06/multi-factor";
export const MFA_CUSTOM_CLAIM =
  "https://github.com/kimttfung/scopeledger/claims/mfa";

type ProviderIdentity = {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly amr?: unknown;
  readonly acr?: unknown;
  readonly [MFA_CUSTOM_CLAIM]?: unknown;
};

type TokenClaims = Record<string, unknown>;

export type ProviderAssurance = Readonly<{
  subject: string;
  email: string | null;
  emailVerified: boolean;
  mfaVerified: boolean;
  customMfaClaim: "present-true" | "present-false" | "missing";
}>;

export function providerAssurance(
  identity: ProviderIdentity,
): ProviderAssurance {
  const methods = Array.isArray(identity.amr)
    ? identity.amr.filter((value): value is string => typeof value === "string")
    : [];
  const acr = typeof identity.acr === "string" ? identity.acr : "";
  const customMfaClaim = Object.prototype.hasOwnProperty.call(
    identity,
    MFA_CUSTOM_CLAIM,
  )
    ? identity[MFA_CUSTOM_CLAIM] === true ? "present-true" : "present-false"
    : "missing";
  return Object.freeze({
    subject: identity.sub,
    email: typeof identity.email === "string" ? identity.email : null,
    emailVerified: identity.email_verified === true,
    mfaVerified: methods.includes("mfa")
      || methods.includes("otp")
      || acr === MFA_ACR_VALUE
      || acr.toLowerCase().includes("multi-factor")
      || acr.toLowerCase().includes("mfa")
      || identity[MFA_CUSTOM_CLAIM] === true,
    customMfaClaim,
  });
}

export function withProviderAssuranceClaims<T extends ProviderIdentity>(
  identity: T,
  claims: TokenClaims,
): T & ProviderIdentity {
  const methods = Array.isArray(claims.amr)
    ? claims.amr.filter((value): value is string => typeof value === "string")
    : undefined;
  const acr = typeof claims.acr === "string" ? claims.acr : undefined;
  const customMfa = typeof claims[MFA_CUSTOM_CLAIM] === "boolean"
    ? claims[MFA_CUSTOM_CLAIM]
    : undefined;
  return {
    ...identity,
    ...(methods ? { amr: methods } : {}),
    ...(acr ? { acr } : {}),
    ...(customMfa !== undefined
      ? { [MFA_CUSTOM_CLAIM]: customMfa }
      : {}),
  };
}
