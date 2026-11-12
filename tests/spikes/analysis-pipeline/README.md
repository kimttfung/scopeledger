# Integrated synthetic analysis pipeline

The golden analysis command joins the implemented local boundaries:

1. generate a synthetic two-page PDF;
2. inspect and extract it in the bounded PDF child process;
3. seal immutable source identity, provenance and explicit permissions;
4. dispatch only admitted content to the configured Gemini model;
5. reconstruct model-selected exact span IDs into Unicode source pointers;
6. validate complete source coverage and keep publication blocked for human review.

Run with the ignored Gemini configuration:

```sh
npm run analysis:golden
```

No private/customer document, payment identifier or provider credential is included in the committed evidence.
