import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("custom return and cancel strip provider query identifiers before rendering", async () => {
  for (const path of [
    "apps/web/app/pay/[projectLocator]/[requestLocator]/[unitLocator]/[payerLocator]/return/page.tsx",
    "apps/web/app/pay/[projectLocator]/[requestLocator]/[unitLocator]/[payerLocator]/cancel/page.tsx",
  ]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /Object[.]keys\(await searchParams\)[.]length > 0/u);
    assert.equal(
      source.includes("redirect(`${payerPagePath(locators)}/"),
      true,
    );
    assert.doesNotMatch(source, /token|PayerID|orderId|captureId/u);
  }
});

test("browser return is non-financial and capture requires an explicit click", async () => {
  const source = await readFile(
    "apps/web/app/pay/[projectLocator]/[requestLocator]/[unitLocator]/[payerLocator]/payer-checkout.tsx",
    "utf8",
  );
  assert.match(source, /redirect is not financial proof/u);
  assert.match(source, /continuity === "return"/u);
  assert.match(source, /onClick=\{\(\) => void invoke\("capture"\)\}/u);
  assert.doesNotMatch(source, /useEffect[\s\S]{0,800}invoke\("capture"\)/u);
});
