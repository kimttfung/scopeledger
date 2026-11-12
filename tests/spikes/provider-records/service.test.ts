import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderRecordsLocatorCodec,
  listProviderRecordProjects,
  loadProviderProjectRecord,
  type ProviderRecordTarget,
  type ProviderRecordsDependencies,
} from "../../../apps/web/app/api/provider/records/service.js";
import { projectExport } from "./fixtures.js";

const codec = new ProviderRecordsLocatorCodec("ab".repeat(32));
const target = Object.freeze({
  workspaceId: "workspace-private",
  projectId: "project-private",
  displayName: "Cedar Roastery website",
  grantEpoch: 4,
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

test("verified provider assurance and the product grant are both required", async () => {
  let grantChecked = false;
  let projectsRead = false;
  const unauthenticated = await listProviderRecordProjects(dependencies({
    verifyProvider: async () => ({
      ok: false,
      status: 401,
      code: "AUTHENTICATION_REQUIRED",
    }),
    verifyProductGrant: async () => {
      grantChecked = true;
      return true;
    },
    listAuthorizedProjects: async () => {
      projectsRead = true;
      return [target];
    },
  }));
  assert.deepEqual(unauthenticated, {
    ok: false,
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
  });
  assert.equal(grantChecked, false);
  assert.equal(projectsRead, false);

  const noProductGrant = await listProviderRecordProjects(dependencies({
    verifyProductGrant: async () => false,
    listAuthorizedProjects: async () => {
      projectsRead = true;
      return [target];
    },
  }));
  assert.deepEqual(noProductGrant, {
    ok: false,
    status: 403,
    code: "PROVIDER_GRANT_REQUIRED",
  });
  assert.equal(projectsRead, false);
});

test("project selectors are opaque and listings expose only safe display names", async () => {
  const privateTarget = {
    ...target,
    displayName:
      "owner@example.test s3://private-bucket/project.pdf api_key=secret-value",
  };
  const result = await listProviderRecordProjects(dependencies({
    listAuthorizedProjects: async () => [privateTarget],
  }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.projects.length, 1);
  const [project] = result.projects;
  assert.ok(project);
  assert.match(project.projectLocator, /^slr1h_[A-Za-z0-9_-]{43}$/u);
  assert.equal(project.projectLocator.includes(target.workspaceId), false);
  assert.equal(project.projectLocator.includes(target.projectId), false);
  assert.match(project.displayName, /^Project record · [A-Z0-9_-]{8}$/u);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /owner@example|private-bucket|secret-value/);
  assert.doesNotMatch(serialized, /workspace-private|project-private/);
  assert.equal(Object.hasOwn(result, "total"), false);
});

test("cross-project and malformed selectors stop before project export", async () => {
  let exported = false;
  const malformed = await loadProviderProjectRecord(
    "project-private",
    dependencies({
      verifyProvider: async () => {
        throw new Error("must not authenticate malformed locators");
      },
    }),
  );
  assert.deepEqual(malformed, {
    ok: false,
    status: 404,
    code: "RECORD_NOT_AVAILABLE",
  });

  const otherLocator = codec.project({
    workspaceId: target.workspaceId,
    projectId: "other-private-project",
  });
  const crossProject = await loadProviderProjectRecord(
    otherLocator,
    dependencies({
      exportProject: async () => {
        exported = true;
        return projectExport;
      },
    }),
  );
  assert.deepEqual(crossProject, {
    ok: false,
    status: 404,
    code: "RECORD_NOT_AVAILABLE",
  });
  assert.equal(exported, false);
});

test("the exact project grant is rechecked after export assembly", async () => {
  let grantChecks = 0;
  const result = await loadProviderProjectRecord(
    codec.project(target),
    dependencies({
      verifyProductGrant: async () => {
        grantChecks += 1;
        return true;
      },
      isProjectGrantCurrent: async (candidate) => {
        assert.deepEqual(candidate, target);
        return false;
      },
    }),
  );
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    code: "PROVIDER_GRANT_REQUIRED",
  });
  assert.equal(grantChecks, 2);
});

test("one authorized opaque selector exports only its server-scoped target", async () => {
  let admitted: ProviderRecordTarget | null = null;
  const result = await loadProviderProjectRecord(
    codec.project(target),
    dependencies({
      exportProject: async (candidate) => {
        admitted = candidate;
        return projectExport;
      },
    }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(admitted, target);
  if (!result.ok) return;
  assert.equal(result.project.displayName, target.displayName);
  assert.equal(result.exported.document.project.displayName, "Cedar Roastery website");
});
