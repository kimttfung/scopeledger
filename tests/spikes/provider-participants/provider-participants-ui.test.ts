import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("provider authoring presents a separate preview and explicit bounded activation", async () => {
  const [panel, workspace, page] = await Promise.all([
    readFile(
      "apps/web/app/provider/authoring/participant-activation.tsx",
      "utf8",
    ),
    readFile(
      "apps/web/app/provider/authoring/authoring-workspace.tsx",
      "utf8",
    ),
    readFile("apps/web/app/provider/authoring/page.tsx", "utf8"),
  ]);
  assert.match(panel, /Preview local client authority/);
  assert.match(panel, /htmlFor="participant-activation-confirmation"/);
  assert.match(panel, /Activate local client approver/);
  assert.match(panel, /Local channel verification remains separate/);
  assert.match(panel, /No payer nomination or payment permission/);
  assert.match(panel, /No rewrite of prior actors, decisions, or publication history/);
  assert.match(panel, /No authority for any other project/);
  assert.match(panel, /credentials: "same-origin"/);
  assert.match(panel, /JSON\.stringify\(\{\s*confirmationLocator:/);
  assert.doesNotMatch(
    panel,
    /JSON\.stringify\(\{[^}]*actorId|JSON\.stringify\(\{[^}]*grantEpoch|JSON\.stringify\(\{[^}]*nominationEpoch|JSON\.stringify\(\{[^}]*commandId/s,
  );
  assert.match(panel, /href="\/access-demo"/);
  assert.match(workspace, /ParticipantActivation/);
  assert.match(page, /explicitly activate its local client approver/);
});
