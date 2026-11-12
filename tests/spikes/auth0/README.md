# Auth0 provider identity spike

This workspace contains deterministic assurance/configuration checks and sanitized authenticated evidence for the provider/staff Auth0 boundary.

The Next.js 16 integration:

- mounts Auth0 SDK routes through `proxy.ts`;
- requests MFA during provider login;
- persists only `amr`, `acr` and the ScopeLedger namespaced MFA boolean from the verified ID token;
- requires verified email plus MFA assurance before rendering protected provider access;
- treats authentication as identity evidence only, never as product permission or commercial authority;
- remains disabled without complete configuration while the synthetic client-review page stays available.

The actual sandbox login used a synthetic provider role and retained no email, subject identifier, token or credential in repository evidence.
