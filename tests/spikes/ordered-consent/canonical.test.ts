import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, decimalMoney, freezePublishedUnit, minorUnits, ProtocolError, sha256 } from "@scopeledger/contracts";
import { snapshot } from "./support/fixture.js";

test("canonical v1 has deterministic UTF-8 bytes and SHA-256 independent of object insertion order", () => {
  const unit = snapshot();
  const reversed = Object.fromEntries(Object.entries(unit).reverse());
  const original = freezePublishedUnit(unit);
  assert.deepEqual(freezePublishedUnit(reversed).bytes, original.bytes);
  assert.equal(original.digest, sha256(original.bytes));
  assert.equal(original.bytes.toString("utf8"), canonicalJson(unit));
  assert.equal(canonicalJson({ "\u00e9": "x", z: "y", A: "z" }), '{"A":"z","z":"y","é":"x"}');
});

test("canonical identity preserves array order, rationale, whitespace and Unicode rather than normalizing", () => {
  const original = snapshot({ scope: ["A", "B"], rationale: "Café\n exact " });
  const digest = freezePublishedUnit(original).digest;
  for (const change of [
    { scope: ["B", "A"] }, { rationale: "Café\nexact" }, { rationale: "Cafe\u0301\n exact " },
    { rationale: "Material rationale changed without price change" },
  ]) assert.notEqual(freezePublishedUnit({ ...original, ...change }).digest, digest);
  assert.equal(original.rationale, "Café\n exact ");
  assert.equal(freezePublishedUnit(snapshot({ rationale: "😀".repeat(10_000) })).snapshot.rationale, "😀".repeat(10_000));
  assert.throws(() => freezePublishedUnit(snapshot({ rationale: "😀".repeat(10_001) })), ProtocolError);
});

test("money uses bounded exact BigInt arithmetic including exclusive and inclusive tax declarations", () => {
  assert.equal(minorUnits("9999999999.99"), 999_999_999_999n);
  assert.equal(decimalMoney(30n), "0.30");
  assert.equal(minorUnits("0.10") + minorUnits("0.20"), minorUnits("0.30"));
  const original = snapshot();
  assert.equal(original.treatment, "payable");
  if (original.treatment !== "payable") assert.fail();
  const financial = original.payment.financial;
  const exclusive = { ...financial, subtotal: "0.30", gross: "0.33",
    lines: [{ id: "x", description: "Exact quantity", quantity: "3", unitPrice: "0.10", amount: "0.30" }],
    tax: { treatment: "exclusive", amount: "0.03", declaration: "Explicitly declared, not tax-engine calculated" } };
  freezePublishedUnit({ ...original, payment: { policy: "full-prepayment", financial: exclusive } });
  freezePublishedUnit({ ...original, payment: { policy: "full-prepayment", financial: { ...exclusive, gross: "0.30", tax: { ...exclusive.tax, treatment: "inclusive" } } } });
  for (const invalid of ["NaN", "Infinity", "01.00", "-1.00", "1.0", "1e2", "10000000000.00", 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => minorUnits(invalid as string), ProtocolError);
  }
  for (const financialChange of [
    { gross: "0.32" }, { subtotal: "0.31" }, { tax: { treatment: "none", amount: "0.03", declaration: "Invalid" } },
    { lines: [{ id: "x", description: "Unsafe multiplication", quantity: "999999", unitPrice: "9999999999.99", amount: "9999999999.99" }] },
    { tax: { treatment: "inclusive", amount: "1.00", declaration: "Tax exceeds subtotal" }, gross: "0.30" },
  ]) assert.throws(() => freezePublishedUnit({ ...original, payment: { policy: "full-prepayment", financial: { ...exclusive, ...financialChange } } }), ProtocolError);
});

test("strict runtime validation rejects unknown/unsafe/non-JSON/unsupported approval data", () => {
  const sparse = Array(2);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const decorated: unknown[] = [];
  Object.defineProperty(decorated, "unexpected", { value: true });
  let deep: unknown = {};
  for (let depth = 0; depth < 66; depth += 1) deep = { nested: deep };
  for (const value of [undefined, NaN, Infinity, -0, 0.1, 2n, new Date(), sparse, decorated, deep, cycle, { x: undefined }, { x: "\ud800" }]) {
    assert.throws(() => canonicalJson(value), ProtocolError);
  }
  for (const update of [
    { unknownField: true }, { treatment: "included" }, { treatment: "needs-clarification" },
    { version: 0 }, { rationale: "" }, { rationale: "\udfff" }, { scope: [] },
    { version: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => freezePublishedUnit({ ...snapshot(), ...update }), ProtocolError);
  const waived = snapshot({
    treatment: "additional-waived", payment: { policy: "not-required", explanation: "Explicit new-scope courtesy" },
    financialEffect: { kind: "no-obligation" },
  });
  assert.equal(waived.treatment, "additional-waived");
  assert.throws(() => freezePublishedUnit({ ...waived, payment: snapshot().payment }), ProtocolError);
});
