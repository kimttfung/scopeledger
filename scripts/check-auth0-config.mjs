const required = [
  "AUTH0_DOMAIN",
  "AUTH0_CLIENT_ID",
  "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET",
  "APP_BASE_URL",
];

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Auth0 configuration incomplete: ${missing.join(", ")}`);
  process.exitCode = 1;
} else if (!/^[a-f0-9]{64}$/i.test(process.env.AUTH0_SECRET)) {
  console.error("Auth0 configuration invalid: AUTH0_SECRET must be a 32-byte hex value");
  process.exitCode = 1;
} else {
  const appBaseUrl = new URL(process.env.APP_BASE_URL);
  console.log(JSON.stringify({
    configured: true,
    domain: process.env.AUTH0_DOMAIN,
    appBaseOrigin: appBaseUrl.origin,
    callbackUrl: `${appBaseUrl.origin}/auth/callback`,
    logoutUrl: appBaseUrl.origin,
    webOrigin: appBaseUrl.origin,
    clientSecretConfigured: true,
    sessionSecretConfigured: true,
  }, null, 2));
}
