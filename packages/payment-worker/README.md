# Payment worker integration

Private ESM package `@scopeledger/payment-worker`. It connects the proven ordered-consent dispatch boundary to the sandbox PayPal adapter without making browser state or an adapter call its own authority.

`PayPalPaymentWorker.run(lease, payer)`:

1. asks the domain store to admit dispatch under current PostgreSQL fences;
2. executes the admitted create/capture operation through the PayPal adapter only after commit;
3. lets the domain reducer record the authenticated provider observation;
4. stores a validated create approval link only after domain dispatch returns successfully.

The local `FileApprovalLinkStore` remains a deterministic adapter-contract fixture. Real IP-02 execution uses `PostgresPayPalApprovalLinkStore`, which keys links by scoped operation, validates the recorded Order/environment basis and rejects changed replay.

This package does not create identity, retries, live payment permission or a
deployment scheduler. Scheduling remains an external cron concern.

`PayPalCaptureReconciler` is the bounded reconciliation exception: it re-fetches a capture from PayPal, resolves the one admitted capture operation by the provider Order ID, reconstructs the exact observation and lets the domain reducer apply idempotency/mismatch rules. It never trusts a webhook status as the financial fact.

`PayPalFinancialAuditor` adds the read-only Judging Release audit boundary. It selects
active admitted capture operations in deterministic keyset pages, re-fetches
the exact known capture or original Order, and sends only normalized
observations through the existing reducer. It never dispatches capture,
initiates refund, creates another attempt, refreshes immutable settlement
timestamps or clears a hold. A stale exact fact therefore remains reported as
withheld when the existing reducer cannot restore freshness.

`PostgresPayPalFinancialAuditSource` exposes bounded target, receipt and safe
aggregate reads without a new migration. Webhook health reports counts,
receipt timing and categorized operational failures only; provider resource
identities, tokens, hidden-project amounts and raw provider errors are not
part of its aggregate contracts.
