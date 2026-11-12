# PayPal sandbox adapter

Private ESM package `@scopeledger/paypal-adapter`. It is the narrow development foundation for IP-02, not evidence that IP-02 or the Judging Release payment journey is complete.

The adapter:

- accepts only admitted `scopeledger.payment-operation.v1` create/capture requests;
- is hard-gated to PayPal sandbox and fixed PayPal API/approval origins;
- obtains and safely caches OAuth access tokens;
- sends one purchase unit with exact USD gross and a stable `PayPal-Request-Id`;
- re-reads the Order after create/capture and validates obligation, amount, currency and any returned payee identity;
- returns authenticated-adapter observations for the existing ordered-consent reducer;
- validates approval-link origin and supports PayPal postback webhook verification;
- re-fetches capture and refund resources from fixed sandbox origins, validating parent Order/capture linkage before reduction;
- normalizes an explicit event allowlist into private duplicate-safe receipts, fsyncing the receipt before acknowledgment;
- never logs or returns credentials or raw provider error payloads.

Injected fetch transports are test-only and emit explicit `synthetic-fault` evidence. Only the built-in network transport can emit `authenticated-adapter` evidence, preventing a local fixture from entering the ordinary financial-result boundary as provider proof.

It does not yet provide an HTTP return/cancel route, webhook inbox, worker process, durable approval-link storage, real sandbox evidence, create-only retirement, automated browser approval, or production/live configuration.

Configure from the repository's `.env.example`. The personal sandbox buyer email/password is not application configuration; use it only in the PayPal-hosted approval UI or an approved private test runner.
