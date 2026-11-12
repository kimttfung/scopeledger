# Ordered-consent PostgreSQL store

Private ESM package `@scopeledger/db`, using pinned Kysely and node-postgres. Build with `npm run build --workspace @scopeledger/db`.

`ProtocolDatabase({ connectionString, schema, maxConnections? })` exposes typed `kysely`, `pool`, `transaction`, `migrate` and `close`. `sql`, `Database`, `ProtocolTransaction` and `SqlExecutor` support explicit reviewed SQL. This module reads no environment variables.

## Product role

PostgreSQL is the authority boundary beneath ScopeLedger's human-authorized commerce agent. It preserves attributed source/context, exact versions, human decisions, durable financial intents, provider observations, holds, and history without compressing them into an opaque "AI approved" or "paid" status. The schema deliberately supports legitimate no-payment outcomes and prevents a model suggestion, browser return, or duplicate retry from becoming a financial fact.

Reviewed SQL migrations live under `src/migrations/` and run sequentially under a schema-scoped advisory migration lock. Migrations 001-007 establish ordered consent, runtime and analysis persistence, provider authoring/publication/baseline confirmation, and provider reconciliation. Migration 008 adds private client question/correction drafts scoped to the exact review unit, participant subject, current approver nomination, and draft kind. Existing contiguous installations upgrade in place, fresh schemas receive every known migration, and unknown, gapped, empty-version or unversioned nonempty histories fail closed. Use a dedicated schema and a privileged migration connection; do not expose database access to clients.

The dedicated target schema must **already exist**. Both `migrate` and `transaction` fail before their DDL/work callback if it is absent or inaccessible; they never fall through to a system namespace. `public`, `information_schema` and every `pg_*` name are forbidden targets. PostgreSQL URL parameters `options`, `search_path`, `searchpath` and `schema` are rejected rather than allowed to override the library's namespace settings. Each transaction reasserts a transaction-local path with the validated target first, then `pg_catalog`, with `pg_temp` last, defeating a pooled session's earlier `SET search_path` without leaking the override after release.

Raw `pool`/`kysely` access is reserved for trusted reviewed SQL and explicit schema lifecycle operations. It is not a sandbox for arbitrary SQL: a trusted callback can explicitly name other schemas or change its own settings. The namespace guarantees apply to library migration/command admission, not hostile database owners or arbitrary externally supplied SQL.

## SQL guarantees

- Composite workspace/project foreign keys, including published source/baseline references.
- Immutable canonical bytes/digest/snapshot, decisions, context versions, responses, observations, facts, receipts and history. PostgreSQL verifies SHA-256 and JSON/byte identity on publication.
- One terminal approve-or-decline per exact unit version.
- One unresolved attempt per obligation (`one_unresolved_attempt`).
- One collectible obligation per collection family (`one_collectible_family`), **in addition to** attempt uniqueness. Obligation insertion requires the exact approved payable basis. Existing attempts prohibit disabling old collection through this initial protocol.
- Stable operation/provider key/request hash and admitted chronology. Attempt attribution, established Order linkage and resolved outcomes cannot be rewritten.
- One active scoped access challenge per recipient reference and role, immutable keyed code digests, exact expiry, five-attempt maximum and terminal verified/superseded history.
- Immutable verified PayPal webhook receipts deduplicated by environment/merchant/event identity. Duplicate normalized content converges; conflicting content cannot overwrite the first receipt. Raw payloads are not stored.
- Immutable PayPal approval links bound to one recorded create operation and Order. Exact replay is idempotent; changed Order or URL values conflict.
- Immutable, bounded extracted source versions with exact-text digests, explicit synthetic-or-permitted provenance, parser references, model permissions, and complete page coverage.
- Human-review-required analysis runs with safe provider/model/schema/config references and either structured candidates or normalized failure diagnostics. Publication remains database-blocked.
- Append-only provider review records bound to the exact run and candidate digests. These records grant no pricing, consent, payment, publication, or work authority.
- Immutable provider-created project/request metadata, source-intake provenance and permission state, and sequential provider draft revisions bound to existing scoped identities.
- Immutable client questions bound to an exact published unit version. Questions preserve attributed Unicode text and are constrained to `communication-only`; they create no decision, correction, hold, obligation, payment, readiness, or work-start record.
- Mutable private client review drafts with exact Unicode text, optional correction source text, separate model permission, optimistic revisions, server-computed digests, and a seven-inactive-day expiry. Draft authority is rechecked on every read/write/delete; a replacement approver cannot inherit a predecessor draft.

