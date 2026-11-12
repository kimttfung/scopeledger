# Local email-capture spike

ScopeLedger uses an owned local Mailpit container for the demonstration instead of an external transactional email provider.

The service:

- runs from a pinned official image;
- binds SMTP and the inbox UI only to loopback;
- stores at most 100 disposable local messages without host mounts;
- accepts only `@scopeledger.test` recipients from the local adapter;
- captures invitation links and client/payer verification codes without internet delivery.

Run:

```sh
npm run mailpit:start
npm run email:demo
```

Inspect the inbox at <http://127.0.0.1:8025>. Stop it with `npm run mailpit:stop`.

This evidence does not establish sender-domain ownership, internet deliverability, bounce/complaint handling, external recipient privacy or public evaluator access.
