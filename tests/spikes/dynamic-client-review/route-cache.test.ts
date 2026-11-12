import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  handleReviewGet,
  privateReviewHeaders,
  ReviewLocatorCodec,
  type ReviewDependencies,
} from "../../../apps/web/app/api/review/service.js";
import {
  locatorSecret,
  reviewFixture,
} from "./fixtures.js";

const codec = new ReviewLocatorCodec(locatorSecret);
const locators = {
  projectLocator: codec.project("workspace-one", "project-one"),
  requestLocator: codec.request(
    "workspace-one",
    "project-one",
    "request-one",
  ),
  unitLocator: codec.unit(
    "workspace-one",
    "project-one",
    "request-one",
    "unit-one",
  ),
};

function dependencies(
  overrides: Partial<ReviewDependencies> = {},
): ReviewDependencies {
  return {
    readSession: async () => ({
      role: "client-approver",
      subject: "a".repeat(64),
    }),
    loadReview: async () => reviewFixture,
    ...overrides,
  };
}

test("prefetch requests are rejected before protected access or data reads", async () => {
  let sessionRead = false;
  let reviewRead = false;
  const response = await handleReviewGet(
    new Request("http://127.0.0.1/api/review/x/y/z", {
      headers: { "Next-Router-Prefetch": "1" },
    }),
    locators,
    dependencies({
      readSession: async () => {
        sessionRead = true;
        return null;
      },
      loadReview: async () => {
        reviewRead = true;
        return reviewFixture;
      },
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    code: "REVIEW_PREFETCH_REJECTED",
  });
  assert.equal(sessionRead, false);
  assert.equal(reviewRead, false);
});

test("every API response is private, no-store, non-indexable, and cookie-varying", async () => {
  const response = await handleReviewGet(
    new Request("http://127.0.0.1/api/review/x/y/z"),
    locators,
    dependencies(),
  );
  assert.equal(response.status, 200);
  for (const [name, value] of Object.entries(privateReviewHeaders)) {
    assert.equal(response.headers.get(name), value);
  }
});

test("the route is dynamic GET and same-path POST mutation wiring", async () => {
  const source = await readFile(
    "apps/web/app/api/review/[projectLocator]/[requestLocator]/[unitLocator]/route.ts",
    "utf8",
  );
  assert.match(source, /export const dynamic = "force-dynamic"/);
  assert.match(source, /export const revalidate = 0/);
  assert.match(source, /export async function GET/);
  assert.match(source, /export async function POST/);
  assert.match(source, /handleReviewMutationPost/);
  assert.doesNotMatch(source, /export async function (PUT|PATCH|DELETE)/);
});
