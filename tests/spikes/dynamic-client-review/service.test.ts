import assert from "node:assert/strict";
import test from "node:test";
import {
  loadScopedReview,
  ReviewLoadError,
  ReviewLocatorCodec,
  validReviewLocators,
  type ReviewDependencies,
  type ReviewLocators,
} from "../../../apps/web/app/api/review/service.js";
import {
  locatorSecret,
  reviewFixture,
} from "./fixtures.js";

const codec = new ReviewLocatorCodec(locatorSecret);
const locators: ReviewLocators = {
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

test("review locators are opaque, typed, and bounded", () => {
  assert.equal(validReviewLocators(locators), true);
  assert.equal(locators.projectLocator.includes("project-one"), false);
  assert.equal(locators.requestLocator.includes("request-one"), false);
  assert.equal(locators.unitLocator.includes("unit-one"), false);
  assert.equal(locators.projectLocator.length, 49);
  assert.equal(locators.requestLocator.length, 49);
  assert.equal(locators.unitLocator.length, 49);
  assert.equal(codec.matchesProject(
    locators.projectLocator,
    "workspace-one",
    "project-one",
  ), true);
  assert.equal(codec.matchesRequest(
    locators.requestLocator,
    "workspace-one",
    "other-project",
    "request-one",
  ), false);
  assert.equal(codec.matchesUnit(
    locators.unitLocator,
    "workspace-one",
    "project-one",
    "other-request",
    "unit-one",
  ), false);
  const mutationLocator = codec.mutationUnit(
    "workspace-one",
    "project-one",
    "request-one",
    "unit-one",
    2,
    "a".repeat(64),
  );
  assert.equal(mutationLocator.includes("unit-one"), false);
  assert.notEqual(mutationLocator, locators.unitLocator);
  assert.equal(codec.matchesMutationUnit(
    mutationLocator,
    "workspace-one",
    "project-one",
    "request-one",
    "unit-one",
    2,
    "a".repeat(64),
  ), true);
  assert.equal(codec.matchesMutationUnit(
    mutationLocator,
    "workspace-one",
    "project-one",
    "request-one",
    "unit-one",
    3,
    "b".repeat(64),
  ), false);
  assert.equal(validReviewLocators({
    ...locators,
    unitLocator: `${locators.unitLocator}extra`,
  }), false);
});

test("malformed locators stop before session or database access", async () => {
  let sessionRead = false;
  let reviewRead = false;
  const result = await loadScopedReview({
    ...locators,
    projectLocator: "project-one",
  }, dependencies({
    readSession: async () => {
      sessionRead = true;
      return null;
    },
    loadReview: async () => {
      reviewRead = true;
      return reviewFixture;
    },
  }));
  assert.deepEqual(result, {
    ok: false,
    status: 404,
    code: "REVIEW_NOT_AVAILABLE",
  });
  assert.equal(sessionRead, false);
  assert.equal(reviewRead, false);
});

test("verified client-approver access is required before review data loads", async () => {
  let reviewRead = false;
  const missing = await loadScopedReview(locators, dependencies({
    readSession: async () => null,
    loadReview: async () => {
      reviewRead = true;
      return reviewFixture;
    },
  }));
  assert.deepEqual(missing, {
    ok: false,
    status: 401,
    code: "CLIENT_ACCESS_REQUIRED",
  });
  assert.equal(reviewRead, false);

  const payer = await loadScopedReview(locators, dependencies({
    readSession: async () => ({
      role: "payer",
      subject: "b".repeat(64),
    }),
    loadReview: async () => {
      reviewRead = true;
      return reviewFixture;
    },
  }));
  assert.deepEqual(payer, {
    ok: false,
    status: 403,
    code: "CLIENT_APPROVER_REQUIRED",
  });
  assert.equal(reviewRead, false);
});

test("wrong actor, inactive grants, and cross-project locators fail closed", async () => {
  const denied = await loadScopedReview(locators, dependencies({
    loadReview: async () => {
      throw new ReviewLoadError("ACCESS_DENIED");
    },
  }));
  assert.deepEqual(denied, {
    ok: false,
    status: 403,
    code: "REVIEW_NOT_AUTHORIZED",
  });

  const unknown = await loadScopedReview(locators, dependencies({
    loadReview: async () => {
      throw new ReviewLoadError("NOT_FOUND");
    },
  }));
  assert.deepEqual(unknown, {
    ok: false,
    status: 404,
    code: "REVIEW_NOT_AVAILABLE",
  });
});

test("stale and malformed canonical snapshots never render", async () => {
  for (const code of ["STALE_RECORD", "MALFORMED_RECORD"] as const) {
    const result = await loadScopedReview(locators, dependencies({
      loadReview: async () => {
        throw new ReviewLoadError(code);
      },
    }));
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      code: "REVIEW_STATE_CHANGED",
    });
  }
});

test("the successful service returns only the server-owned projection", async () => {
  let admitted: unknown = null;
  const result = await loadScopedReview(locators, dependencies({
    loadReview: async (resolvedLocators, session) => {
      admitted = { resolvedLocators, session };
      return reviewFixture;
    },
  }));
  assert.deepEqual(result, {
    ok: true,
    review: reviewFixture,
  });
  assert.deepEqual(admitted, {
    resolvedLocators: locators,
    session: {
      role: "client-approver",
      subject: "a".repeat(64),
    },
  });
});