Money is stored as strictly checked exact decimal **text**, not a scale-constrained numeric column that could silently round invalid input. SQL comparisons validate the approved basis; application arithmetic uses BigInt.

Ordinary commands take shared workspace/project policy fences, shared packet guards and sorted unit row locks; only impacted context/nomination/membership changes need conflicting policy fences. Family/obligation/attempt/operation locks follow units. Command-key advisory locks serialize only an identical actor/key.

`transaction` retries **only** PostgreSQL `40001` and `40P01`, up to three retries. Its callback is exclusively database work: never put a provider/model/storage/email call inside it. External writes must use the domain intent/admission/dispatch protocol, not transaction retries.

## Isolated proof lifecycle

`PostgresAccessChallengeStore`, `PostgresPayPalWebhookReceiptStore`, `PostgresPayPalApprovalLinkStore`, `PostgresAnalysisStore`, `PostgresAuthoringStore`, and `PostgresClientReviewDraftStore` expose typed atomic runtime APIs. Challenge verification accepts only a caller-produced keyed digest; this package never receives a plaintext code and does not send email or sign browser sessions. Webhook insertion accepts already verified normalized data only. Approval-link validation is limited to matching PayPal HTTPS origins and the recorded operation/Order/environment. Analysis storage is restricted to the fixed local synthetic demo scope; exact retries converge, changed immutable content conflicts, and review identities cannot be rebound. Authoring locators always require workspace/project scope; repeated immutable content converges while changed replay conflicts. Client draft same-content saves refresh inactivity expiry without creating a revision; changed stale revisions conflict, and exact-revision deletion cannot remove a newer browser edit.

`createIsolatedProofDatabase(url)` creates a cryptographically generated `ip01_<24 hex>` schema, applies all reviewed migrations, and returns an owned `dispose`. `validateProofSchema` rejects every other name. Cleanup drops only that newly owned schema; `public`, `pg_*`, user schemas and real records are never cleared. The runner must supply a disposable PostgreSQL database; the proof itself has no generic `DATABASE_URL` fallback.

These are relational/domain invariants, not an RLS/identity/provider-authentication implementation or a lawful-retention policy. The database owner remains trusted. This first proof intentionally has no content-erasure, paid-amendment closure, primary-failure or older-backup reopening path. Future production migrations must add authorized retention/role boundaries without silently changing canonical historical terms.

## Identifier boundary

The IP-01 entity/reference columns use bounded opaque text identifiers so deterministic synthetic fixtures and external resource IDs retain exact identity. Opaque means the protocol does not interpret a name as authority; it does **not** mean unpredictable, anonymous or secret. Commands, attempts, operations and provider keys already use generated UUID identities; generated obligation UUIDs are currently stored in a text column.

Architecture section 4's UUID policy remains the intended production policy for internal entities, not a claim that every proof column already enforces it. Production provisioning should generate UUIDs for internal workspace/project/actor/unit/source/etc. identities; external merchant/Order/capture identifiers remain separate provider-owned opaque strings. Tightening database entity types needs a reviewed migration/mapping boundary, not a broad rewrite of this proof or recomputation of old published snapshots/digests. UUID strings are already a valid subset of the v1 opaque transport contract.
