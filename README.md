# ScopeLedger

For the local/reproducible H1 judging workflow, see [JUDGING.md](JUDGING.md).

```sh
npm run h1:prepare
npm run h1:start
npm run dev
npm run h1:doctor
npm run h1:acceptance:full
```

The latest observed local full acceptance completed **52 commands and 556 tests with zero failures or skips** without automatic provider writes, financial effects, or external email delivery.

The client-facing implementation is a **synthetic client-review UI prototype**, not the H1 application. It follows the selected Studio Standards composition B, with a compact comparison of the superseded and current proposals. Backend proof workspaces are separate from that UI; installing them does not activate approval, identity, model, or payment capabilities.

## Product framing

**ScopeLedger is a human-authorized fair-commerce agent for service businesses.** It turns ambiguous client requests into correctable, evidence-backed agreements, then uses PayPal to move only the exact amount both sides approved.

The visible responsibility chain is:

> **Request → AI comparison → provider review → client correction → reanalysis → exact agreement → PayPal-verified payment → work authorization**

The agent may investigate, organize evidence, identify uncertainty, and prepare a transaction. It cannot invent the obligation, choose the price or recipient, grant authority, approve terms, or authorize money. Every consequential fact stays attributed as **AI suggested**, **provider reviewed**, **client supplied**, or **PayPal verified**.

A successful result does not require payment. Correctly preserving included work, recording a courtesy, reaching an informed decline, or holding an ambiguous request for clarification are fair outcomes. When payment is required, PayPal is a commercial state transition—not a decorative checkout button: no Order exists before exact approval, and only authoritative capture can satisfy the payment condition.

This framing combines the strongest applicable inspiration categories without adding unrelated product scope:

- **Business solution:** clearer mid-project commercial decisions for fixed-price studios.
- **Bounded agentic automation:** meaningful AI work with explicit human authority.
- **Money-movement experience:** payment linked to one exact approved obligation.
- **Client experience:** concise, account-light review, correction, and decision.
- **Fair-commerce impact:** less informational imbalance and fewer surprise charges, without claiming broad financial inclusion.

Do not expand the submission with autonomous pricing/charging, marketplaces, payouts, donations, generic finance dashboards, multicurrency billing, or broad negotiation agents. Those are different products and would weaken the end-to-end corrected-promise story.

## Run locally

The verified development/proof runtime is Node.js **26.0.0** with npm **11.12.1**. Use the repository-pinned dependencies below; the frontend framework's minimum Node version alone is not a compatibility guarantee for the complete toolchain.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:3000>. To choose another port, use `npm run dev -- --port 3210`.

Use the root `npm run dev` command for PayPal work. It prepares an ignored `apps/web/.env.local` link to the gitignored repository-root file so Next.js receives the same server-only configuration without copying secrets. Running the web workspace directly does not prepare that link.

```sh
npm run typecheck
npm run lint
npm run build
```

For the browser interaction and reflow checks:

```sh
npx playwright install chromium
npm run test:ui
```

The browser suite uses a local preview on port 3210, starting one when necessary.

The Next.js/React/TypeScript frontend lives in `apps/web`. The original composition references are in `.impeccable/mocks/`.

Component-preview metadata lives in `.impeccable/design.json`. Screen-specific composition decisions live in `apps/web/.impeccable/surfaces/`.

## PayPal sandbox exploration with Postman

