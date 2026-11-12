# Local extracted-source validation

**IP-04 local validation foundation only; actual parser isolation, file inspection,
model/provider quality/permissions and held-out scorecard experiments remain unproved.**
This does not complete IP-04 or SP-06 and does not change the synthetic UI.

Private ESM package `@scopeledger/analysis` builds to `dist/index.js` and
`dist/index.d.ts`. Run the repository's `npm run test:analysis` after the parent
installs the declared workspace dependencies.
Tests also typecheck independently with
`node_modules/.bin/tsc --project tests/spikes/analysis/tsconfig.json`.

## Product role

This package supports the investigative part of ScopeLedger's human-authorized agent. It may validate extracted text, exact pointers, declared coverage, permissions, and structured candidate evidence. It does not decide whether work is billable, select commercial terms, create consent, or authorize payment. Its results should be presented as **AI suggested** or **source pointer validated**, followed by an explicit **provider reviewed** outcome.

Balanced evidence and manual fallback support fair outcomes with or without payment. A valid local result may still lead to included work, a courtesy, clarification, an informed decline, or a blocked publication.

## Boundaries and APIs

- `sealExtractedSourceVersion(unknown)` validates already-extracted source data,
  copies it, computes a SHA-256 text digest, and recursively freezes the snapshot.
  `parseExtractedSourceVersion(unknown)` checks a stored snapshot including its
  digest. This establishes local content identity, not source authenticity,
  database immutability, actual acceptance, legal precedence, or actor authority.
- `evaluateAutomatedAdmission(unknown)` checks **declared extracted records**:
  PDF bytes/pages, extraction coverage, project/workspace association, explicit
  studio-sharing and model permissions, and recorded model-input review. It does
  **not** inspect PDF bytes, detect actual types/unsafe content, extract text,
  detect financial identifiers, or approve processing settings. Uncleared or
  prohibited originals are blocked, not automatically redacted. A later permitted
  derivative needs its own immutable version and reviewed provenance.
- Local admission counts every supplied version, including amendments and prior
  decisions; no payment-state field exists. Exact selected defaults are
  10,000,000 bytes/50 pages per PDF, 100 PDF pages/200,000 code points per run,
  and 10,000 code points per request/correction. Combined text includes the request.
  Exceeding any limit preserves the entire inventory and text, reports
  `manual-required`, and requires a complete attributed manual manifest.
- `validateSourcePointer(pointer, run)` and `validateCandidateClaims(payload, run)`
  recheck local admission, exact source/version identity and half-open `[start,end)`
  **Unicode code-point** ranges against the original extracted text. No trimming,
  Unicode normalization, case folding, quote substitution, pointer repair or
  source lookup occurs. Malformed surrogate text is rejected. Paged PDF records
  account for every declared page, with contiguous ranges in extracted text and
  explicit unavailable pages. Partial/unavailable sources cannot enter automated
  candidate validation, even if a particular quote falls on a readable page.
- Strict candidate schemas bound claims, text and evidence; supporting and
  charge-weakening arrays and uncertainty are explicit. Unknown fields, including
  money, merchant, authority, consent, readiness and execution instructions, are
  rejected. Instructions inside quoted/source/interpretation **strings remain
  inert data**. Shape/pointer validation is not a semantic billing check. Valid
  candidates are always `human-review-required` and publication-blocked.
- Candidate coverage must name every admitted version. Empty counter-evidence
  arrays mean only `none-cited-in-admitted-sources`, not “none exists”; neither
  coverage claims nor pointer fidelity prove exhaustive semantic consideration.
- `evaluateCoverageManifest(manifest, inventory)` preserves every supplied source
  with an attributed reviewed, inapplicable, superseded or unresolved disposition.
  Supporting and weakening review are separate required confirmations.
  Supersession requires an explicit reviewed reason/reference, cannot cycle, and
  must terminate at a reviewed version; dates never imply supersession.
  Missing entries, material/unknown unresolved context, unreadable reviewed sources
  and disallowed studio sharing block the **local source-coverage** gate. A
  nonmaterial unresolved entry remains an explicit notice. Model permission is
  not required for attributed manual review. Above-limit records may pass this
  narrower completeness check without becoming eligible for automation.

All functions are synchronous and local: no file/network reads, hidden fetches,
providers, URLs followed, logging, financial/consent effects or fallback adapters.
`modelDispatch` is always `not-authorized-by-this-module`, even on local admission.
The host must supply a complete authorized inventory and current permissions,
enforce durable version immutability/stale-job fences, verify human authority,
and separately apply every publication and processing gate. These functions
cannot discover a source the host omitted.

## Safe results

`ValidationResult<T>` distinguishes invalid input (`ok: false`, fixed diagnostics)
from a successfully assessed record (`ok: true`) whose admission/coverage status
can still be blocked. Never treat `ok` alone as admission or publication approval.
Results are recursively frozen; public runtime schemas are also exported for
types/structured-output shape. Prefer function results to raw schema errors for
safe diagnostics: they never include source text, quoted values, unknown field
names or raw validation-library errors.

Provenance records are attestations, not measured provider/model evidence. No
model endpoint, parser, OCR, embeddings, integration orchestration, scorecard
result or production quality claim is included.
