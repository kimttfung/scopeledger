export const MFA_ACR_VALUE =
  "http://schemas.openid.net/pape/policies/2007/06/multi-factor";

type ProviderIdentity = {
  readonly sub: string;
  readonly email?: string;
  readonly email_verified?: boolean;
  readonly amr?: unknown;
  readonly acr?: unknown;
};

export type ProviderAssurance = Readonly<{
  subject: string;
  email: string | null;
  emailVerified: boolean;
  mfaVerified: boolean;
}>;

export function providerAssurance(
  identity: ProviderIdentity,
): ProviderAssurance {
  const methods = Array.isArray(identity.amr)
    ? identity.amr.filter((value): value is string => typeof value === "string")
    : [];
  const acr = typeof identity.acr === "string" ? identity.acr : "";
  return Object.freeze({
    subject: identity.sub,
    email: typeof identity.email === "string" ? identity.email : null,
    emailVerified: identity.email_verified === true,
    mfaVerified: methods.includes("mfa")
      || methods.includes("otp")
      || acr === MFA_ACR_VALUE
      || acr.toLowerCase().includes("multi-factor")
      || acr.toLowerCase().includes("mfa"),
  });
}
