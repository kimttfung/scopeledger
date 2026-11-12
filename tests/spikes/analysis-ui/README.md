# Protected provider analysis UI spike

The `/provider/analysis` route requires an Auth0 session with verified email and MFA assurance. One PDF may be processed only after a synthetic/permitted-content attestation; Gemini processing requires a separate explicit opt-in.

The server controls workspace/project/source identity and permissions. Browser fields cannot provide authority, pricing, payment, merchant or publication state. Parser-only fallback remains available, model/provider failures retain parser results, and every candidate stays human-review-required and publication-blocked.
