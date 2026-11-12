import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("participant register uses protected preview and explicit confirmation", async () => {
  const [page, register, styles] = await Promise.all([
    readFile("apps/web/app/provider/participants/page.tsx", "utf8"),
    readFile(
      "apps/web/app/provider/participants/participant-register.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/participants/participants.module.css",
      "utf8",
    ),
  ]);
  assert.match(page, /Participant authority register/);
  assert.match(page, /Every preview and confirmation/);
  assert.match(register, /<dialog/);
  assert.match(register, /Prospective effect/);
  assert.match(register, /Preserved records and boundaries/);
  assert.match(register, /Reissue required/);
  assert.match(register, /already-admitted capture operation/);
  assert.match(register, /htmlFor="participant-lifecycle-confirmation"/);
  assert.match(register, /credentials: "same-origin"/);
  assert.match(register, /selector: participant\.selector/);
  assert.match(register, /confirmationLocator: preview\.confirmationLocator/);
  assert.doesNotMatch(
    register,
    /JSON\.stringify\(\{[^}]*actorId|JSON\.stringify\(\{[^}]*grantEpoch|JSON\.stringify\(\{[^}]*nominationEpoch|JSON\.stringify\(\{[^}]*projectId|JSON\.stringify\(\{[^}]*obligationId/s,
  );
  assert.match(styles, /min-width: 44px/);
  assert.match(styles, /@media \(max-width: 480px\)/);
  assert.match(styles, /dialog::backdrop/);
});
