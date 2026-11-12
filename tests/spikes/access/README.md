# Local client/payer channel verification spike

The local demo sends a six-digit code through the owned Mailpit service and verifies it through a same-origin ScopeLedger API.

Security properties:

- only reserved `@scopeledger.test` recipients are supported;
- codes are stored as keyed hashes, never plaintext;
- challenges expire after ten minutes and allow at most five attempts;
- newer requests supersede active older requests;
- issuance is rate-limited per recipient and role;
- successful verification creates a 30-minute HttpOnly, SameSite=Lax HMAC session containing a pseudonymous subject and role, not the email address;
- channel control never establishes legal authority, agreement consent, payer nomination or payment authorization.

The file challenge store and local email inbox are demonstration infrastructure, not public multi-instance identity services.
