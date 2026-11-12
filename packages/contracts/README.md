# Published-unit contracts

Private ESM package `@scopeledger/contracts`. Build with `npm run build --workspace @scopeledger/contracts`; exports are `dist/index.js` and `dist/index.d.ts`.

## Product role

These contracts are the commercial-boundary layer for ScopeLedger's human-authorized agent. They preserve the exact version, rationale, human authority condition, and financial basis that AI may help prepare but cannot create or approve. Canonical snapshots make the responsibility chain inspectable: suggestions and evidence can inform a provider-reviewed proposal; only an exact human decision can create an obligation; only a verified payment observation can establish a financial fact.

No-payment outcomes remain first-class. Included work is not an approval unit, waived additions use an explicit no-obligation financial effect, and uncertain work cannot be smuggled into a payable snapshot.

## Public surface

- `publishedUnitSchema`, `PublishedUnit`, `PayableUnit`: strict, versioned payable/additional-waived snapshots. Included and uncertain work are deliberately not approval units.
- `freezePublishedUnit(unknown)`: runtime validation, a recursively frozen parsed snapshot, deterministic UTF-8 bytes and SHA-256 digest. The returned byte buffer belongs to the caller; persist it unchanged.
- `canonicalJson`, `sha256`: canonical operation/command identity. Object keys sort by ECMAScript code units (not locale); arrays, whitespace and Unicode scalar sequences retain their identity. No `toJSON`, normalization, floating-point money, undefined, sparse arrays, accessors, cycles or unbounded nesting.
- `minorUnits`, `decimalMoney`: exact BigInt conversion, USD scale 2, maximum `9999999999.99`. Positive line totals equal unit price × integer quantity; subtotal, explicit inclusive/exclusive/no-tax declaration and gross must agree. These checks are arithmetic, not tax advice or a tax engine.
- `actorSchema`, `payerSchema`, `leaseSchema`, `observationSchema` and their types: runtime boundary contracts.
- `ProtocolError`: safe stable codes and bounded field/resource references; no credentials or source payload logging.

Snapshots bind workspace/project/client/unit/version, named approver and nomination epoch, baseline/source versions, scope/exclusions/dependencies, rationale, timing, prerequisites and payment/financial effect. Text limits count Unicode code points; valid text is never silently normalized or truncated.

Canonical versions are `scopeledger.published-unit.v1` and `scopeledger.canonical-json.v1`. Changing serialization or commercial semantics requires an explicit new schema version. Never regenerate an old stored hash from edited/redacted content. Retention/erasure and certified electronic signatures are not implemented or proved here.

An `authenticated-adapter` observation label is an **internal trust contract**, not an authentication implementation. A browser, model or unverified callback must never call the financial-result boundary. Ordinary local fault observations use the explicit `synthetic-fault` variant. Additional locally injected adapter-schema regression fixtures are explicitly labeled as such; none prove actual retrieval/authentication or provider behavior.

`identifier` is bounded opaque ASCII text, not an assertion that the architecture's future internal-entity UUID policy has been implemented everywhere. Readable deterministic synthetic names and provider-owned reference strings are allowed for this proof; no identity, grant, anonymity or secrecy is inferred from them. Actual command/attempt/operation identities are UUIDs. Future production entity provisioning should use generated UUIDs (already valid strings in this contract), with any database tightening handled as a reviewed migration rather than editing/re-hashing historical canonical records.
