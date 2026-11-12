# Gemini analysis adapter

Private ESM package `@scopeledger/gemini-adapter`. It is the selected model-provider boundary for completing IP-04.

The adapter:

- checks the existing extracted-run schema and local automated-admission gate before any network call;
- sends only explicitly permitted extracted commercial text and request text;
- uses the fixed Google Generative Language API origin and a server-only Gemini auth key;
- requests strict JSON structured output with no tools or financial actions;
- treats source text as untrusted data, not instructions;
- validates the returned candidate schema and every exact Unicode source pointer locally;
- returns only human-review-required, publication-blocked candidate evidence;
- never grants pricing, tax, merchant, authority, consent, payment or readiness capabilities.

Injected transports are labeled `synthetic-contract`; only the built-in network transport can report `authenticated-api`. No source text, API key or raw provider error payload is logged.

This package does not select commercial meaning, complete parser isolation, prove model quality, authorize real-document processing or satisfy IP-04/SP-06 by itself.
