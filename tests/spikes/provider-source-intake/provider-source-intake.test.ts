import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  SourceIntakeInput,
  SourceIntakeRecord,
} from "@scopeledger/db";
import type {
  PutSourceObjectInput,
  PutSourceObjectResult,
} from "@scopeledger/object-storage-adapter";
import {
  handleProviderSourcePost,
  handleProviderSourcesGet,
  MAX_SOURCE_MULTIPART_BYTES,
  formatProviderSourceLocator,
  providerSourceScopePrefix,
  type ProviderSourceDependencies,
  type ProviderSourceTarget,
  validateProviderSourceHeaders,
} from "../../../apps/web/app/api/provider/sources/service.js";

const fixedTime = new Date("2026-11-12T07:15:00.000Z");
const subjectDigest = "a".repeat(64);
const sourceLimits = Object.freeze({
  maximumCount: 5,
  admittedCount: 0,
  remainingCount: 5,
  maximumBytes: 25_000_000,
  admittedBytes: 0,
  remainingBytes: 25_000_000,
  windowMinutes: 60,
  blocked: false,
});
const target: ProviderSourceTarget = {
  workspaceId: "demo-workspace",
  projectId: "cedar-roastery",
  requestId: "packet-review",
  providerActorId: "northstar-provider",
  grantAction: "publish",
  grantEpoch: 1,
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function form(
  overrides: Readonly<Record<string, string>> = {},
  file = new File(
    [new TextEncoder().encode("%PDF-1.7\nsynthetic source")],
    "scope.pdf",
    { type: "application/pdf" },
  ),
): FormData {
  const data = new FormData();
  data.set("file", file);
  data.set("projectRequestLocator", "cedar-roastery/packet-review");
  data.set("provenanceOrigin", "agreement");
  data.set("originReference", "Signed agreement, section 4");
  data.set("contentAttestation", "provider-permitted-source");
  data.set(
    "acceptanceBasis",
    "The provider confirmed this source may be imported for authoring.",
  );
  data.set("studioSharing", "permitted");
  data.set("modelProcessing", "denied");
  data.set("modelInputReviewStatus", "not-reviewed");
  data.set(
    "modelReviewBasis",
    "No model processing permission was granted.",
  );
  for (const [name, value] of Object.entries(overrides)) {
    data.set(name, value);
  }
  return data;
}

function request(
  data = form(),
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(
    "http://127.0.0.1:3000/api/provider/sources",
    {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
        "content-length": "2048",
        ...headers,
      },
      body: data,
    },
  );
}

function storedResult(input: PutSourceObjectInput): PutSourceObjectResult {
  const contentDigest = digest(input.bytes);
  return {
    schemaVersion: 1,
    objectId: `sha256:${contentDigest}`,
    byteLength: input.bytes.byteLength,
    binding: input.metadata.binding,
    browserFilename: input.metadata.browserFilename ?? null,
    mediaType: input.metadata.mediaType ?? null,
    storedAt: fixedTime.toISOString(),
    created: true,
  };
}

function intakeRecord(input: SourceIntakeInput): SourceIntakeRecord {
  const review = input.permissions.modelInputReview;
  return {
    ...input,
    permissions: {
      ...input.permissions,
      modelInputReview: review.status === "cleared"
        ? {
          ...review,
          reviewedAt: review.reviewedAt instanceof Date
            ? review.reviewedAt
            : new Date(review.reviewedAt),
        }
        : review,
    },
    recordedAt: fixedTime,
    recordDigest: "b".repeat(64),
  };
}

