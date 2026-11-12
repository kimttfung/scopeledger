import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { decodeJwt } from "jose";
import { readAuth0Environment } from "./auth0-config";
import {
  MFA_ACR_VALUE,
  withProviderAssuranceClaims,
} from "./provider-session";

export const auth0Environment = readAuth0Environment();

export const auth0 = auth0Environment.configured
  ? new Auth0Client({
    domain: auth0Environment.value.domain,
    clientId: auth0Environment.value.clientId,
    clientSecret: auth0Environment.value.clientSecret,
    secret: auth0Environment.value.secret,
    appBaseUrl: auth0Environment.value.appBaseUrl,
    signInReturnToPath: "/provider",
    authorizationParameters: {
      scope: "openid profile email",
      acr_values: MFA_ACR_VALUE,
    },
    beforeSessionSaved: async (session, idToken) => {
      if (!idToken) return session;
      return {
        ...session,
        user: withProviderAssuranceClaims(
          session.user,
          decodeJwt(idToken),
        ),
      };
    },
  })
  : null;
