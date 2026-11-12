import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  LocalObjectStorage,
  ObjectStorageConflictError,
  ObjectStorageError,
  ObjectStorageIntegrityError,
  ObjectStorageLimitError,
  ObjectStorageNotFoundError,
  type ServerOwnedSourceBinding,
} from "../../../packages/adapters/object-storage/src/index.js";

const encoder = new TextEncoder();

const defaultBinding: ServerOwnedSourceBinding = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  sourceId: "source-1",
  versionId: "version-1",
};

async function sandbox(
  maxObjectBytes = 1_024,
  maxReadBytes = maxObjectBytes,
) {
  const parent = await mkdtemp(join(process.cwd(), ".object-storage-test-"));
  const root = join(parent, "private-store");
  const storage = await LocalObjectStorage.open({
    root,
    maxObjectBytes,
    maxReadBytes,
  });
  return {
    parent,
    root,
    storage,
    async cleanup() {
      await rm(parent, { recursive: true, force: true });
    },
  };
}

async function allPaths(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      output.push(child);
      if (entry.isDirectory()) {
        await visit(child);
      }
    }
  }
  await visit(root);
  return output;
}

async function findNamed(root: string, name: string): Promise<string> {
  const matches = (await allPaths(root)).filter(
    (path) => path.endsWith(`/${name}`),
  );
  assert.equal(matches.length, 1);
  return matches[0]!;
}

test("never derives paths from source identifiers or browser filenames", async () => {
  await assert.rejects(
    () => LocalObjectStorage.open({
      root: "../relative-store",
      maxObjectBytes: 1_024,
    }),
    (error: unknown) => error instanceof ObjectStorageError
      && error.code === "INVALID_CONFIGURATION",
  );
  const fixture = await sandbox();
  try {
    const binding = {
      workspaceId: "../../../../workspace",
      projectId: "project/../../../outside",
      sourceId: "https://example.test/../../source",
      versionId: "../version",
    };
    const bytes = encoder.encode("synthetic traversal fixture");
    const stored = await fixture.storage.put({
      bytes,
      metadata: {
        binding,
        browserFilename: "../../../../escaped.pdf",
        mediaType: "application/pdf",
      },
    });
    assert.equal(stored.browserFilename, "../../../../escaped.pdf");
    assert.deepEqual(
      (await fixture.storage.read(binding)).bytes,
      bytes,
    );
    await assert.rejects(
      () => fixture.storage.readObject("../../../../etc/passwd"),
      (error: unknown) => error instanceof ObjectStorageError
        && error.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => lstat(join(fixture.parent, "escaped.pdf")),
      { code: "ENOENT" },
    );
  } finally {
    await fixture.cleanup();
  }
});

