# Protected provider analysis UI spike

The `/provider/analysis` route requires an Auth0 session with verified email and MFA assurance. One PDF may be processed only after a synthetic/permitted-content attestation; Gemini processing requires a separate explicit opt-in.

The server controls workspace/project/source/run identity and permissions. Browser fields cannot provide authority, pricing, payment, merchant or publication state. Successful parser-only, candidate, and safe model-failure paths are persisted atomically in the fixed local synthetic demo scope. Persistence failure returns an explicit no-success response.

Verified providers can list only their own latest runs and append immutable `accept`, `edit`, `reject`, or `manual` review notes bound to the exact run/candidate digests. Parser-only fallback remains available, model/provider failures retain parser results, and every candidate stays human-review-required and publication-blocked.
