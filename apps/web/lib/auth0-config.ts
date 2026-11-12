const domainPattern = /^[A-Za-z0-9][A-Za-z0-9.-]{1,253}$/;
const hexSecretPattern = /^[a-f0-9]{64}$/i;

export type Auth0Environment = Readonly<{
  domain: string;
  clientId: string;
  clientSecret: string;
  secret: string;
  appBaseUrl: string;
}>;

export type Auth0EnvironmentState =
  | { readonly configured: false; readonly missing: readonly string[] }
  | { readonly configured: true; readonly value: Auth0Environment };

export function readAuth0Environment(
  environment: NodeJS.ProcessEnv = process.env,
): Auth0EnvironmentState {
  if (environment.SCOPELEDGER_AUTH0_DISABLED === "1") {
    return Object.freeze({
      configured: false,
      missing: Object.freeze(["SCOPELEDGER_AUTH0_DISABLED"]),
    });
  }
  const required = {
    AUTH0_DOMAIN: environment.AUTH0_DOMAIN,
    AUTH0_CLIENT_ID: environment.AUTH0_CLIENT_ID,
    AUTH0_CLIENT_SECRET: environment.AUTH0_CLIENT_SECRET,
    AUTH0_SECRET: environment.AUTH0_SECRET,
    APP_BASE_URL: environment.APP_BASE_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    return Object.freeze({ configured: false, missing: Object.freeze(missing) });
  }
  const domain = required.AUTH0_DOMAIN!;
  if (!domainPattern.test(domain) || domain.includes("://")) {
    throw new Error("AUTH0_DOMAIN must be the tenant hostname without a protocol");
  }
  if (!hexSecretPattern.test(required.AUTH0_SECRET!)) {
    throw new Error("AUTH0_SECRET must be a 32-byte hex value");
  }
  const appBaseUrl = new URL(required.APP_BASE_URL!);
  if (
    appBaseUrl.username
    || appBaseUrl.password
    || appBaseUrl.hash
    || (appBaseUrl.protocol !== "https:"
      && !(appBaseUrl.protocol === "http:"
        && ["127.0.0.1", "localhost", "::1"].includes(appBaseUrl.hostname)))
  ) {
    throw new Error("APP_BASE_URL must use HTTPS or local loopback HTTP");
  }
  return Object.freeze({
    configured: true,
    value: Object.freeze({
      domain,
      clientId: required.AUTH0_CLIENT_ID!,
      clientSecret: required.AUTH0_CLIENT_SECRET!,
      secret: required.AUTH0_SECRET!,
      appBaseUrl: appBaseUrl.origin,
    }),
  });
}
