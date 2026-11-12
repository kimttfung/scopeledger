# Payment worker integration

Private ESM package `@scopeledger/payment-worker`. It connects the proven ordered-consent dispatch boundary to the sandbox PayPal adapter without making browser state or an adapter call its own authority.

`PayPalPaymentWorker.run(lease, payer)`:

1. asks the domain store to admit dispatch under current PostgreSQL fences;
2. executes the admitted create/capture operation through the PayPal adapter only after commit;
3. lets the domain reducer record the authenticated provider observation;
4. stores a validated create approval link only after domain dispatch returns successfully.

The local `FileApprovalLinkStore` is a private spike store. It uses one atomic file per operation, rejects changed links, synchronizes file/directory state and stores no credentials. Production integration should replace it with an authorized database/object contract and expose links only through current payer access.

This package does not create identity, HTTP routes, worker scheduling, retries, provider reconciliation or live payment permission.

`PayPalCaptureReconciler` is the bounded reconciliation exception: it re-fetches a capture from PayPal, resolves the one admitted capture operation by the provider Order ID, reconstructs the exact observation and lets the domain reducer apply idempotency/mismatch rules. It never trusts a webhook status as the financial fact.