function dependencies(
  overrides: Partial<ProviderSourceDependencies> = {},
): ProviderSourceDependencies {
  return {
    requireSameOrigin: () => undefined,
    verifyProvider: async () => ({ ok: true, subjectDigest }),
    resolveTarget: (locator) =>
      locator === "cedar-roastery/packet-review" ? target : null,
    authorizeTarget: async () => "authorized",
    listSourceIntake: async () => [],
    putSourceObject: async (input) => storedResult(input),
    persistSourceIntake: async (input) => ({
      duplicate: false,
      source: intakeRecord(input),
    }),
    readSourceLimits: async () => sourceLimits,
    admitSourceUpload: async (_input, work) => ({
      value: await work(),
      state: sourceLimits,
    }),
    now: () => new Date(fixedTime),
    ...overrides,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function get(
  query = "projectId=cedar-roastery&requestId=packet-review",
): Request {
  return new Request(
    `http://127.0.0.1:3000/api/provider/sources?${query}`,
    {
      headers: { accept: "application/json" },
    },
  );
}

test("same-origin rejection happens before authentication and upload handling", async () => {
  let authenticated = false;
  let stored = false;
  const response = await handleProviderSourcePost(request(), dependencies({
    requireSameOrigin: () => {
      throw new Error("SAME_ORIGIN_REQUIRED");
    },
    verifyProvider: async () => {
      authenticated = true;
      return { ok: true, subjectDigest };
    },
    putSourceObject: async (input) => {
      stored = true;
      return storedResult(input);
    },
  }));

  assert.equal(response.status, 403);
  assert.equal(authenticated, false);
  assert.equal(stored, false);
  assert.equal((await body(response)).code, "SAME_ORIGIN_REQUIRED");
});

test("verified email, MFA, and authentication are required before source intake", async () => {
  for (const access of [
    {
      ok: false as const,
      status: 401 as const,
      code: "AUTHENTICATION_REQUIRED" as const,
    },
    {
      ok: false as const,
      status: 403 as const,
      code: "PROVIDER_ASSURANCE_REQUIRED" as const,
    },
    {
      ok: false as const,
      status: 503 as const,
      code: "AUTHENTICATION_UNAVAILABLE" as const,
    },
  ]) {
    let stored = false;
    const response = await handleProviderSourcePost(request(), dependencies({
      verifyProvider: async () => access,
      putSourceObject: async (input) => {
        stored = true;
        return storedResult(input);
      },
    }));
    assert.equal(response.status, access.status);
    assert.equal((await body(response)).code, access.code);
    assert.equal(stored, false);
  }
});

test("multipart content type and bounded content length fail closed", () => {
  const notMultipart = validateProviderSourceHeaders(new Headers({
    "content-type": "application/json",
    "content-length": "10",
  }));
  assert.deepEqual(notMultipart, {
    ok: false,
    status: 415,
    code: "MULTIPART_REQUIRED",
    message: "Upload one source using multipart form data.",
  });

  const missingLength = validateProviderSourceHeaders(new Headers({
    "content-type": "multipart/form-data; boundary=fixture",
  }));
  assert.equal(missingLength.ok, false);
  if (!missingLength.ok) assert.equal(missingLength.code, "CONTENT_LENGTH_REQUIRED");

  const oversized = validateProviderSourceHeaders(new Headers({
    "content-type": "multipart/form-data; boundary=fixture",
    "content-length": String(MAX_SOURCE_MULTIPART_BYTES + 1),
  }));
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "SOURCE_TOO_LARGE");
});

test("only the fixed media allowlist and validated bytes are admitted", async () => {
  let stored = false;
  const oversized = await handleProviderSourcePost(
    request(form({}, new File([
      new Uint8Array(10_000_001),
    ], "oversized.pdf", {
      type: "application/pdf",
    }))),
    dependencies({
      putSourceObject: async (input) => {
        stored = true;
        return storedResult(input);
      },
    }),
  );
  assert.equal(oversized.status, 413);
  assert.equal((await body(oversized)).code, "SOURCE_TOO_LARGE");
  assert.equal(stored, false);

  const unsupported = await handleProviderSourcePost(
    request(form({}, new File(["hello"], "source.html", {
      type: "text/html",
    }))),
    dependencies(),
  );
  assert.equal(unsupported.status, 415);
  assert.equal(
    (await body(unsupported)).code,
    "UNSUPPORTED_SOURCE_MEDIA_TYPE",
  );

  const fakePdf = await handleProviderSourcePost(
    request(form({}, new File(["not a pdf"], "source.pdf", {
      type: "application/pdf",
    }))),
    dependencies(),
  );
  assert.equal(fakePdf.status, 415);
  assert.equal((await body(fakePdf)).code, "INVALID_PDF_SOURCE");

  const invalidText = await handleProviderSourcePost(
    request(form({}, new File([
      new Uint8Array([0xc3, 0x28]),
    ], "source.txt", {
      type: "text/plain",
    }))),
    dependencies(),
  );
  assert.equal(invalidText.status, 415);
  assert.equal((await body(invalidText)).code, "INVALID_TEXT_SOURCE");

  const markdown = await handleProviderSourcePost(
    request(form({}, new File(["# Valid\n\nMarkdown."], "source.md", {
      type: "text/markdown",
    }))),
    dependencies(),
  );
  assert.equal(markdown.status, 201);
});

test("unknown locators and missing scoped requests never reach storage", async () => {
  let stored = false;
  const unknown = await handleProviderSourcePost(
    request(form({ projectRequestLocator: "other-project/request" })),
    dependencies({
      putSourceObject: async (input) => {
        stored = true;
        return storedResult(input);
      },
    }),
  );
  assert.equal(unknown.status, 404);
  assert.equal((await body(unknown)).code, "SOURCE_SCOPE_NOT_FOUND");
  assert.equal(stored, false);

  const missing = await handleProviderSourcePost(request(), dependencies({
    authorizeTarget: async () => "scope-not-found",
    putSourceObject: async (input) => {
      stored = true;
      return storedResult(input);
    },
  }));
  assert.equal(missing.status, 404);
  assert.equal(stored, false);
});

test("the synthetic provider product grant remains separate from Auth0 assurance", async () => {
  let stored = false;
  const response = await handleProviderSourcePost(request(), dependencies({
    authorizeTarget: async () => "grant-required",
    putSourceObject: async (input) => {
      stored = true;
      return storedResult(input);
    },
  }));

  assert.equal(response.status, 403);
  assert.equal((await body(response)).code, "PROVIDER_GRANT_REQUIRED");
  assert.equal(stored, false);
});

test("browser-owned source identity, actor, digest, or timestamps are rejected", async () => {
  const data = form();
  data.set("sourceId", "browser-source");
  data.set("actorId", "browser-actor");
  data.set("recordedAt", "2020-01-01T00:00:00.000Z");
  data.set("contentDigest", "c".repeat(64));
  let persisted = false;
  const response = await handleProviderSourcePost(request(data), dependencies({
    persistSourceIntake: async (input) => {
      persisted = true;
      return { duplicate: false, source: intakeRecord(input) };
    },
  }));

  assert.equal(response.status, 400);
  assert.equal((await body(response)).code, "UNEXPECTED_FORM_FIELD");
  assert.equal(persisted, false);
});

test("storage is sealed before matching Postgres intake metadata is admitted", async () => {
  const events: string[] = [];
  const storedInputs: PutSourceObjectInput[] = [];
  const persistedInputs: SourceIntakeInput[] = [];
  const response = await handleProviderSourcePost(request(), dependencies({
    authorizeTarget: async () => {
      events.push("authorize");
      return "authorized";
    },
    putSourceObject: async (input) => {
      events.push("storage");
      storedInputs.push(input);
      return storedResult(input);
    },
    persistSourceIntake: async (input) => {
      events.push("postgres");
      persistedInputs.push(input);
      return { duplicate: false, source: intakeRecord(input) };
    },
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    "authorize",
    "storage",
    "authorize",
    "postgres",
  ]);
  const storedInput = storedInputs[0];
  const persistedInput = persistedInputs[0];
  assert.ok(storedInput);
  assert.ok(persistedInput);
  assert.match(
    persistedInput.sourceId,
    /^source_[a-f0-9]{32}_[a-f0-9]{48}$/u,
  );
  assert.equal(persistedInput.version, 1);
  assert.equal(persistedInput.reviewedBy, "northstar-provider");
  assert.equal(persistedInput.provenance.suppliedBy, "northstar-provider");
  assert.equal(
    persistedInput.contentDigest,
    digest(storedInput.bytes),
  );
  assert.equal(persistedInput.declaredByteLength, storedInput.bytes.byteLength);
  assert.deepEqual(storedInput.metadata.binding, {
    workspaceId: "demo-workspace",
    projectId: "cedar-roastery",
    sourceId: persistedInput.sourceId,
    versionId: "1",
  });
  const responseBody = await body(response);
  assert.deepEqual(responseBody.effects, {
    modelDispatch: false,
    parserExecution: false,
    publication: false,
    agreement: false,
    payment: false,
    readiness: false,
    workStart: false,
  });
  assert.equal("sourceId" in (responseBody.source as object), false);
  assert.equal("contentDigest" in (responseBody.source as object), false);
  assert.match(
    String((responseBody.source as Record<string, unknown>).displayReference),
    /^SRC-[A-F0-9]{8} · v1$/u,
  );
});

test("listing returns only safe server-admitted source summaries for the request", async () => {
  const sourceId = `${providerSourceScopePrefix(target)}${"c".repeat(48)}`;
  const source = intakeRecord({
    workspaceId: target.workspaceId,
    projectId: target.projectId,
    sourceId,
    version: 1,
    availability: "available",
    reviewedBy: target.providerActorId,
    sourceKind: "provider-upload",
    mediaType: "text/markdown",
    originalName: "scope.md",
    declaredByteLength: 24,
    contentDigest: "d".repeat(64),
    provenance: {
      origin: "request",
      suppliedBy: target.providerActorId,
      originReference: "Client request email",
      acceptance: {
        kind: "provider-attested-import",
        basis: "Synthetic permitted fixture.",
      },
    },
    permissions: {
      studioSharing: "permitted",
      modelProcessing: "denied",
      modelInputReview: {
        status: "not-reviewed",
        basis: "No model permission.",
      },
    },
  });
  let action: ProviderSourceTarget["grantAction"] | null = null;
  const response = await handleProviderSourcesGet(get(), dependencies({
    resolveTarget: (locator, targetAction) => {
      action = targetAction;
      return locator === "cedar-roastery/packet-review"
        ? { ...target, grantAction: targetAction }
        : null;
    },
    listSourceIntake: async () => [source],
  }));

  assert.equal(response.status, 200);
  assert.equal(action, "inspect");
  const responseBody = await body(response);
  assert.deepEqual(responseBody.sources, [{
    locator: formatProviderSourceLocator({ sourceId, version: 1 }),
    displayReference: "SRC-CCCCCCCC · v1",
    originalName: "scope.md",
    mediaType: "text/markdown",
    byteLength: 24,
    provenanceOrigin: "request",
    originReference: "Client request email",
    studioSharing: "permitted",
    modelProcessing: "denied",
    modelInputReviewStatus: "not-reviewed",
    recordedAt: fixedTime.toISOString(),
  }]);
  const serialized = JSON.stringify(responseBody);
  assert.doesNotMatch(serialized, /"contentDigest"|"reviewedBy"|"suppliedBy"|"storage"/u);
});

test("cleared model permission uses only server-owned reviewer and time", async () => {
  const persistedInputs: SourceIntakeInput[] = [];
  const response = await handleProviderSourcePost(
    request(form({
      modelProcessing: "permitted",
      modelInputReviewStatus: "cleared",
      modelReviewBasis: "Provider explicitly cleared this source for later model review.",
    })),
    dependencies({
      persistSourceIntake: async (input) => {
        persistedInputs.push(input);
        return { duplicate: false, source: intakeRecord(input) };
      },
    }),
  );

  assert.equal(response.status, 201);
  const persistedInput = persistedInputs[0];
  assert.ok(persistedInput);
  assert.deepEqual(persistedInput.permissions.modelInputReview, {
    status: "cleared",
    reviewerId: "northstar-provider",
    reviewedAt: fixedTime,
    basis: "Provider explicitly cleared this source for later model review.",
  });
});

test("exact replay converges on one server-generated identity and reports duplicate", async () => {
  const objects = new Map<string, PutSourceObjectResult>();
  const records = new Map<string, SourceIntakeRecord>();
  const deps = dependencies({
    putSourceObject: async (input) => {
      const key = JSON.stringify(input.metadata.binding);
      const existing = objects.get(key);
      if (existing) return { ...existing, created: false };
      const stored = storedResult(input);
      objects.set(key, stored);
      return stored;
    },
    persistSourceIntake: async (input) => {
      const key = `${input.sourceId}:${input.version}`;
      const existing = records.get(key);
      if (existing) return { duplicate: true, source: existing };
      const source = intakeRecord(input);
      records.set(key, source);
      return { duplicate: false, source };
    },
  });

  const first = await handleProviderSourcePost(request(), deps);
  const second = await handleProviderSourcePost(request(), deps);
  const firstBody = await body(first);
  const secondBody = await body(second);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(firstBody.duplicate, false);
  assert.equal(secondBody.duplicate, true);
  assert.deepEqual(secondBody.source, firstBody.source);
  assert.equal(objects.size, 1);
  assert.equal(records.size, 1);
});

test("storage failures prevent database admission and expose only safe errors", async () => {
  let persisted = false;
  const response = await handleProviderSourcePost(request(), dependencies({
    putSourceObject: async () => {
      throw Object.assign(new Error("private filesystem detail"), {
        code: "IO_FAILURE",
      });
    },
    persistSourceIntake: async (input) => {
      persisted = true;
      return { duplicate: false, source: intakeRecord(input) };
    },
  }));

  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "SOURCE_STORAGE_UNAVAILABLE",
    message: "Private source storage is unavailable.",
  });
  assert.equal(persisted, false);
});

