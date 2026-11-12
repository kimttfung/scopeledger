import { createHash } from "node:crypto";
import { auth0, auth0Environment } from "../../../lib/auth0";
import { providerAssurance } from "../../../lib/provider-session";

export type VerifiedProviderResult =
  | Readonly<{
    ok: true;
    subjectDigest: string;
  }>
  | Readonly<{
    ok: false;
    status: 401 | 403 | 503;
    code:
      | "AUTHENTICATION_UNAVAILABLE"
      | "AUTHENTICATION_REQUIRED"
      | "PROVIDER_ASSURANCE_REQUIRED";
    message: string;
  }>;

export async function verifiedProvider(): Promise<VerifiedProviderResult> {
  if (!auth0Environment.configured || !auth0) {
    return {
      ok: false,
      status: 503,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is unavailable.",
    };
  }
  let session;
  try {
    session = await auth0.getSession();
  } catch {
    return {
      ok: false,
      status: 503,
      code: "AUTHENTICATION_UNAVAILABLE",
      message: "Provider authentication is temporarily unavailable.",
    };
  }
  if (!session) {
    return {
      ok: false,
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
      message: "Sign in before accessing provider analysis.",
    };
  }
  const assurance = providerAssurance(session.user);
  if (!assurance.emailVerified || !assurance.mfaVerified) {
    return {
      ok: false,
      status: 403,
      code: "PROVIDER_ASSURANCE_REQUIRED",
      message: "Verified email and MFA assurance are required.",
    };
  }
  return {
    ok: true,
    subjectDigest: createHash("sha256")
      .update(`scopeledger-auth0-sub:${assurance.subject}`, "utf8")
      .digest("hex"),
  };
}
