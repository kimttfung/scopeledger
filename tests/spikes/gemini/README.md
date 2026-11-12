# Gemini structured-output spike

This workspace contains deterministic adapter-contract tests and sanitized authenticated evidence for the selected Google Gemini model.

The adapter admits only source runs that pass the existing permission, coverage and budget checks. It supplies deterministic exact span IDs, requests strict structured JSON, reconstructs exact Unicode pointers locally and passes the result through the existing candidate/pointer validator. Source text cannot grant tool or commercial authority.

Run local contract checks with:

```sh
npm run test:gemini:local
```

With an ignored local auth key:

```sh
npm run check:gemini-auth
npm run gemini:scorecard
```

The scorecard uses synthetic sources only. Mechanical acceptance proves schema, evidence polarity, exact pointer reconstruction, complete admitted-source inventory and mandatory human-review blocking. It is not human semantic scoring, user research, real-document permission or production-quality evidence.