Postman is selected as a **development-time companion for IP-02**, not as a runtime dependency or payment authority. Once the PayPal sandbox/tooling gate is approved, use [PayPal's official Postman collection](https://developer.paypal.com/api/rest/postman/) to inspect and reproduce the narrow Orders flow before and alongside the application adapter.

- Use dedicated sandbox merchant/buyer identities. Keep client secrets and access tokens only in an approved local or secret Postman variable store; never commit, export, log, screenshot, or place them in shared documentation.
- Record the collection/fork version or date, environment, request assertions, and sanitized observed behavior for create, retrieve, capture, and applicable refund/reconciliation reads.
- Treat Postman mock responses, manually edited variables, collection-test success, and a browser approval page as diagnostics only. They do not prove durable application intent, exact version linkage, capture admission, verified webhooks, idempotent recovery, or authoritative reconciliation.
- The IP-02 acceptance path must still run through ScopeLedger's reviewed REST adapter and worker protocol, then re-read provider state and preserve unknown outcomes. No production credentials, customer documents, or private repository content belong in Postman.

### Repository-side PayPal foundation

`@scopeledger/paypal-adapter` now provides the sandbox-only OAuth, Order create/capture/retrieve normalization, exact amount/merchant checks, approval-origin validation, one bounded authentication refresh, and webhook postback-verification boundary. It is local contract code, not completed IP-02 evidence or a connected UI.

To prepare local configuration without exposing credentials:

```sh
cp .env.example .env.local
# Fill only the PayPal sandbox values in .env.local.
npm run check:paypal-config
npm run check:paypal-auth
npm run test:paypal:local
```

`.env.local` is ignored. The authentication check requests an OAuth token but prints only the environment and configured merchant ID; it never prints the token or credentials. Do not put the Personal sandbox buyer password in application configuration: use it only in the PayPal-hosted approval page or an approved private browser-test secret. Leave `PAYPAL_WEBHOOK_ID` blank until the repository has a reachable HTTPS webhook endpoint and that URL is registered against the ScopeLedger sandbox app.

For the bounded one-time connectivity diagnostic:

```sh
npm run paypal:sandbox:create
# Open the printed approval URL and approve with the Personal sandbox buyer.
npm run paypal:sandbox:capture
```

This creates a real PayPal **sandbox** Order for USD 1.00 by default and stores only its non-secret diagnostic state under ignored `.paypal-sandbox/`. It does not create application consent, satisfy IP-02, or use live money. Set `PAYPAL_PROBE_AMOUNT` locally only when a different exact sandbox amount is deliberately required.

### Observed sandbox status

Two fresh Merchant-app create -> Personal-buyer approval -> server capture -> provider retrieve flows completed on November 11, 2026. The adapter matched the configured merchant, USD 1.00 gross and completed capture in both runs. The sanitized [partial acceptance manifest](tests/spikes/paypal/acceptance.json) omits provider identifiers and credentials.

PayPal's real **Return to Merchant** action now resolves to `/payments/paypal/return`. The route deliberately shows server verification pending; the companion cancellation route likewise infers no payment result from navigation.

Real `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` sandbox events also passed PayPal postback signature verification through the HTTPS receiver. Each verified event was normalized and durably stored in a duplicate-safe private receipt before acknowledgment; raw payloads and payer data were not retained.

The PostgreSQL-backed Cedar Roastery journey now exercises the approved USD 300.00 obligation through verified local payer access, server-owned Checkout preparation, PayPal's full-page sandbox approval, an honest pending return page, and explicit server-side capture/retrieval. Authoritative reconciliation changed readiness from `awaiting-payment` to `ready`; work start remained `not recorded`. The sanitized [payment-journey acceptance manifest](tests/spikes/payment-ui/acceptance.json) contains no provider identifiers or credentials.

IP-02 remains incomplete for controlled lost-response recovery, real duplicate/reordering/invalid-event deliveries against a stable webhook endpoint, external refund/reversal observations, accessible assistive-technology coverage, and deployed recovery operations.

The return journey also exposes an explicit read-only reconciliation action for the existing server-known capture. It performs OAuth plus authoritative capture retrieval without redispatching capture or creating a replacement attempt. The completed sandbox attempt was refreshed live as `completed` / `ready`; uncertain attempts without a stored capture identity remain an honest manual-recovery state. See the sanitized [payment-recovery manifest](tests/spikes/payment-recovery/acceptance.json).

`@scopeledger/payment-worker` now connects the domain dispatch callback to the PayPal adapter. It stores a validated approval link only after the domain has recorded the provider observation; capture operations never create a link. The real IP-02 runner now uses the immutable PostgreSQL approval-link store rather than the earlier local file spike.

One additional fresh USD 1.00 flow has now run through an owned real-PostgreSQL database, exact agreement/payer commands, durable create and capture intents, worker lease admission, the PayPal adapter and authenticated observation reduction. The original attempt resumed after buyer approval and the domain derived `ready`; no fixture or browser callback set that state.

Webhook capture reconciliation now re-fetches `/v2/payments/captures/{id}`, validates merchant/Order/currency/gross, resolves exactly one admitted capture operation and applies the ordinary domain observation reducer. Duplicate or reordered notifications therefore cannot supply their own financial truth. Refund retrieval is implemented as a fixed-origin read of `/v2/payments/refunds/{id}` with validated parent-capture linkage; it cannot initiate a refund or rewrite the original payment.

`npm run paypal:webhooks:process` now processes stored normalized receipts in deterministic provider-created/received/event order. Per-receipt failures do not stop later work, and summaries expose only event types, outcomes and counts. The current local run had no queued receipts because the prior temporary webhook URL is not a stable ingress; this is not evidence that webhook delivery is complete.

## Local backend proofs

| Workspace | Responsibility |
| --- | --- |
| `packages/contracts` | Validated published-unit contracts and canonical fingerprints. |
| `packages/db` | PostgreSQL schema/migration and typed persistence boundary. |
| `packages/domain` | Ordered consent, correction, and financial-intent commands. |
| `packages/analysis` | Local extracted-source, Unicode-pointer, budget, and coverage validation only. |
| `packages/adapters/gemini` | Permission-gated Gemini structured-output candidates with local exact-pointer validation. |
| `packages/adapters/parser` | Bounded child-process PDF inspection/extraction and immutable source sealing. |
| `packages/payment-worker` | Admitted PayPal dispatch sequencing and private approval-link handoff after domain observation. |

Use the repository-pinned TypeScript 6.0.3. It supplies the JavaScript compiler API required by the existing ESLint stack; mixing the native TypeScript 7 package into that stack breaks linting.

### PostgreSQL runtime and IP-01

Start Docker Desktop, then:

```sh
npm run test:runtime
npm run check:ip01-runtime
npm run test:ip01
```

The readiness command establishes only that the real PostgreSQL runtime is available. It does **not** run or complete IP-01 acceptance tests.

The IP-01 runner starts its own uniquely named PostgreSQL 17 container, pinned by image digest, on a dynamically assigned **127.0.0.1-only** port. It checks the actual database identity and requires `fsync=on` and `synchronous_commit=on`. Credentials are generated per run and redacted from child output. There are no host-directory mounts. Cleanup checks an ownership label and removes only that run's container and disposable data; existing services and application databases are not targeted.

An explicitly configured `IP01_DATABASE_URL` may select an existing disposable database named `scopeledger_ip01` or `scopeledger_ip01_<suffix>`. The runner checks the actual connected database, not just its URL. It never falls back to `DATABASE_URL`, SQLite, mocked locks, or skipped tests. Do not supply a real application database. Tests must create and clean only their own generated schemas; the runner does not drop an explicitly supplied database.

The proof's failure profile is application-process crash/recovery and deterministic local faults. It does not establish host/primary failure tolerance, older-backup reopening, actual PayPal behavior, legal clearance, or production readiness.

The verified IP-01 suite has **65 passing cases, zero skipped**, including both commit orders for the required races, runtime-record persistence, authoritative capture-to-operation reconciliation and six actual SIGKILL/readback boundaries. Its versioned [acceptance manifest](tests/spikes/ordered-consent/acceptance.json) distinguishes local PostgreSQL/fault evidence from unproved provider and release gates. See the [proof inventory](tests/spikes/ordered-consent/README.md) and [domain API boundaries](packages/domain/README.md).

Production migration targets must be explicitly created dedicated schemas. Protected or missing namespaces and namespace-changing connection-URL options fail closed. Transactions reset their schema locally rather than trusting a previous pooled session's `search_path`.

### Persistent local review state

The development demo can run an owned PostgreSQL service on `127.0.0.1:5433` with an owned persistent Docker volume:

```sh
npm run prepare:dev-db
npm run dev:db:start
npm run dev:db:migrate
npm run seed:demo
```

The Cedar Roastery seed creates version 1, the client correction, provider response and version 2 through ordinary domain commands. The main review reads a no-store projection for agreement, payment and readiness facts. After local client-approver channel verification, approve/decline remains preview-first but an explicit record action submits the exact server-owned version/digest and identified concern response. Approval creates agreement/obligation state only; it never initiates payment.

Migration 002 persists local access challenges, normalized verified PayPal webhook receipts and immutable PayPal approval links in PostgreSQL. Migration 003 adds immutable analysis source/run records and append-only human review dispositions. Codes remain keyed digests, raw webhook bodies are not stored, and changed duplicate provider identities fail closed.

Migration 004 adds scoped provider-created project/request identities, immutable source-intake records, sequential authoring-draft revisions, exact draft-to-source references and communication-only client questions. Migration 005 adds immutable provider commercial preparations and publication provenance. Migration 006 adds explicit source-backed baseline confirmation; uploads never become baselines automatically.

Migration 007 adds attributed provider question responses and correction applicability assessments. Material corrections create only an immutable in-progress reissue draft; normal preparation, publication and fresh client consent remain mandatory.

Migration 008 adds private project/unit/participant-scoped client drafts with immutable revisions, exact Unicode, model permission, seven-inactive-day expiry and cross-browser recovery. Draft save/delete creates no submission, hold, notification, model call or commercial effect.

Migration 009 adds a durable notification outbox with leases, bounded attempts, delivery receipts, dedupe and safe terminal states. Consequential events enqueue template-safe structured intent before SMTP; dispatch rechecks current grants, versions and collectible obligations so revoked or obsolete notices are suppressed rather than sent.

Prepare and exercise the local H1 operations profile:

```sh
npm run prepare:h1-operations
npm run notifications:process
npm run paypal:financial-audit:status
npm run paypal:financial-audit
npm run test:notifications
npm run test:evaluator-controls
npm run test:financial-audit
```

Evaluator limits use PostgreSQL advisory-lock admission and existing persisted source/run counts. The local profile permits three analysis runs, five uploads/25 MB per project per 60 minutes and two Gemini calls; exhaustion returns explicit stable codes and retains parser/manual review rather than fabricating a model result.

The protected `/provider/authoring` workspace has exercised a real synthetic project, request, private text upload, immutable draft revisions, explicit local client-authority activation, baseline confirmation, exact USD 200 payable preparation and publication. The generated opaque review recorded a real exact approval; the provider then separately activated the fixed local payer, and the opaque custom payer flow completed PayPal Sandbox approval/capture and derived `ready`. Work start remains separate and unrecorded.

Prepare the ignored private local object root before source intake:

```sh
npm run prepare:object-storage
npm run test:object-storage
npm run test:provider-source-intake
npm run test:provider-authoring
```

`@scopeledger/object-storage-adapter` writes content-addressed immutable bytes under a fixed absolute private root with atomic publication, private permissions, traversal/symlink rejection, bounded reads and integrity verification. Browser filenames and project/source IDs never become filesystem paths. The sanitized [authoring-foundation](tests/spikes/h1-authoring-foundation/acceptance.json), [object-storage](tests/spikes/object-storage/acceptance.json), [source-intake](tests/spikes/provider-source-intake/acceptance.json) and [provider-authoring](tests/spikes/provider-authoring/acceptance.json) manifests distinguish this local synthetic evidence from deployment/object-service proof.

Commercial publication, project-scoped participant activation, dynamic client review/mutations and project-record exports have separate sanitized evidence in [publication foundation](tests/spikes/publication-foundation/acceptance.json), [provider publication](tests/spikes/provider-publication/acceptance.json), [provider participants](tests/spikes/provider-participants/acceptance.json), [dynamic review](tests/spikes/dynamic-client-review/acceptance.json), [records export](tests/spikes/records-export/acceptance.json), and [provider records](tests/spikes/provider-records/acceptance.json).

Custom payment, provider reconciliation and admitted-source analysis evidence is recorded in [custom payment](tests/spikes/custom-payment/acceptance.json), [provider reconciliation](tests/spikes/provider-reconciliation/acceptance.json), and [provider source analysis](tests/spikes/provider-source-analysis/acceptance.json).

Participant revoke/restore, private drafts, correction reissue and financial-exception evidence is recorded in [participant lifecycle](tests/spikes/participant-lifecycle/acceptance.json), [client drafts](tests/spikes/client-drafts/acceptance.json), [correction reissue](tests/spikes/correction-reissue/acceptance.json), and [payment exceptions](tests/spikes/payment-exceptions/acceptance.json).

Stop only the owned container with `npm run dev:db:stop`; the persistent volume is retained. The [acceptance manifest](tests/spikes/demo-db/acceptance.json) records the current read-only integration boundary.

### Independent local analysis validation

```sh
npm run test:analysis
```

This is the deterministic, local portion of IP-04: already-extracted immutable text, exact Unicode spans and quoted values, declared budgets, explicit permissions, and complete attributed coverage manifests. See [the module boundaries](packages/analysis/README.md).

Its local suite has **104 passing cases**. Validated pointers are not semantic, legal, pricing, or source-authenticity certification.

`@scopeledger/parser-adapter` now inspects PDF signatures and extracts text in a separate bounded child process. It enforces 10 MB/50-page limits, returns complete Unicode page ranges, inherits no application secrets and seals output into the immutable source contract without granting model permission. The [parser acceptance manifest](tests/spikes/parser/acceptance.json) remains process-isolation evidence, not a hardened OS sandbox or OCR proof.

### Google Gemini analysis adapter

Gemini is the selected model provider. `@scopeledger/gemini-adapter` checks the existing source-permission and admission gates before dispatch, sends no tools or financial capabilities, requests strict JSON-schema output and revalidates every exact Unicode source pointer locally. Model output remains human-review-required and publication-blocked.

Configure the server-only auth key locally:

```sh
# Fill GEMINI_API_KEY in .env.local.
npm run check:gemini-config
npm run check:gemini-auth
npm run test:gemini:local
```

The selected model is `gemini-3.5-flash-lite`. Never expose the auth key to the browser or commit it.

An authenticated four-class synthetic scorecard now covers included work, genuine additions, missing-context correction and unresolved ambiguity. All four outputs passed strict local schema/evidence reconstruction and remained human-review-required and publication-blocked. The sanitized [partial acceptance manifest](tests/spikes/gemini/acceptance.json) is mechanical evidence only; human semantic scoring and repeat-run stability remain outstanding.

The integrated `npm run analysis:golden` proof now generates a synthetic PDF, extracts it in the bounded parser child, seals immutable source provenance/permissions, calls authenticated Gemini and validates balanced exact evidence. Its [acceptance manifest](tests/spikes/analysis-pipeline/acceptance.json) records one supporting and one charge-weakening pointer with publication still blocked.

**IP-04/SP-06 are not complete.** PDF signature inspection and bounded child-process text extraction now exist, and authenticated Gemini calls have mechanical scorecard evidence. Stronger parser egress isolation, hostile-PDF evaluation, image-only OCR, human semantic scoring, repeat-run variance and approved real-document processing terms remain unproved. No fabricated provider results are included.

Package and spike documentation records the public implementation boundaries and observed evidence. Private product-planning records are intentionally excluded from the repository for now.

## Prototype boundaries

- All records remain synthetic. Protected providers can create projects/requests, admit private sources, confirm a baseline, save immutable drafts, prepare commercial terms and publish exact custom units without changing fixtures or code.
- Source context, historical terms, acknowledgment controls, decision previews, local channel verification, protected provider authoring/analysis/operations/records, private source intake, dynamic client review and printing/exports are interactive.
- A verified local client approver can preview and record approve/decline, durable corrections and communication-only questions against both seeded and custom reviews. A separately activated and verified local payer can complete exact custom-unit Checkout/capture/reconciliation through opaque locators. No browser-provided payment identity or amount is trusted, and model output is never authority.
- `/provider/reconciliation` records attributed question responses and correction assessments without silently clearing holds. `/provider/source-analysis` analyzes exact admitted PDF/text/Markdown bytes under stored permissions, persists human-review-required runs/reviews, and grants no downstream commercial authority.
- `/provider/participants` explicitly revokes/restores approver or payer authority under fresh epochs without rewriting history or suppressing admitted recovery. Dynamic client question/correction drafts can be saved, recovered and deleted privately before explicit submission.
- `/provider/payment-exceptions` treats verified refund/reversal events as triggers for authoritative reads, preserves original capture/agreement facts and withholds readiness through financial holds without recollection or manual overrides.
- `/provider/financial-audit` reports bounded safe aggregates for known capture freshness and webhook health. The one-shot CLI is suitable for cron, never redispatches capture, and exits nonzero for unresolved operational failure.
- The notification worker delivers only to configured reserved local Mailpit recipients. Delivery outcomes never change agreement, payment, readiness, work start or correction state.
- `/provider/operations` keeps readiness and actual work start separate. A verified-email/MFA provider with the current synthetic product grant may record actual start only after the server locks and rechecks readiness and holds; the completed demo remains intentionally `not recorded`.
- Client message drafts live only in page memory and are lost on refresh before submission. Provider authoring revisions are persisted as immutable server records. Use synthetic text only.
- Question and source fields each allow 10,000 Unicode code points. Longer input is preserved with a validation error, not silently truncated; previewing is blocked until it is corrected.
- The static client preview can still render without external configuration. Connected identity, database, model, email and payment capabilities require the corresponding ignored local environment.
- Browser previews and automated checks do not establish WCAG conformance or production readiness.

The protected `/provider/analysis` route now accepts one attested PDF, runs isolated extraction and optionally prepares authenticated Gemini candidates. PostgreSQL persists immutable source/run evidence and append-only provider review dispositions; candidates remain exact-evidence-linked, human-review-required and publication-blocked. A real authenticated synthetic PDF was parsed through Next.js, saved, reviewed, and observed again after reload. The parser worker emits as ESM (`.mjs`) so Next's CommonJS output boundary cannot mask a child-process syntax failure as a PDF error.

## Provider/staff identity

Auth0 is the selected provider/staff identity boundary. It supplies OIDC login, encrypted application sessions, logout/recovery integration and MFA assurance. Client approvers and payers are not required to hold Auth0 accounts; the local demo uses separate scoped Mailpit verification, while external delivery, recovery and deployed grants remain future IP-03 work.

Without Auth0 configuration, `/provider` fails closed with an unavailable state while the synthetic client-review page remains usable. Once configured, provider access requires both verified email and an MFA method/ACR claim; authentication alone does not grant product permissions.

If the tenant does not emit a standard `amr`/`acr` MFA claim, add a Post-Login Action that enforces the OTP challenge and sets the namespaced ID-token claim `https://github.com/kimttfung/scopeledger/claims/mfa`. Auth0 SDK v4 filters custom claims by default, so ScopeLedger's `beforeSessionSaved` hook copies only `amr`, `acr` and that boolean claim from the already verified ID token into the encrypted session.

```sh
# Fill the Auth0 values in .env.local.
npm run prepare:auth0-secret
npm run check:auth0-config
npm run test:auth0:local
```

For local development, configure Auth0 with:

- Allowed Callback URL: `http://127.0.0.1:3000/auth/callback`
- Allowed Logout URL: `http://127.0.0.1:3000`
- Allowed Web Origin: `http://127.0.0.1:3000`

## Local client/payer email capture

The demo uses a pinned Mailpit container instead of an external email provider. SMTP and the inbox UI bind only to loopback, and messages never leave the computer.

```sh
npm run mailpit:start
npm run mailpit:status
npm run email:demo
```

Open <http://127.0.0.1:8025> to inspect captured invitation and verification messages. Stop only the owned local service with `npm run mailpit:stop`.

This proves local email composition and SMTP handoff, not internet delivery, sender reputation, bounce webhooks or public evaluator access.

One real local SMTP delivery has been captured in Mailpit using a six-digit client verification message. The sanitized [partial acceptance manifest](tests/spikes/email/acceptance.json) records no code or recipient identity beyond the reserved `scopeledger.test` fixture.

Mailpit's rendered HTML tab uses a `srcdoc` iframe that can appear blank in the Copilot Browser surface even though the MIME HTML is present. Newly sent access codes therefore include a **Preview rendered email** link to ScopeLedger's `/email-preview/[id]` route. That route validates the local sender/recipient/message boundary, sanitizes a small HTML allowlist and disables links; Mailpit remains the source/headers/text/raw inspector.

The `/access-demo` journey now issues short-lived client-approver or payer codes, verifies them through same-origin APIs, and stores a 30-minute HttpOnly signed role session without the recipient address. The real local client flow survived reload; its [partial acceptance manifest](tests/spikes/access/acceptance.json) still distinguishes channel control from authority, consent and payment permission.

An authenticated sandbox login has completed through Universal Login, OTP and the protected provider route. The SDK session hook persisted only the approved assurance claims, and the page continued to separate authenticated identity from server-side product grants. The sanitized [partial acceptance manifest](tests/spikes/auth0/acceptance.json) omits all identity values, tokens and credentials.

Private planning records remain the authority for unreleased product policy. This public UI and its local proofs do not establish production readiness or launch permission.
