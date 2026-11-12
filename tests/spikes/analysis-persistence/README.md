# Analysis persistence spike

These tests require `IP01_DATABASE_URL` and create isolated PostgreSQL schemas.
They verify migration `003`, immutable extracted source/run storage, safe
idempotency, user-scoped run listing, and append-only human review records.
They make no Gemini or other external provider calls.
