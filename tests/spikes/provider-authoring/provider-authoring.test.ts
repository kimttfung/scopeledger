import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  handleDraftsGet,
  handleDraftsPost,
  handleProjectsGet,
  handleProjectsPost,
  handleRequestsPost,
  type AuthoringDependencies,
  type AuthoringDraft,
} from "../../../apps/web/app/api/provider/authoring/service.js";
import {
  formatProviderSourceLocator,
} from "../../../apps/web/app/api/provider/sources/service.js";

const project = {
  projectId: "project-one",
  displayName: "Cedar refresh",
  createdAt: "2026-11-12T06:00:00.000Z",
} as const;
const requestRecord = {
  projectId: project.projectId,
  requestId: "request-one",
  title: "Homepage scope",
  createdAt: "2026-11-12T06:01:00.000Z",
} as const;
const draft: AuthoringDraft = {
  projectId: project.projectId,
  requestId: requestRecord.requestId,
  unitId: "unit-one",
  revision: 1,
  state: "in-progress",
  title: "Homepage implementation",
  summary: "First exact draft.",
  scope: ["Implement the approved homepage."],
  exclusions: [],
  sourceReferences: [],
  draftReference: "AAAAAAAAAAAA",
  createdAt: "2026-11-12T06:02:00.000Z",
};

function dependencies(
  overrides: Partial<AuthoringDependencies> = {},
): AuthoringDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true }),
    authorize: async () => true,
    listProjects: async () => [project],
    createProject: async () => project,
    listRequests: async () => [requestRecord],
    createRequest: async () => requestRecord,
    listDrafts: async () => [draft],
    resolveSourceLocators: async () => [],
    createDraft: async () => draft,
    ...overrides,
  };
}

function post(url: string, body: object): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:3000",
      host: "127.0.0.1:3000",
    },
    body: JSON.stringify(body),
  });
}

async function body(response: Response): Promise<unknown> {
  return response.json();
}

test("authentication is required before protected authoring data is read", async () => {
  let listed = false;
  let authorized = false;
  const response = await handleProjectsGet(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    }),
    authorize: async () => {
      authorized = true;
      return true;
    },
    listProjects: async () => {
      listed = true;
      return [];
    },
  }));

  assert.equal(response.status, 401);
  assert.equal(authorized, false);
  assert.equal(listed, false);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "AUTHENTICATION_REQUIRED",
    message: "Sign in before accessing provider authoring.",
  });
});

test("verified identity does not replace the synthetic provider product grant", async () => {
  let listed = false;
  const response = await handleProjectsGet(dependencies({
    authorize: async () => false,
    listProjects: async () => {
      listed = true;
      return [];
    },
  }));

  assert.equal(response.status, 403);
  assert.equal(listed, false);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "PROVIDER_GRANT_REQUIRED",
    message: "The protected demo provider grant is not active.",
  });
});

test("cross-origin project creation stops before authentication and persistence", async () => {
  let verified = false;
  let created = false;
  const response = await handleProjectsPost(
    post("http://127.0.0.1:3000/api/provider/authoring/projects", {
      displayName: "Cedar refresh",
    }),
    dependencies({
      requireSameOrigin: () => {
        throw new Error("SAME_ORIGIN_REQUIRED");
      },
      verifyProvider: async () => {
        verified = true;
        return { ok: true };
      },
      createProject: async () => {
        created = true;
        return project;
      },
    }),
  );

  assert.equal(response.status, 403);
  assert.equal(verified, false);
  assert.equal(created, false);
});

