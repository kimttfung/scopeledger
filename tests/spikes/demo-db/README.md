# Persistent local review-state spike

The local demo PostgreSQL service uses the same pinned PostgreSQL 17 image and protocol migration as the transaction proof, but retains an owned Docker volume across container restarts.

The seed script creates the Cedar Roastery workflow through ordinary domain commands:

1. baseline and source registration;
2. packet and Unit U1;
3. version 1 at USD 450;
4. admitted client correction;
5. provider response;
6. version 2 at USD 300 with the identified reconciliation reference.

The browser receives only a no-store read projection. It cannot mutate decisions, holds, payment state or readiness.

Run:

```sh
npm run prepare:dev-db
npm run dev:db:start
npm run dev:db:migrate
npm run seed:demo
npm run dev
```

Stopping the container retains the owned volume. No reset/delete command is provided.
