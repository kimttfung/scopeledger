# Isolated PDF parser adapter

Private ESM package `@scopeledger/parser-adapter`.

The adapter:

- checks for a PDF signature before dispatch;
- rejects files over 10 MB;
- extracts in a separate Node process with a 256 MB heap ceiling and bounded timeout/output;
- supplies no inherited credentials or application configuration to the child;
- disables PDF JavaScript evaluation, streaming, auto-fetch and worker fetch;
- rejects PDFs over 50 pages;
- returns complete contiguous Unicode page ranges and no hidden network fallback;
- removes its temporary directory after success or failure.

This is process isolation, not a hardened OS/container sandbox. Host-level egress denial, malicious corpus testing and parser dependency review remain required before real private-document processing.
