# Isolated PDF parser spike

The parser validates PDF signatures and size before starting a bounded child process. The child receives only a temporary read-only input path, minimal non-secret environment, a 256 MB heap ceiling and a timeout.

The current proof covers:

- valid multi-page text extraction;
- complete contiguous Unicode page ranges;
- malformed file rejection;
- exact 10 MB and 50-page limits;
- removal of temporary files after success/failure;
- sealing output into the immutable extracted-source contract without granting model permission.

The child process is meaningful isolation from application memory/secrets, but it is not OS/container egress denial. A malicious corpus and stronger sandbox remain required before real private-document processing.
