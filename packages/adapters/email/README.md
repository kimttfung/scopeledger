# Local email adapter

Private ESM package `@scopeledger/email-adapter`. It sends invitation links and six-digit client/payer verification codes only to an owned local Mailpit inbox.

The adapter:

- accepts only loopback SMTP and `@scopeledger.test` recipients;
- uses one stable UUID message identity;
- emits no credentials, source excerpts or payment details;
- distinguishes client/payer verification from commercial approval;
- disables file and URL access in message rendering;
- reports delivery failure explicitly.

It does not provide internet delivery, sender-domain reputation, bounce webhooks, production identity assurance or public evaluator email. Replace it with an approved transactional provider before external use.
