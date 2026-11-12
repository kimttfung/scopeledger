# ScopeLedger

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

IP-02 remains incomplete until the same provider behavior is exercised through durable ordered-consent dispatch, real duplicate/reordering/invalid-event cases, lost-response recovery, refund reads and same-attempt authorization recovery.

`@scopeledger/payment-worker` now connects the domain dispatch callback to the PayPal adapter. It stores a validated approval link only after the domain has recorded the provider observation; capture operations never create a link. Its local file store is a private spike boundary, not the final database-backed application worker.

One additional fresh USD 1.00 flow has now run through an owned real-PostgreSQL database, exact agreement/payer commands, durable create and capture intents, worker lease admission, the PayPal adapter and authenticated observation reduction. The original attempt resumed after buyer approval and the domain derived `ready`; no fixture or browser callback set that state.

Webhook capture reconciliation now re-fetches `/v2/payments/captures/{id}`, validates merchant/Order/currency/gross, resolves exactly one admitted capture operation and applies the ordinary domain observation reducer. Duplicate or reordered notifications therefore cannot supply their own financial truth. Refund retrieval is implemented as a fixed-origin read of `/v2/payments/refunds/{id}` with validated parent-capture linkage; it cannot initiate a refund or rewrite the original payment.

## Local backend proofs

| Workspace | Responsibility |
| --- | --- |
| `packages/contracts` | Validated published-unit contracts and canonical fingerprints. |
| `packages/db` | PostgreSQL schema/migration and typed persistence boundary. |
| `packages/domain` | Ordered consent, correction, and financial-intent commands. |
| `packages/analysis` | Local extracted-source, Unicode-pointer, budget, and coverage validation only. |
| `packages/adapters/gemini` | Permission-gated Gemini structured-output candidates with local exact-pointer validation. |
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

The verified IP-01 suite has **56 passing cases, zero skipped**, including both commit orders for the required races, authoritative capture-to-operation reconciliation and six actual SIGKILL/readback boundaries. Its versioned [acceptance manifest](tests/spikes/ordered-consent/acceptance.json) distinguishes local PostgreSQL/fault evidence from unproved provider and release gates. See the [proof inventory](tests/spikes/ordered-consent/README.md) and [domain API boundaries](packages/domain/README.md).

Production migration targets must be explicitly created dedicated schemas. Protected or missing namespaces and namespace-changing connection-URL options fail closed. Transactions reset their schema locally rather than trusting a previous pooled session's `search_path`.

### Independent local analysis validation

```sh
npm run test:analysis
```

This is the deterministic, local portion of IP-04: already-extracted immutable text, exact Unicode spans and quoted values, declared budgets, explicit permissions, and complete attributed coverage manifests. See [the module boundaries](packages/analysis/README.md).

Its local suite has **104 passing cases**. Validated pointers are not semantic, legal, pricing, or source-authenticity certification.

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

**IP-04/SP-06 are not complete.** Actual file-type inspection, PDF extraction/parser isolation, authenticated Gemini calls, held-out quality measurements and approved data-processing terms remain unproved. No fabricated provider results are included. IP-03 likewise requires selected, authorized identity/email configurations before its actual experiments can run.

Package and spike documentation records the public implementation boundaries and observed evidence. Private product-planning records are intentionally excluded from the repository for now.

## Prototype boundaries

- All studio, client, source, scope, and price records are the synthetic fixture defined in the UX specification.
- Source context, historical terms, acknowledgment controls, decision previews, question/correction previews, and printing are interactive.
- No button records consent, submits a concern, resolves a hold, verifies identity, invokes a model, or initiates payment. Decision dialogs explain hypothetical outcomes without changing the displayed commercial facts.
- Form drafts live only in page memory. They are not saved to a server and are lost on refresh. Use synthetic text only.
- Question and source fields each allow 10,000 Unicode code points. Longer input is preserved with a validation error, not silently truncated; previewing is blocked until it is corrected.
- No credentials, external service configuration, database, or environment file is required.
- Browser previews and automated checks do not establish WCAG conformance or production readiness.

## Provider/staff identity

Auth0 is the selected provider/staff identity boundary. It supplies OIDC login, encrypted application sessions, logout/recovery integration and MFA assurance. Client approvers and payers are not required to hold Auth0 accounts; their separate scoped verification remains future IP-03 work.

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

The `/access-demo` journey now issues short-lived client-approver or payer codes, verifies them through same-origin APIs, and stores a 30-minute HttpOnly signed role session without the recipient address. The real local client flow survived reload; its [partial acceptance manifest](tests/spikes/access/acceptance.json) still distinguishes channel control from authority, consent and payment permission.

An authenticated sandbox login has completed through Universal Login, OTP and the protected provider route. The SDK session hook persisted only the approved assurance claims, and the page continued to separate authenticated identity from server-side product grants. The sanitized [partial acceptance manifest](tests/spikes/auth0/acceptance.json) omits all identity values, tokens and credentials.

Private planning records remain the authority for unreleased product policy. This public UI and its local proofs do not establish production readiness or launch permission.
