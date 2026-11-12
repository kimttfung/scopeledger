# Local judging guide

ScopeLedger's judging profile is local, reproducible, synthetic and PostgreSQL-backed. The automated runner never performs a real PayPal create/capture/refund, Auth0 login, Gemini call or external email delivery.

## Fresh clone

Requirements: Node.js 26, npm 11, Docker, and Chromium for the full browser suite.

```sh
npm ci
cp .env.example .env.local
npm run prepare:dev-db
npm run prepare:access-secret
npm run prepare:auth0-secret
npm run prepare:object-storage
npm run prepare:judge-operations
npm run dev:db:start
npm run dev:db:migrate
npm run seed:demo
npm run mailpit:start
npx playwright install chromium
```

Start the application separately:

```sh
npm run dev
```

Open <http://127.0.0.1:3000>. Mailpit is available only on the local machine at <http://127.0.0.1:8025>.

## Acceptance runner

Run from a clean checkout:

```sh
npm run judge:acceptance:quick
npm run judge:acceptance:full
```

Quick verifies the local profile, migration chain, PostgreSQL, Mailpit, private object root, build/typecheck/lint, core zero-skip suites, and localhost routes when the development server is running.

Full adds the documented local protocol, authoring/publication, dynamic review, payment-contract fakes, analysis, draft/lifecycle/reissue/exception, notification/evaluator/audit, records, and isolated production-browser suites.

Reports are written to ignored `.scopeledger-local/evidence/` JSON files and printed to stdout. A custom report path must remain under that directory:

```sh
npm run judge:acceptance:quick -- \
  --output .scopeledger-local/evidence/judge-quick.json
```

`--allow-dirty` is only for an intentional local inspection; a clean checkout is the judging baseline.

## Suggested judge flow

1. Review the quick JSON report and its evidence-manifest paths.
2. Open `/`, `/access-demo`, and Mailpit.
3. Use Mailpit-captured `@scopeledger.test` messages to exercise local client-approver or payer verification.
4. With Auth0 configured, open `/provider/authoring`, add a permitted synthetic source, create a draft, prepare commercial terms, publish, and follow the generated opaque review link.
5. Record a correction or exact decision. Approval creates an obligation only; it does not create or capture a PayPal Order.
6. Review provider reconciliation, source analysis, records, financial audit, and work-start surfaces.
7. Run the full acceptance profile.

Use synthetic documents and identities only.

## Optional manual provider setup

These steps are deliberately outside the automated runner.

### Auth0

Create a Regular Web Application, using:

- Callback: `http://127.0.0.1:3000/auth/callback`
- Logout return and web origin: `http://127.0.0.1:3000`

Put only the tenant hostname and local application values in ignored `.env.local`. Require verified email and OTP MFA. The Post-Login Action must use `challengeWithAny([{ type: "otp" }])` and set `https://github.com/kimttfung/scopeledger/claims/mfa` to `true`. Then run:

```sh
npm run check:auth0-config
```

Opening `/provider` starts the manual login/MFA flow. Authentication alone never grants product authority.

### PayPal Sandbox

Use one Sandbox Business merchant application and a separate Personal buyer. Keep both identities and all secrets outside the repository. Fill only the sandbox fields in `.env.local`, then run:

```sh
npm run check:paypal-config
npm run check:paypal-auth
```

The following is an optional manual sandbox financial-effect exercise and is not part of automated judging:

```sh
npm run paypal:sandbox:create
# Approve only in PayPal’s hosted Sandbox with the Personal buyer.
npm run paypal:sandbox:capture
```

For the durable ordered-consent sandbox exercise instead:

```sh
npm run ip02:create
# Approve only in PayPal’s hosted Sandbox with the Personal buyer.
npm run ip02:capture
npm run ip02:status
npm run ip02:cleanup
```

Do not use live credentials. Live webhook registration is not required for the local judging path.

### Gemini

Create a restricted Gemini API key, keep it in ignored `.env.local`, retain the documented model, and run:

```sh
npm run check:gemini-config
npm run check:gemini-auth
```

The authentication check is a manual provider call. Product analysis still requires explicit model permission, provider opt-in, exact local pointer validation, and human review.

### Mailpit

Mailpit captures all development email locally. The configured sender and recipients must remain under `scopeledger.test`; no message leaves the machine. Use its inbox or the application’s sanitized local preview.

## Cleanup

```sh
npm run mailpit:stop
npm run dev:db:stop
```

The PostgreSQL data volume is intentionally retained. After preserving any desired report, ignored `.scopeledger-local/`, `.env.local`, and the generated `apps/web/.env.local` link may be removed.

## Not required for local judging

- VoiceOver/NVDA or formal WCAG conformance evidence.
- Temporary or persistent public webhook registration.
- Actual PayPal refund or reversal execution.

The codebase includes automated keyboard/reflow checks, webhook tooling, and contract-tested refund/reversal handling. Those foundations remain available for later release and production-readiness work, but the judging submission must not claim the manual evidence was completed.

## Known boundaries

- Local judging evidence is not production certification.
- Automated acceptance uses provider contract fakes, not real PayPal/Auth0/Gemini operations.
- Actual provider refund/reversal evidence is not claimed; exception handling uses authenticated read/reconciliation contracts.
- Email is local Mailpit only.
- Browser acceptance disables Auth0 and the demo database and uses synthetic fixtures.
- Formal accessibility conformance, stable deployed webhook ingress, high availability, backup/restore proof, production retention, and legal or semantic suitability remain unavailable.

## Troubleshooting

- **Dirty-tree failure:** restore a clean checkout, or use `--allow-dirty` only when the changes are intentional.
- **Database/Mailpit unavailable:** run `npm run dev:db:status` and `npm run mailpit:status`; start Docker first.
- **Object-root failure:** rerun `npm run prepare:object-storage`; the root must remain private and non-symlinked.
- **Migration failure:** run `npm run dev:db:migrate` and do not renumber or skip migrations.
- **Browser failure:** install Chromium with `npx playwright install chromium`.
- **Output-path failure:** write only below `.scopeledger-local/evidence/`.
- **Command failure:** rerun the public command named in the JSON report; raw errors are intentionally excluded from the report.
