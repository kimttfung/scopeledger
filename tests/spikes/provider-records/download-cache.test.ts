import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ProviderRecordsLocatorCodec,
  handleProviderRecordDownload,
  handleProviderRecordsListGet,
  privateProviderRecordsHeaders,
  type ProviderRecordTarget,
  type ProviderRecordsDependencies,
} from "../../../apps/web/app/api/provider/records/service.js";
import { projectExport } from "./fixtures.js";

const codec = new ProviderRecordsLocatorCodec("cd".repeat(32));
const target = Object.freeze({
  workspaceId: "workspace-download",
  projectId: "project-download",
  displayName: "Download project",
  grantEpoch: 2,
}) satisfies ProviderRecordTarget;

function dependencies(
  overrides: Partial<ProviderRecordsDependencies> = {},
): ProviderRecordsDependencies {
  return {
    verifyProvider: async () => ({ ok: true }),
    verifyProductGrant: async () => true,
    listAuthorizedProjects: async () => [target],
    isProjectGrantCurrent: async () => true,
    exportProject: async () => projectExport,
    locatorCodec: codec,
    ...overrides,
  };
}

function assertPrivate(response: Response) {
  for (const [name, value] of Object.entries(privateProviderRecordsHeaders)) {
    assert.equal(response.headers.get(name), value);
  }
}

test("list responses are private no-store and contain no inaccessible totals", async () => {
  const response = await handleProviderRecordsListGet(
    new Request("http://127.0.0.1/api/provider/records"),
    dependencies(),
  );
  assert.equal(response.status, 200);
  assertPrivate(response);
  const body = await response.text();
  assert.doesNotMatch(body, /workspace-download|project-download/);
  assert.doesNotMatch(body, /total|inaccessible/i);
});

test("prefetch is rejected before authentication, grants, or record reads", async () => {
  let touched = false;
  const response = await handleProviderRecordsListGet(
    new Request("http://127.0.0.1/api/provider/records", {
      headers: { "Next-Router-Prefetch": "1" },
    }),
    dependencies({
      verifyProvider: async () => {
        touched = true;
        return { ok: true };
      },
    }),
  );
  assert.equal(response.status, 403);
  assertPrivate(response);
  assert.equal(touched, false);
});

test("JSON and HTML downloads use explicit safe attachment headers", async () => {
  const locator = codec.project(target);
  const json = await handleProviderRecordDownload(
    new Request(`http://127.0.0.1/api/provider/records/${locator}/json`),
    locator,
    "json",
    dependencies(),
  );
  assert.equal(json.status, 200);
  assertPrivate(json);
  assert.equal(
    json.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.match(
    json.headers.get("content-disposition") ?? "",
    /^attachment; filename="scopeledger-project-record-[a-z0-9_-]{12}\.json"$/u,
  );
  assert.equal(await json.text(), projectExport.json);

  const html = await handleProviderRecordDownload(
    new Request(`http://127.0.0.1/api/provider/records/${locator}/html`),
    locator,
    "html",
    dependencies(),
  );
  assert.equal(html.status, 200);
  assertPrivate(html);
  assert.equal(
    html.headers.get("content-type"),
    "text/html; charset=utf-8",
  );
  assert.match(
    html.headers.get("content-disposition") ?? "",
    /^attachment; filename="scopeledger-project-record-[a-z0-9_-]{12}\.html"$/u,
  );
  assert.match(
    html.headers.get("content-security-policy") ?? "",
    /default-src 'none'/u,
  );
  assert.equal(await html.text(), projectExport.html);
});

test("download routes are dynamic GET-only no-store wiring", async () => {
  for (const path of [
    "apps/web/app/api/provider/records/route.ts",
    "apps/web/app/api/provider/records/[projectLocator]/json/route.ts",
    "apps/web/app/api/provider/records/[projectLocator]/html/route.ts",
  ]) {
    const source = await readFile(path, "utf8");
    assert.match(source, /export const dynamic = "force-dynamic"/u);
    assert.match(source, /export const fetchCache = "force-no-store"/u);
    assert.match(source, /export const revalidate = 0/u);
    assert.match(source, /export async function GET/u);
    assert.doesNotMatch(source, /export async function (POST|PUT|PATCH|DELETE)/u);
  }
});
