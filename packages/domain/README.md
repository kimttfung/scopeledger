# Ordered consent and financial intent

Private ESM package `@scopeledger/domain`. Build after contracts/db with `npm run build:protocol`. No HTTP routes, provider calls, UI integration or real identity verification are activated.

`new OrderedConsentStore(protocolDatabase)` provides short, runtime-validated commands with typed results. It rejects synthetic financial observations by default. Only the local harness opts into `{ observationMode: "local-synthetic-proof" }`, and that mode still forbids synthetic live observations. Boundary inputs intentionally accept `unknown` and fail closed. `PublishCommand`, `DecisionCommand`, `CorrectionAdmissionCommand` and their exported schemas allow adapters to validate/type incoming JSON explicitly.

## Product role

This package enforces the bounded-agent contract:

> **The agent can investigate and prepare the transaction; it cannot invent the obligation or authorize the money.**

AI output may arrive through a separately validated preparation layer, but these commands require provider-reviewed terms, exact version-bound human decisions, current grants, and independently verified financial observations. Included work, waived work, voluntary decline, clarification, and unresolved holds remain valid outcomes without a payment attempt.

## Commands

| API | Contract |
| --- | --- |
| `registerContext`, `createPacket`, `createUnit` | Record human-confirmed initial context and membership. Context registration is initial-only, before units; later material changes cannot bypass correction/reconciliation. New units inherit every pending unknown project-impact review. |
| `publish` | Freeze the next exact snapshot under current context, source/baseline, merchant and named-approver conditions. Reviewed reconciliation may publish with its identified correction hold, but not unresolved impact/other blockers. |
| `decide` | Exact version/digest approve/decline and authority attestation. Optional explicit response/concern/version acknowledgment resolves only identified correction holds atomically. Ordinary decline resolves nothing. Accepted old consent remains historical on reissue/decline of a replacement. |
| `resolveAcceptedConcern` | Explicitly resolve identified responses on unchanged accepted terms, without rewriting or repeating approval. Changed frozen terms instead require a fresh version/decision. |
| `admitCorrection`, `reviewImpact`, `respondToCorrection` | Durable claim/source-unavailability/processing-permission admission precedes publisher acceptance. Known scope locks sorted affected units; unknown scope stabilizes project revision and packet membership across packets. Independence releases provisional impact only, never the originating material concern or unrelated holds. Responses alone resolve nothing. |
| `placeIndependentHold` | Attributed source/stop/financial/restore restriction. There is deliberately no generic clear-hold, mark-paid or force-ready method. |
| `setGrant`, `replaceApprover`, `nominatePayer` | Permissioned prospective changes, durable attribution/epochs and separate obligation-scoped payer continuity confirmation. Current grants and applicable nomination epochs are checked before receipt replay. |
| `observePrerequisite` | Only the frozen recorder can satisfy/retract an exact prerequisite; payment and start scopes remain separate. |
| `inspectUnit` | Current authorized view of independent agreement/readiness/holds. It never certifies actual work start, delivery or original-project payment. |
| `initiatePayment`, `requestCapture` | Stable durable create/capture intents, distinct operation/provider keys and request hashes; one unresolved attempt and no overlapping old/replacement collection. Safe unpaid replacement currently requires **no prior attempt**. |
| `claimOperation`, `admitDispatch` | Worker lease, then separate protected admission. Expired/replaced leases fail. Replaying a possibly admitted operation returns reconciliation-only, never fresh dispatch permission. |
| `dispatch` | Admit and commit first, invoke the supplied narrow transport **outside** the transaction, then record its observation in a new transaction. A thrown transport result becomes unknown; it is never automatically redispatched. |
| `recordObservation`, `markOutcomeUnknown` | Internal adapter/recovery interfaces preserve original admission/basis despite later correction/revocation. Exact observations can complete the original attempt; mismatches/contradictory settled evidence are retained with a financial hold, not rewritten into success. |
| `captureReconciliationAdmission` | Internal webhook/recovery lookup for exactly one already-admitted capture operation by its verified PayPal Order ID. It grants no fresh dispatch permission and cannot manufacture an unadmitted capture. |
| `retireCreateOnlyAttempt` | Always fails `RETIREMENT_DISABLED` until SP-02 proves complete provider/dispatcher closure and durable capture denial. No clock, browser cancellation, lease generation or unexplained 404 is replacement permission. |

Consequential command IDs are scoped by workspace/project/actor and immutable request hash. Same payload converges on its durable receipt only under current authority; key reuse with another payload conflicts. Command identity is distinct from provider operation identity.

Settled observation equality uses stable financial meaning: operation, merchant/environment, exact gross/currency, Order/capture linkage and outcome. A different verification reference is independent evidence, **not** a new financial fact or a contradiction. Equivalent independently attributed observations append to the evidence/history ledger without rewriting the original operation result, capture fact, evidence or settlement timestamp; exact repeated evidence is idempotent. Actual changes in those financial/resource/outcome fields remain quarantined with financial holds. This is observation reduction, not a provider retrieval, freshness-audit scheduler or authentication implementation.

## Integration boundary

The caller must supply identity established by an actual authorized authentication adapter. `Actor` is not a user-selectable role/session picker. Initial workspace/project/grant provisioning is an out-of-band trusted administrative task; the synthetic tests insert only synthetic fixture identities. This library does not claim MFA, channel verification, legal authority, CSRF, private routing or provider postback verification.

Worker methods are **internal application interfaces**, not browser endpoints. An actual payment adapter must independently authenticate observations, validate resource linkage and obey provider-specific idempotency/reconciliation limits. The only configured proof transport is explicitly synthetic fault evidence. A lease/database fence cannot cancel a remote request that an admitted worker may still send.

The profile proves local process-crash recovery, not R1 older-backup restoration, provider key retention, create-only retirement, paid-amendment tooling or complete H1/R1 launch. Financial freshness withholds Ready after 24 hours; this package does not implement a provider audit scheduler. No provider, email, model or object-store network operation is hidden inside a transaction.
