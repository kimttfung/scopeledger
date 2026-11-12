# IP-01 acceptance proof

Run `npm run test:ip01` from the repository root. The root-owned runner builds the three packages, starts its own isolated real PostgreSQL fixture and supplies **only** `IP01_DATABASE_URL`. Direct invocation without that variable explicitly fails database proofs; it never skips, substitutes SQLite or uses in-memory locking.

Every database case creates a new strictly validated `ip01_<24 hex>` schema and drops only that owned schema. No public/user schema or real record is cleared. Fixtures and observations are synthetic. Database/provider operation identifiers never enter the committed acceptance manifest.

## Why this proof matters

IP-01 is the integrity floor for a human-authorized commerce agent. It proves that exact human decisions, corrections, holds, and financial intents cannot be replaced by a model suggestion, stale browser action, duplicate attempt, or convenient success flag. It also proves no-payment outcomes remain intact: included or waived work does not acquire an invented obligation.

The proof does not demonstrate the full visible chain—AI suggested, provider reviewed, client supplied, PayPal verified. It establishes the local ordering and persistence rules that the eventual provider integrations must obey.

## Deterministic evidence

- `canonical.test.ts` (4): strict versioned schemas, stable UTF-8/SHA-256, locale-independent object ordering, exact rationale/text/array identity, Unicode code-point limits, exact bounded BigInt/tax arithmetic and unsafe-input rejection.
- `database-safety.test.ts` (3): absent-target admission guards, reserved namespace rejection and URL/pooled-session search-path override resistance. The cases compare protected catalog metadata before/after; they never read or mutate unrelated table contents.
- `persistence.test.ts` (9): migration 001 upgrade and fresh migration 002 installation, fail-closed unknown/gapped histories, access-challenge issue/verification races with exact expiry, five durable failures and scoped issuance limits, verified webhook deduplication/conflict handling, and immutable approval-link replay.
- `protocol.test.ts` (11): stale reissue/digests, current grants/epochs before receipt replay, idempotency conflicts, composite scope boundaries, immutable SQL enforcement, waived consent, exact atomic resolution, independent holds, ordinary decline, accepted concern resolution, rollback and database-only retry.
- `races.test.ts` (19): **both commit orders** for approve/decline, known correction/capture, cross-packet unknown correction/capture, grant revocation, named-approver replacement, payer revocation, unknown-impact/membership and old/replacement collection. Also reversed multi-unit lock order, convergent payment initiation and independent same-project coexistence.
- `payments.test.ts` (13): default denial of synthetic observations outside the explicitly configured local sandbox proof, expired/replaced/paused leases, reconcile-only replay, delayed external I/O without an open DB transaction, late exact facts after restrictions, distinct pending/unknown outcomes, quarantined mismatch/contradictory settled observations, equivalent create/capture retrievals with independently retained evidence, exact create/capture linkage, authoritative capture re-fetch mapping to one admitted Order operation, financial freshness, payer continuity/re-verification, scoped prerequisites and all 16 independent-hold subsets.
- `crashes.test.ts` (6): actual **SIGKILL** after committed create/capture intent, admission and result. Each case reads durable state in a separate fresh child process and confirms stable operation/provider identity, original decision and conservative unresolved/completed state.

The race harness uses separate real backend connections, a test-only SQL trigger/advisory gate just before the first transaction commits, and observed `pg_blocking_pids`/`pg_stat_activity` for **only its own backend PIDs**. The first command is held under real production locks; the competing backend must visibly block before the gate releases. Polling/timeouts bound observations; arbitrary sleeps or `Promise.all` scheduling do not establish the order. Production code has no in-transaction test callback.

The delayed transport test explicitly observes the dispatcher's backend as idle with `xact_start = NULL` while a synthetic external callback is paused, then commits correction/revocation before releasing the callback. That is local fault evidence, not proof of any provider behavior.

The observation-reference regressions inject explicitly named **local adapter-contract fixtures** into the `authenticated-adapter` schema branch solely to exercise differing `verificationReference` values. No retrieval or authentication occurs. Their tags/references are not actual PayPal/provider evidence. Equivalent financial meaning appends attributed observations without a hold or settlement rewrite; changed amount/merchant/resource/outcome fields remain exceptions.

## Observed result and limits

See `acceptance.json` for the sanitized observed run. All proof cases must pass; a missing/failed case is not an implicit waiver.

This evidence establishes the initial PostgreSQL/domain protocol under the declared local synthetic process-failure profile. It does **not** prove actual PayPal writes/postback verification, identity/MFA, provider cancellation/key retention, create-only retirement, financial audit operations, Full Release backup reopening/HA, lawful retention/erasure, public access, production permission or Judging Release completion. Keep those gates explicit.
