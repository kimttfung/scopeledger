import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { ObjectStorageError } from "@scopeledger/object-storage-adapter";
import { providerSourceStorage } from "../../../apps/web/app/api/provider/sources/storage-runtime.js";

test("provider source storage fails closed without a fixed absolute private root", async () => {
  await assert.rejects(
    () => providerSourceStorage({}),
    /not configured/u,
  );
  await assert.rejects(
    () => providerSourceStorage({
      SCOPELEDGER_OBJECT_STORAGE_ROOT: "relative/source-store",
    }),
    (error: unknown) =>
      error instanceof ObjectStorageError
      && error.code === "INVALID_CONFIGURATION",
  );
});

test("provider source storage opens only the configured private local root", async () => {
  const parent = await mkdtemp(
    join(process.cwd(), ".provider-source-storage-test-"),
  );
  const root = join(parent, "private");
  try {
    const storage = await providerSourceStorage({
      SCOPELEDGER_OBJECT_STORAGE_ROOT: root,
    });
    const stored = await storage.put({
      bytes: new TextEncoder().encode("private provider source"),
      metadata: {
        binding: {
          workspaceId: "workspace",
          projectId: "project",
          sourceId: "source",
          versionId: "1",
        },
        browserFilename: "source.txt",
        mediaType: "text/plain",
      },
    });
    assert.equal(stored.created, true);
    assert.deepEqual(
      (await storage.read(stored.binding)).bytes,
      new TextEncoder().encode("private provider source"),
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
