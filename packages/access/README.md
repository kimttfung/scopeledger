# Local scoped-access verification

Private ESM package `@scopeledger/access`. It provides a local demonstration boundary for client-approver and payer channel verification.

- Six-digit codes are stored only as keyed hashes.
- Challenges expire after ten minutes, allow at most five attempts, and newer requests supersede active older requests.
- At most three challenges per recipient/role may be issued in ten minutes.
- Successful verification creates a 30-minute HMAC-signed session containing a pseudonymous subject and role, not the email address.
- Verification proves control of the local test inbox only. It does not prove legal/commercial authority, agreement consent or payment permission.

The file store is private local spike infrastructure and is not suitable for public multi-instance deployment.
