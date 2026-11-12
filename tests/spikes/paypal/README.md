# PayPal sandbox integration spike

This workspace contains the local adapter contract tests and sanitized evidence for IP-02. Provider resource IDs, credentials, buyer login details, approval URLs and raw payloads are never committed.

## Current evidence

On November 11, 2026, the sandbox-only adapter authenticated with the configured Merchant app and completed two fresh USD 1.00 create -> Personal buyer approval -> capture -> retrieve flows. Both retrieved Orders contained the expected amount, currency and configured merchant identity, and both capture statuses were `COMPLETED`.

PayPal's real Return to Merchant action also reached the local ScopeLedger return route. That route correctly showed server verification pending rather than treating browser navigation as payment evidence.

After the configured webhook was exposed through an ephemeral HTTPS tunnel, real `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` sandbox events passed PayPal postback verification. The receiver stored only normalized event/resource identity and status in duplicate-safe private receipts, with file and directory synchronization before returning 2xx.

A further fresh USD 1.00 flow ran through an owned real-PostgreSQL schema, ordered-consent intent, current payer authorization, lease admission, post-commit payment worker, exact PayPal create/capture and domain observation reduction. After explicit buyer approval, the resumed capture preserved the original attempt and the domain derived `ready`.

This proves a bounded first-party PayPal sandbox path through the durable application protocol. IP-02 remains incomplete because real duplicate/reordered/invalid delivery handling, lost-response recovery, endpoint key-retention behavior, refund reads and same-attempt authorization recovery remain outstanding.

Run local deterministic adapter checks with:

```sh
npm run test:paypal:local
```

The one-time real-sandbox diagnostic is deliberately separate:

```sh
npm run paypal:sandbox:create
# Approve with the Personal sandbox buyer.
npm run paypal:sandbox:capture
```