test("the browser can supply a bounded display name but not project authority", async () => {
  let admitted: unknown = null;
  const rejected = await handleProjectsPost(
    post("http://127.0.0.1:3000/api/provider/authoring/projects", {
      displayName: "Cedar refresh",
      workspaceId: "browser-workspace",
      createdBy: "browser-provider",
    }),
    dependencies(),
  );
  assert.equal(rejected.status, 422);

  const accepted = await handleProjectsPost(
    post("http://127.0.0.1:3000/api/provider/authoring/projects", {
      displayName: "Cedar refresh",
    }),
    dependencies({
      createProject: async (input) => {
        admitted = input;
        return project;
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(admitted, { displayName: "Cedar refresh" });
});

test("request creation treats the project path as a scoped locator and owns identity", async () => {
  let admitted: unknown = null;
  const response = await handleRequestsPost(
    post("http://127.0.0.1:3000/api/provider/authoring/projects/project-one/requests", {
      title: "Homepage scope",
    }),
    project.projectId,
    dependencies({
      createRequest: async (input) => {
        admitted = input;
        return requestRecord;
      },
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(admitted, {
    projectId: project.projectId,
    title: "Homepage scope",
  });
});

test("draft creation admits content only and cannot accept revision or publication state", async () => {
  let admitted: unknown = null;
  const url = "http://127.0.0.1:3000/api/provider/authoring/projects/project-one/requests/request-one/drafts/unit-one";
  const rejected = await handleDraftsPost(
    post(url, {
      title: "Homepage implementation",
      summary: "Next exact draft.",
      scope: ["Implement the approved homepage."],
      exclusions: [],
      revision: 99,
      state: "ready-for-client-review",
      authoredBy: "browser-provider",
      sourceReferences: [{ sourceId: "browser-source", version: 1 }],
    }),
    project.projectId,
    requestRecord.requestId,
    draft.unitId,
    dependencies(),
  );
  assert.equal(rejected.status, 422);

  const accepted = await handleDraftsPost(
    post(url, {
      title: "Homepage implementation",
      summary: "Next exact draft.",
      scope: ["Implement the approved homepage."],
      exclusions: ["No additional pages."],
    }),
    project.projectId,
    requestRecord.requestId,
    draft.unitId,
    dependencies({
      createDraft: async (input) => {
        admitted = input;
        return { ...draft, revision: 2, summary: input.summary };
      },
    }),
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(admitted, {
    projectId: project.projectId,
    requestId: requestRecord.requestId,
    unitId: draft.unitId,
    title: "Homepage implementation",
    summary: "Next exact draft.",
    scope: ["Implement the approved homepage."],
    exclusions: ["No additional pages."],
    sourceReferences: [],
  });
});

test("selected locators are re-read into ordered immutable source references", async () => {
  const locators = [
    formatProviderSourceLocator({
      sourceId: `source_${"1".repeat(32)}_${"a".repeat(48)}`,
      version: 1,
    }),
    formatProviderSourceLocator({
      sourceId: `source_${"1".repeat(32)}_${"b".repeat(48)}`,
      version: 2,
    }),
  ];
  const references = [
    { sourceId: `source_${"1".repeat(32)}_${"a".repeat(48)}`, version: 1 },
    { sourceId: `source_${"1".repeat(32)}_${"b".repeat(48)}`, version: 2 },
  ];
  let resolved: unknown = null;
  let admitted: unknown = null;
  const response = await handleDraftsPost(
    post("http://127.0.0.1:3000/api/provider/authoring/projects/project-one/requests/request-one/drafts", {
      title: "Homepage implementation",
      summary: "Source-backed draft.",
      scope: ["Implement the approved homepage."],
      exclusions: [],
      sourceLocators: locators,
    }),
    project.projectId,
    requestRecord.requestId,
    null,
    dependencies({
      resolveSourceLocators: async (input) => {
        resolved = input;
        return references;
      },
      createDraft: async (input) => {
        admitted = input;
        return {
          ...draft,
          sourceReferences: references.map((source) => ({
            locator: formatProviderSourceLocator(source),
            displayReference: `SRC-${source.sourceId.slice(-8).toUpperCase()} · v${source.version}`,
            version: source.version,
          })),
        };
      },
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(resolved, {
    projectId: project.projectId,
    requestId: requestRecord.requestId,
    locators,
  });
  assert.deepEqual(
    (admitted as { sourceReferences: unknown }).sourceReferences,
    references,
  );
});

test("cross-project and stale source selections fail before draft persistence", async () => {
  for (const [code, message] of [
    [
      "SOURCE_SCOPE_MISMATCH",
      "A selected source does not belong to this exact project request.",
    ],
    [
      "STALE_SOURCE_SELECTION",
      "A selected source is no longer admitted here. Refresh the source list.",
    ],
  ] as const) {
    let created = false;
    const response = await handleDraftsPost(
      post("http://127.0.0.1:3000/api/provider/authoring/projects/project-one/requests/request-one/drafts", {
        title: "Homepage implementation",
        summary: "Source-backed draft.",
        scope: ["Implement the approved homepage."],
        exclusions: [],
        sourceLocators: [
          formatProviderSourceLocator({
            sourceId: `source_${"1".repeat(32)}_${"a".repeat(48)}`,
            version: 1,
          }),
        ],
      }),
      project.projectId,
      requestRecord.requestId,
      null,
      dependencies({
        resolveSourceLocators: async () => {
          throw Object.assign(new Error(code), { code });
        },
        createDraft: async () => {
          created = true;
          return draft;
        },
      }),
    );

    assert.equal(response.status, 409);
    assert.equal(created, false);
    assert.deepEqual(await body(response), {
      ok: false,
      code,
      message,
    });
  }
});

test("draft retrieval returns immutable revision history with no-store headers", async () => {
  const response = await handleDraftsGet(
    project.projectId,
    requestRecord.requestId,
    dependencies(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await body(response), {
    ok: true,
    drafts: [draft],
  });
});

test("authoring UI exposes labeled source intake while publication stays unavailable", async () => {
  const [page, workspace, provider] = await Promise.all([
    readFile("apps/web/app/provider/authoring/page.tsx", "utf8"),
    readFile("apps/web/app/provider/authoring/authoring-workspace.tsx", "utf8"),
    readFile("apps/web/app/provider/page.tsx", "utf8"),
  ]);

  assert.match(page, /Publication is not available/);
  assert.match(page, /Authentication alone does not grant product authority/);
  assert.match(workspace, /Synthetic or explicitly permitted material only/);
  assert.match(workspace, /htmlFor="source-file"/);
  assert.match(workspace, /htmlFor="provenance-origin"/);
  assert.match(workspace, /htmlFor="studio-sharing"/);
  assert.match(workspace, /htmlFor="model-processing"/);
  assert.match(workspace, /htmlFor="model-review-status"/);
  assert.match(workspace, /htmlFor="content-attestation"/);
  assert.match(workspace, /Upload and admit source/);
  assert.match(workspace, /sourceLocators: selectedSourceLocators/);
  assert.match(workspace, /immutable revision history/i);
  assert.doesNotMatch(workspace, /Publish draft/);
  assert.match(provider, /\/provider\/authoring/);
});