test("rejects configured-root and stored-file symbolic links", {
  skip: process.platform === "win32",
}, async () => {
  const parent = await mkdtemp(join(process.cwd(), ".object-storage-test-"));
  try {
    const realRoot = join(parent, "real");
    const linkedRoot = join(parent, "linked");
    await LocalObjectStorage.open({
      root: realRoot,
      maxObjectBytes: 1_024,
    });
    await symlink(realRoot, linkedRoot, "dir");
    await assert.rejects(
      () => LocalObjectStorage.open({
        root: linkedRoot,
        maxObjectBytes: 1_024,
      }),
      (error: unknown) => error instanceof ObjectStorageError
        && error.code === "INVALID_CONFIGURATION",
    );

    const escapeRoot = join(parent, "escape-store");
    const escapeStorage = await LocalObjectStorage.open({
      root: escapeRoot,
      maxObjectBytes: 1_024,
    });
    const objectIndex = join(escapeRoot, "objects", "sha256");
    const outsideDirectory = join(parent, "outside-directory");
    await rm(objectIndex, { recursive: true });
    await mkdir(outsideDirectory, { mode: 0o700 });
    await symlink(outsideDirectory, objectIndex, "dir");
    await assert.rejects(
      () => escapeStorage.put({
        bytes: encoder.encode("must not escape"),
        metadata: { binding: defaultBinding },
      }),
      (error: unknown) => error instanceof ObjectStorageIntegrityError,
    );
    assert.deepEqual(await readdir(outsideDirectory), []);

    const storage = await LocalObjectStorage.open({
      root: realRoot,
      maxObjectBytes: 1_024,
    });
    const stored = await storage.put({
      bytes: encoder.encode("immutable payload"),
      metadata: { binding: defaultBinding },
    });
    const data = await findNamed(realRoot, "data");
    const original = `${data}.original`;
    const outside = join(parent, "outside");
    await writeFile(outside, "immutable payload", { mode: 0o600 });
    await rename(data, original);
    await symlink(outside, data);
    await assert.rejects(
      () => storage.readObject(stored.objectId),
      (error: unknown) => error instanceof ObjectStorageIntegrityError,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("duplicate exact writes are idempotent and preserve the first record", async () => {
  const fixture = await sandbox();
  try {
    const input = {
      bytes: encoder.encode("same immutable bytes"),
      metadata: {
        binding: defaultBinding,
        browserFilename: "source.pdf",
        mediaType: "application/pdf",
      },
    };
    const first = await fixture.storage.put(input);
    const second = await fixture.storage.put(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.objectId, first.objectId);
    assert.equal(second.storedAt, first.storedAt);
    assert.deepEqual((await fixture.storage.read(defaultBinding)).bytes, input.bytes);
  } finally {
    await fixture.cleanup();
  }
});

test("the same source version cannot be rebound to changed content or metadata", async () => {
  const fixture = await sandbox();
  try {
    await fixture.storage.put({
      bytes: encoder.encode("original"),
      metadata: {
        binding: defaultBinding,
        browserFilename: "source.pdf",
      },
    });
    await assert.rejects(
      () => fixture.storage.put({
        bytes: encoder.encode("changed"),
        metadata: {
          binding: defaultBinding,
          browserFilename: "source.pdf",
        },
      }),
      (error: unknown) => error instanceof ObjectStorageConflictError,
    );
    await assert.rejects(
      () => fixture.storage.put({
        bytes: encoder.encode("original"),
        metadata: {
          binding: defaultBinding,
          browserFilename: "renamed.pdf",
        },
      }),
      (error: unknown) => error instanceof ObjectStorageConflictError,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("content identity is shared safely across distinct server-owned bindings", async () => {
  const fixture = await sandbox();
  try {
    const bytes = encoder.encode("shared content");
    const first = await fixture.storage.put({
      bytes,
      metadata: { binding: defaultBinding },
    });
    const secondBinding = {
      ...defaultBinding,
      versionId: "version-2",
    };
    const second = await fixture.storage.put({
      bytes,
      metadata: { binding: secondBinding },
    });
    assert.equal(second.objectId, first.objectId);
    assert.equal(second.created, true);
    assert.deepEqual((await fixture.storage.read(secondBinding)).bytes, bytes);
    const dataFiles = (await allPaths(fixture.root)).filter(
      (path) => path.endsWith("/data"),
    );
    assert.equal(dataFiles.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("directories and files use private permissions where supported", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await sandbox();
  try {
    await fixture.storage.put({
      bytes: encoder.encode("private"),
      metadata: { binding: defaultBinding },
    });
    const paths = [fixture.root, ...(await allPaths(fixture.root))];
    for (const path of paths) {
      const info = await stat(path);
      const permissions = info.mode & 0o777;
      assert.equal(
        permissions,
        info.isDirectory() ? 0o700 : 0o600,
        path,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("enforces exact write and configured read byte limits", async () => {
  const fixture = await sandbox(8, 8);
  try {
    const bytes = encoder.encode("12345678");
    const stored = await fixture.storage.put({
      bytes,
      metadata: { binding: defaultBinding },
    });
    assert.deepEqual(
      (await fixture.storage.readObject(stored.objectId, { maxBytes: 8 })).bytes,
      bytes,
    );
    await assert.rejects(
      () => fixture.storage.put({
        bytes: encoder.encode("123456789"),
        metadata: {
          binding: { ...defaultBinding, versionId: "oversized" },
        },
      }),
      (error: unknown) => error instanceof ObjectStorageLimitError
        && error.limit === 8
        && error.actual === 9,
    );
    await assert.rejects(
      () => fixture.storage.readObject(stored.objectId, { maxBytes: 7 }),
      (error: unknown) => error instanceof ObjectStorageLimitError
        && error.limit === 7
        && error.actual === 8,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("idempotent writes remain valid when the configured read bound is lower", async () => {
  const fixture = await sandbox(16, 8);
  try {
    const input = {
      bytes: encoder.encode("1234567890"),
      metadata: { binding: defaultBinding },
    };
    const first = await fixture.storage.put(input);
    const second = await fixture.storage.put(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    await assert.rejects(
      () => fixture.storage.read(defaultBinding),
      (error: unknown) => error instanceof ObjectStorageLimitError
        && error.limit === 8
        && error.actual === 10,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent atomic publication leaves no staging or temporary files", async () => {
  const fixture = await sandbox();
  try {
    const input = {
      bytes: encoder.encode("concurrent immutable bytes"),
      metadata: { binding: defaultBinding },
    };
    const secondStorage = await LocalObjectStorage.open({
      root: fixture.root,
      maxObjectBytes: 1_024,
    });
    const results = await Promise.all([
      fixture.storage.put(input),
      secondStorage.put(input),
    ]);
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(results[0]!.objectId, results[1]!.objectId);
    const paths = await allPaths(fixture.root);
    assert.equal(
      paths.some((path) => path.includes(".stage-") || path.endsWith(".tmp")),
      false,
    );
    assert.deepEqual(
      (await fixture.storage.read(defaultBinding)).bytes,
      input.bytes,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("detects same-size payload and metadata tampering", async () => {
  const fixture = await sandbox();
  try {
    const stored = await fixture.storage.put({
      bytes: encoder.encode("original"),
      metadata: { binding: defaultBinding },
    });
    const data = await findNamed(fixture.root, "data");
    await writeFile(data, "tampered", { mode: 0o600 });
    await assert.rejects(
      () => fixture.storage.readObject(stored.objectId),
      (error: unknown) => error instanceof ObjectStorageIntegrityError,
    );
    await writeFile(data, "original", { mode: 0o600 });

    const recordFiles = (await allPaths(fixture.root)).filter(
      (path) => path.endsWith("/record.json"),
    );
    let bindingRecord: string | undefined;
    for (const path of recordFiles) {
      if ((await readFile(path, "utf8")).includes("workspaceId")) {
        bindingRecord = path;
        break;
      }
    }
    assert.ok(bindingRecord);
    const metadata = await readFile(bindingRecord, "utf8");
    assert.match(metadata, /version-1/);
    await writeFile(
      bindingRecord,
      metadata.replace("version-1", "version-x"),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => fixture.storage.read(defaultBinding),
      (error: unknown) => error instanceof ObjectStorageIntegrityError,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("returns an explicit not-found error for absent bindings and objects", async () => {
  const fixture = await sandbox();
  try {
    await assert.rejects(
      () => fixture.storage.read(defaultBinding),
      (error: unknown) => error instanceof ObjectStorageNotFoundError,
    );
    await assert.rejects(
      () => fixture.storage.readObject(`sha256:${"0".repeat(64)}`),
      (error: unknown) => error instanceof ObjectStorageNotFoundError,
    );
  } finally {
    await fixture.cleanup();
  }
});