test("database failure is honest after immutable bytes are written", async () => {
  let stored = false;
  const response = await handleProviderSourcePost(request(), dependencies({
    putSourceObject: async (input) => {
      stored = true;
      return storedResult(input);
    },
    persistSourceIntake: async () => {
      throw new Error("private database detail");
    },
  }));

  assert.equal(stored, true);
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), {
    ok: false,
    code: "SOURCE_INTAKE_UNAVAILABLE",
    message: "Durable source intake is unavailable.",
  });
});

test("grant revocation after storage leaves no admitted source", async () => {
  let authorizationChecks = 0;
  let persisted = false;
  const response = await handleProviderSourcePost(request(), dependencies({
    authorizeTarget: async () => {
      authorizationChecks += 1;
      return authorizationChecks === 1
        ? "authorized"
        : "grant-required";
    },
    persistSourceIntake: async (input) => {
      persisted = true;
      return { duplicate: false, source: intakeRecord(input) };
    },
  }));

  assert.equal(response.status, 403);
  assert.equal((await body(response)).code, "PROVIDER_GRANT_REQUIRED");
  assert.equal(persisted, false);
});

test("immutable storage and source-intake conflicts return distinct safe responses", async () => {
  const storageConflict = await handleProviderSourcePost(request(), dependencies({
    putSourceObject: async () => {
      throw Object.assign(new Error("private binding detail"), {
        code: "CONFLICT",
      });
    },
  }));
  assert.equal(storageConflict.status, 409);
  assert.equal(
    (await body(storageConflict)).code,
    "SOURCE_STORAGE_CONFLICT",
  );

  const intakeConflict = await handleProviderSourcePost(request(), dependencies({
    persistSourceIntake: async () => {
      throw Object.assign(new Error("private record detail"), {
        code: "SOURCE_CONFLICT",
      });
    },
  }));
  assert.equal(intakeConflict.status, 409);
  assert.equal(
    (await body(intakeConflict)).code,
    "SOURCE_INTAKE_CONFLICT",
  );
});
