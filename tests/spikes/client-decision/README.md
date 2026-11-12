# Protected client decision spike

The seeded review can record one exact terminal approve/decline decision only when:

- the browser request is same-origin;
- an unexpired signed local session has the `client-approver` role;
- both response-review and authority assertions are explicit;
- the server re-reads the current version and digest from PostgreSQL;
- the identified correction response is acknowledged atomically.

Approval creates the obligation but never starts PayPal or records payment. Payer sessions, browser-supplied identity/version/digest and stale/duplicate actions fail closed.
