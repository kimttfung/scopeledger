import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePath =
  "apps/web/app/provider/source-analysis/source-analysis-workspace.tsx";
const pagePath = "apps/web/app/provider/source-analysis/page.tsx";

test("admitted-source UI has no second upload and keeps permission authority server-side", async () => {
  const [workspace, page] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(pagePath, "utf8"),
  ]);
  assert.doesNotMatch(workspace, /type=["']file["']|FormData/u);
  assert.match(workspace, /\/api\/provider\/source-analysis/u);
  assert.match(workspace, /stored model permission/u);
  assert.match(workspace, /browser cannot grant either/u);
  assert.match(workspace, /No downstream authority/u);
  assert.match(workspace, /publication blocked/u);
  assert.match(page, /Verified email and MFA assurance are required/u);
  assert.match(page, /\/provider\/analysis/u);
});
