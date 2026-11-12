import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import {
  isAbsolute,
  dirname,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

const OBJECT_ID_PATTERN = /^sha256:([a-f0-9]{64})$/;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_FILENAME_LENGTH = 512;
const MAX_MEDIA_TYPE_LENGTH = 255;
const MAX_RECORD_BYTES = 16_384;
const MAX_CONFIGURED_OBJECT_BYTES = 1_000_000_000;

export type ObjectStorageErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_INPUT"
  | "SIZE_LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTEGRITY_VIOLATION"
  | "IO_FAILURE";

export class ObjectStorageError extends Error {
  constructor(
    public readonly code: ObjectStorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ObjectStorageError";
  }
}

export class ObjectStorageNotFoundError extends ObjectStorageError {
  constructor(message = "Stored object was not found") {
    super("NOT_FOUND", message);
    this.name = "ObjectStorageNotFoundError";
  }
}

export class ObjectStorageConflictError extends ObjectStorageError {
  constructor(message = "The immutable source binding already contains different data") {
    super("CONFLICT", message);
    this.name = "ObjectStorageConflictError";
  }
}

export class ObjectStorageIntegrityError extends ObjectStorageError {
  constructor(message = "Stored object integrity verification failed") {
    super("INTEGRITY_VIOLATION", message);
    this.name = "ObjectStorageIntegrityError";
  }
}

export class ObjectStorageLimitError extends ObjectStorageError {
  constructor(
    public readonly limit: number,
    public readonly actual: number,
    message = "Object exceeds the configured byte limit",
  ) {
    super("SIZE_LIMIT_EXCEEDED", message);
    this.name = "ObjectStorageLimitError";
  }
}

export type ServerOwnedSourceBinding = Readonly<{
  workspaceId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
}>;

export type SourceUploadMetadata = Readonly<{
  binding: ServerOwnedSourceBinding;
  browserFilename?: string | null;
  mediaType?: string | null;
}>;

export type PutSourceObjectInput = Readonly<{
  bytes: Uint8Array;
  metadata: SourceUploadMetadata;
}>;

export type StoredSourceObject = Readonly<{
  schemaVersion: 1;
  objectId: string;
  byteLength: number;
  binding: ServerOwnedSourceBinding;
  browserFilename: string | null;
  mediaType: string | null;
  storedAt: string;
}>;

export type PutSourceObjectResult = StoredSourceObject & Readonly<{
  created: boolean;
}>;

export type StoredObjectRead = Readonly<{
  objectId: string;
  byteLength: number;
  bytes: Uint8Array;
}>;

export type StoredSourceObjectRead = Readonly<{
  object: StoredSourceObject;
  bytes: Uint8Array;
}>;

export type ObjectReadOptions = Readonly<{
  maxBytes?: number;
}>;

export interface PrivateSourceObjectStorage {
  put(input: PutSourceObjectInput): Promise<PutSourceObjectResult>;
  read(
    binding: ServerOwnedSourceBinding,
    options?: ObjectReadOptions,
  ): Promise<StoredSourceObjectRead>;
  readObject(
    objectId: string,
    options?: ObjectReadOptions,
  ): Promise<StoredObjectRead>;
}

export type LocalObjectStorageOptions = Readonly<{
  root: string;
  maxObjectBytes: number;
  maxReadBytes?: number;
}>;

type ObjectRecordPayload = Readonly<{
  schemaVersion: 1;
  objectId: string;
  byteLength: number;
}>;

type ObjectRecord = ObjectRecordPayload & Readonly<{
  integrity: Readonly<{
    algorithm: "sha256";
    digest: string;
  }>;
}>;

type BindingRecordPayload = Readonly<{
  schemaVersion: 1;
  objectId: string;
  byteLength: number;
  binding: ServerOwnedSourceBinding;
  browserFilename: string | null;
  mediaType: string | null;
  storedAt: string;
}>;

type BindingRecord = BindingRecordPayload & Readonly<{
  integrity: Readonly<{
    algorithm: "sha256";
    digest: string;
  }>;
}>;

type SecureFileRead = Readonly<{
  bytes: Buffer;
  size: number;
}>;

type PublishedBinding = Readonly<{
  record: BindingRecordPayload;
  created: boolean;
}>;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === code;
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isExisting(error: unknown): boolean {
  return isNodeError(error, "EEXIST")
    || isNodeError(error, "ENOTEMPTY");
}

function invalidInput(message: string): ObjectStorageError {
  return new ObjectStorageError("INVALID_INPUT", message);
}

function invalidConfiguration(message: string): ObjectStorageError {
  return new ObjectStorageError("INVALID_CONFIGURATION", message);
}

function ioFailure(error: unknown): ObjectStorageError {
  if (error instanceof ObjectStorageError) {
    return error;
  }
  return new ObjectStorageError(
    "IO_FAILURE",
    "Local object storage operation failed",
    { cause: error },
  );
}

function freezeBinding(
  binding: ServerOwnedSourceBinding,
): ServerOwnedSourceBinding {
  return Object.freeze({
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    sourceId: binding.sourceId,
    versionId: binding.versionId,
  });
}

function freezeStoredObject(
  record: BindingRecordPayload,
): StoredSourceObject {
  return Object.freeze({
    schemaVersion: 1,
    objectId: record.objectId,
    byteLength: record.byteLength,
    binding: freezeBinding(record.binding),
    browserFilename: record.browserFilename,
    mediaType: record.mediaType,
    storedAt: record.storedAt,
  });
}

function freezePutResult(
  record: BindingRecordPayload,
  created: boolean,
): PutSourceObjectResult {
  return Object.freeze({
    ...freezeStoredObject(record),
    created,
  });
}

function validateBoundedString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximumLength
    || value.includes("\0")
  ) {
    throw invalidInput(`${name} is invalid`);
  }
  return value;
}

function validateOptionalString(
  value: unknown,
  name: string,
  maximumLength: number,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return validateBoundedString(value, name, maximumLength);
}

function validateBinding(input: unknown): ServerOwnedSourceBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput("Source binding is invalid");
  }
  const binding = input as Record<string, unknown>;
  return freezeBinding({
    workspaceId: validateBoundedString(
      binding.workspaceId,
      "workspaceId",
      MAX_IDENTIFIER_LENGTH,
    ),
    projectId: validateBoundedString(
      binding.projectId,
      "projectId",
      MAX_IDENTIFIER_LENGTH,
    ),
    sourceId: validateBoundedString(
      binding.sourceId,
      "sourceId",
      MAX_IDENTIFIER_LENGTH,
    ),
    versionId: validateBoundedString(
      binding.versionId,
      "versionId",
      MAX_IDENTIFIER_LENGTH,
    ),
  });
}

function canonicalBinding(binding: ServerOwnedSourceBinding): string {
  return JSON.stringify([
    binding.workspaceId,
    binding.projectId,
    binding.sourceId,
    binding.versionId,
  ]);
}

function bindingId(binding: ServerOwnedSourceBinding): string {
  return sha256(canonicalBinding(binding));
}

function parseObjectId(objectId: unknown): string {
  if (typeof objectId !== "string") {
    throw invalidInput("Object identity is invalid");
  }
  const match = OBJECT_ID_PATTERN.exec(objectId);
  if (!match?.[1]) {
    throw invalidInput("Object identity is invalid");
  }
  return match[1];
}

function validateByteLimit(
  value: unknown,
  name: string,
  maximum = MAX_CONFIGURED_OBJECT_BYTES,
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw invalidConfiguration(`${name} is invalid`);
  }
  return value;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function objectRecordPayload(
  objectId: string,
  byteLength: number,
): ObjectRecordPayload {
  return {
    schemaVersion: 1,
    objectId,
    byteLength,
  };
}

function bindingRecordPayload(
  objectId: string,
  byteLength: number,
  metadata: SourceUploadMetadata,
  storedAt: string,
): BindingRecordPayload {
  return {
    schemaVersion: 1,
    objectId,
    byteLength,
    binding: validateBinding(metadata.binding),
    browserFilename: validateOptionalString(
      metadata.browserFilename,
      "browserFilename",
      MAX_FILENAME_LENGTH,
    ),
    mediaType: validateOptionalString(
      metadata.mediaType,
      "mediaType",
      MAX_MEDIA_TYPE_LENGTH,
    ),
    storedAt,
  };
}

function sealObjectRecord(payload: ObjectRecordPayload): ObjectRecord {
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      digest: sha256(JSON.stringify(payload)),
    },
  };
}

function sealBindingRecord(payload: BindingRecordPayload): BindingRecord {
  return {
    ...payload,
    integrity: {
      algorithm: "sha256",
      digest: sha256(JSON.stringify(payload)),
    },
  };
}

function parseJsonRecord(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ObjectStorageIntegrityError("Stored metadata is invalid");
  }
}

function parseObjectRecord(value: unknown): ObjectRecordPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObjectStorageIntegrityError("Stored object metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "objectId",
      "byteLength",
      "integrity",
    ])
    || record.schemaVersion !== 1
    || typeof record.objectId !== "string"
    || typeof record.byteLength !== "number"
    || !Number.isSafeInteger(record.byteLength)
    || record.byteLength < 1
    || !record.integrity
    || typeof record.integrity !== "object"
    || Array.isArray(record.integrity)
  ) {
    throw new ObjectStorageIntegrityError("Stored object metadata is invalid");
  }
  const integrity = record.integrity as Record<string, unknown>;
  if (
    !hasExactKeys(integrity, ["algorithm", "digest"])
    || integrity.algorithm !== "sha256"
    || typeof integrity.digest !== "string"
  ) {
    throw new ObjectStorageIntegrityError("Stored object metadata is invalid");
  }
  try {
    parseObjectId(record.objectId);
  } catch {
    throw new ObjectStorageIntegrityError("Stored object metadata is invalid");
  }
  const payload = objectRecordPayload(record.objectId, record.byteLength);
  if (sha256(JSON.stringify(payload)) !== integrity.digest) {
    throw new ObjectStorageIntegrityError("Stored object metadata was modified");
  }
  return payload;
}

function parseBindingRecord(value: unknown): BindingRecordPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ObjectStorageIntegrityError("Stored source binding is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "objectId",
      "byteLength",
      "binding",
      "browserFilename",
      "mediaType",
      "storedAt",
      "integrity",
    ])
    || record.schemaVersion !== 1
    || typeof record.objectId !== "string"
    || typeof record.byteLength !== "number"
    || !Number.isSafeInteger(record.byteLength)
    || record.byteLength < 1
    || typeof record.storedAt !== "string"
    || !record.integrity
    || typeof record.integrity !== "object"
    || Array.isArray(record.integrity)
  ) {
    throw new ObjectStorageIntegrityError("Stored source binding is invalid");
  }
  const integrity = record.integrity as Record<string, unknown>;
  if (
    !hasExactKeys(integrity, ["algorithm", "digest"])
    || integrity.algorithm !== "sha256"
    || typeof integrity.digest !== "string"
  ) {
    throw new ObjectStorageIntegrityError("Stored source binding is invalid");
  }
  let binding: ServerOwnedSourceBinding;
  let browserFilename: string | null;
  let mediaType: string | null;
  try {
    parseObjectId(record.objectId);
    binding = validateBinding(record.binding);
    browserFilename = validateOptionalString(
      record.browserFilename,
      "browserFilename",
      MAX_FILENAME_LENGTH,
    );
    mediaType = validateOptionalString(
      record.mediaType,
      "mediaType",
      MAX_MEDIA_TYPE_LENGTH,
    );
    if (!Number.isFinite(Date.parse(record.storedAt))) {
      throw invalidInput("storedAt is invalid");
    }
  } catch {
    throw new ObjectStorageIntegrityError("Stored source binding is invalid");
  }
  const payload: BindingRecordPayload = {
    schemaVersion: 1,
    objectId: record.objectId,
    byteLength: record.byteLength,
    binding,
    browserFilename,
    mediaType,
    storedAt: record.storedAt,
  };
  if (sha256(JSON.stringify(payload)) !== integrity.digest) {
    throw new ObjectStorageIntegrityError("Stored source binding was modified");
  }
  return payload;
}

function sameBinding(
  left: ServerOwnedSourceBinding,
  right: ServerOwnedSourceBinding,
): boolean {
  return canonicalBinding(left) === canonicalBinding(right);
}

function samePut(
  record: BindingRecordPayload,
  candidate: BindingRecordPayload,
): boolean {
  return record.objectId === candidate.objectId
    && record.byteLength === candidate.byteLength
    && sameBinding(record.binding, candidate.binding)
    && record.browserFilename === candidate.browserFilename
    && record.mediaType === candidate.mediaType;
}

async function setPrivateMode(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode);
  } catch (error) {
    if (
      process.platform === "win32"
      && (
        isNodeError(error, "ENOSYS")
        || isNodeError(error, "ENOTSUP")
        || isNodeError(error, "EINVAL")
        || isNodeError(error, "EPERM")
      )
    ) {
      return;
    }
    throw error;
  }
}

function verifyPrivateMode(mode: number): void {
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    throw new ObjectStorageIntegrityError(
      "Stored object permissions are not private",
    );
  }
}

async function syncAndClose(handle: FileHandle): Promise<void> {
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten < 1) {
        throw new ObjectStorageError(
          "IO_FAILURE",
          "Local object storage write made no progress",
        );
      }
      offset += bytesWritten;
    }
    await setPrivateMode(path, 0o600);
    await syncAndClose(handle);
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export class LocalObjectStorage implements PrivateSourceObjectStorage {
  readonly #root: string;
  readonly #objectsRoot: string;
  readonly #bindingsRoot: string;
  readonly #maxObjectBytes: number;
  readonly #maxReadBytes: number;

  private constructor(
    root: string,
    maxObjectBytes: number,
    maxReadBytes: number,
  ) {
    this.#root = root;
    this.#objectsRoot = join(root, "objects", "sha256");
    this.#bindingsRoot = join(root, "bindings", "sha256");
    this.#maxObjectBytes = maxObjectBytes;
    this.#maxReadBytes = maxReadBytes;
  }

  static async open(
    options: LocalObjectStorageOptions,
  ): Promise<LocalObjectStorage> {
    if (!options || typeof options !== "object") {
      throw invalidConfiguration("Local object storage options are invalid");
    }
    if (
      typeof options.root !== "string"
      || options.root.length === 0
      || !isAbsolute(options.root)
      || options.root.includes("\0")
    ) {
      throw invalidConfiguration(
        "Local object storage root must be an absolute path",
      );
    }
    const root = resolve(options.root);
    if (root === parse(root).root) {
      throw invalidConfiguration(
        "Local object storage root cannot be the filesystem root",
      );
    }
    const maxObjectBytes = validateByteLimit(
      options.maxObjectBytes,
      "maxObjectBytes",
    );
    const maxReadBytes = options.maxReadBytes === undefined
      ? maxObjectBytes
      : validateByteLimit(
        options.maxReadBytes,
        "maxReadBytes",
        maxObjectBytes,
      );
    const storage = new LocalObjectStorage(
      root,
      maxObjectBytes,
      maxReadBytes,
    );
    try {
      await storage.#initialize();
      return storage;
    } catch (error) {
      throw ioFailure(error);
    }
  }

  async put(input: PutSourceObjectInput): Promise<PutSourceObjectResult> {
    try {
      if (!input || typeof input !== "object") {
        throw invalidInput("Stored object input is invalid");
      }
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) {
        throw invalidInput("Stored object must contain bytes");
      }
      if (input.bytes.byteLength > this.#maxObjectBytes) {
        throw new ObjectStorageLimitError(
          this.#maxObjectBytes,
          input.bytes.byteLength,
        );
      }
      if (!input.metadata || typeof input.metadata !== "object") {
        throw invalidInput("Stored object metadata is invalid");
      }

      const bytes = Buffer.from(input.bytes);
      const digest = sha256(bytes);
      const objectId = `sha256:${digest}`;
      const candidate = bindingRecordPayload(
        objectId,
        bytes.byteLength,
        input.metadata,
        new Date().toISOString(),
      );

      const existing = await this.#readBindingIfPresent(candidate.binding);
      if (existing) {
        if (!samePut(existing, candidate)) {
          throw new ObjectStorageConflictError();
        }
        await this.#readObjectVerified(
          existing.objectId,
          existing.byteLength,
          this.#maxObjectBytes,
        );
        return freezePutResult(existing, false);
      }

      await this.#ensureObject(objectId, bytes);
      const published = await this.#publishBinding(candidate);
      return freezePutResult(published.record, published.created);
    } catch (error) {
      throw ioFailure(error);
    }
  }

  async read(
    bindingInput: ServerOwnedSourceBinding,
    options: ObjectReadOptions = {},
  ): Promise<StoredSourceObjectRead> {
    try {
      const binding = validateBinding(bindingInput);
      const record = await this.#readBinding(binding);
      const maxBytes = this.#resolveReadLimit(options);
      const object = await this.#readObjectVerified(
        record.objectId,
        record.byteLength,
        maxBytes,
      );
      return Object.freeze({
        object: freezeStoredObject(record),
        bytes: object.bytes,
      });
    } catch (error) {
      throw ioFailure(error);
    }
  }

  async readObject(
    objectId: string,
    options: ObjectReadOptions = {},
  ): Promise<StoredObjectRead> {
    try {
      const maxBytes = this.#resolveReadLimit(options);
      return await this.#readObjectVerified(objectId, undefined, maxBytes);
    } catch (error) {
      throw ioFailure(error);
    }
  }

  #resolveReadLimit(options: ObjectReadOptions): number {
    if (!options || typeof options !== "object") {
      throw invalidInput("Read options are invalid");
    }
    if (options.maxBytes === undefined) {
      return this.#maxReadBytes;
    }
    if (
      !Number.isSafeInteger(options.maxBytes)
      || options.maxBytes < 1
      || options.maxBytes > this.#maxReadBytes
    ) {
      throw invalidInput("Read byte limit is invalid");
    }
    return options.maxBytes;
  }

  async #initialize(): Promise<void> {
    await this.#createRootWithoutSymlinks();
    await this.#ensureDirectory(this.#root);
    await this.#ensureDirectory(join(this.#root, "objects"));
    await this.#ensureDirectory(this.#objectsRoot);
    await this.#ensureDirectory(join(this.#root, "bindings"));
    await this.#ensureDirectory(this.#bindingsRoot);
  }

  async #createRootWithoutSymlinks(): Promise<void> {
    const parsed = parse(this.#root);
    const segments = this.#root
      .slice(parsed.root.length)
      .split(sep)
      .filter(Boolean);
    let current = parsed.root;
    let creating = false;
    for (const segment of segments) {
      current = join(current, segment);
      if (!creating) {
        try {
          const info = await lstat(current);
          if (info.isSymbolicLink()) {
            throw invalidConfiguration(
              "Local object storage root cannot contain symbolic links",
            );
          }
          if (!info.isDirectory()) {
            throw invalidConfiguration(
              "Local object storage root must be a directory",
            );
          }
          continue;
        } catch (error) {
          if (!isMissing(error)) {
            throw error;
          }
          creating = true;
        }
      }
      await mkdir(current, { mode: 0o700 });
      await setPrivateMode(current, 0o700);
    }
  }

  #withinRoot(path: string): string {
    const resolved = resolve(path);
    const pathFromRoot = relative(this.#root, resolved);
    if (
      pathFromRoot === ".."
      || pathFromRoot.startsWith(`..${sep}`)
      || isAbsolute(pathFromRoot)
    ) {
      throw new ObjectStorageIntegrityError(
        "Object storage path escaped its configured root",
      );
    }
    return resolved;
  }

  async #ensureDirectory(pathInput: string): Promise<void> {
    const path = this.#withinRoot(pathInput);
    if (path !== this.#root) {
      await this.#assertDirectory(dirname(path));
    }
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (!isExisting(error)) {
        throw error;
      }
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ObjectStorageIntegrityError(
        "Object storage directory is not a private directory",
      );
    }
    await setPrivateMode(path, 0o700);
    const canonical = await realpath(path);
    if (resolve(canonical) !== path) {
      throw new ObjectStorageIntegrityError(
        "Object storage directory contains a symbolic link",
      );
    }
  }

  async #assertDirectory(pathInput: string): Promise<void> {
    const path = this.#withinRoot(pathInput);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStorageNotFoundError();
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ObjectStorageIntegrityError(
        "Stored object directory is invalid",
      );
    }
    verifyPrivateMode(info.mode);
    const canonical = await realpath(path);
    if (resolve(canonical) !== path) {
      throw new ObjectStorageIntegrityError(
        "Stored object directory contains a symbolic link",
      );
    }
  }

  #objectDirectory(digest: string): string {
    return this.#withinRoot(
      join(this.#objectsRoot, digest.slice(0, 2), digest),
    );
  }

  #bindingDirectory(binding: ServerOwnedSourceBinding): string {
    const id = bindingId(binding);
    return this.#withinRoot(
      join(this.#bindingsRoot, id.slice(0, 2), id),
    );
  }

  async #ensureObject(objectId: string, bytes: Buffer): Promise<void> {
    const digest = parseObjectId(objectId);
    const shard = this.#withinRoot(join(this.#objectsRoot, digest.slice(0, 2)));
    await this.#ensureDirectory(shard);
    const destination = this.#objectDirectory(digest);

    try {
      await lstat(destination);
      await this.#readObjectVerified(
        objectId,
        bytes.byteLength,
        this.#maxObjectBytes,
      );
      return;
    } catch (error) {
      if (!isMissing(error)) {
        if (error instanceof ObjectStorageNotFoundError) {
          // A missing child within an existing object directory is corruption.
          throw new ObjectStorageIntegrityError(
            "Stored object is incomplete",
          );
        }
        throw error;
      }
    }

    const stage = this.#withinRoot(join(shard, `.stage-${randomUUID()}`));
    await mkdir(stage, { mode: 0o700 });
    await setPrivateMode(stage, 0o700);
    try {
      const temporaryData = join(stage, "data.tmp");
      const data = join(stage, "data");
      await writePrivateFile(temporaryData, bytes);
      await rename(temporaryData, data);

      const recordPayload = objectRecordPayload(objectId, bytes.byteLength);
      const recordBytes = Buffer.from(
        `${JSON.stringify(sealObjectRecord(recordPayload))}\n`,
        "utf8",
      );
      const temporaryRecord = join(stage, "record.tmp");
      const record = join(stage, "record.json");
      await writePrivateFile(temporaryRecord, recordBytes);
      await rename(temporaryRecord, record);

      const directoryHandle = await open(stage, constants.O_RDONLY);
      await syncAndClose(directoryHandle);

      try {
        await rename(stage, destination);
      } catch (error) {
        if (!isExisting(error)) {
          throw error;
        }
        await this.#readObjectVerified(
          objectId,
          bytes.byteLength,
          this.#maxObjectBytes,
        );
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async #publishBinding(
    candidate: BindingRecordPayload,
  ): Promise<PublishedBinding> {
    const id = bindingId(candidate.binding);
    const shard = this.#withinRoot(join(this.#bindingsRoot, id.slice(0, 2)));
    await this.#ensureDirectory(shard);
    const destination = this.#bindingDirectory(candidate.binding);
    const stage = this.#withinRoot(join(shard, `.stage-${randomUUID()}`));
    await mkdir(stage, { mode: 0o700 });
    await setPrivateMode(stage, 0o700);
    try {
      const bytes = Buffer.from(
        `${JSON.stringify(sealBindingRecord(candidate))}\n`,
        "utf8",
      );
      const temporaryRecord = join(stage, "record.tmp");
      const record = join(stage, "record.json");
      await writePrivateFile(temporaryRecord, bytes);
      await rename(temporaryRecord, record);
      const directoryHandle = await open(stage, constants.O_RDONLY);
      await syncAndClose(directoryHandle);
      try {
        await rename(stage, destination);
        return { record: candidate, created: true };
      } catch (error) {
        if (!isExisting(error)) {
          throw error;
        }
        const existing = await this.#readBinding(candidate.binding);
        if (!samePut(existing, candidate)) {
          throw new ObjectStorageConflictError();
        }
        return { record: existing, created: false };
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  async #readBindingIfPresent(
    binding: ServerOwnedSourceBinding,
  ): Promise<BindingRecordPayload | null> {
    try {
      return await this.#readBinding(binding);
    } catch (error) {
      if (error instanceof ObjectStorageNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  async #readBinding(
    binding: ServerOwnedSourceBinding,
  ): Promise<BindingRecordPayload> {
    const directory = this.#bindingDirectory(binding);
    await this.#assertDirectory(directory);
    let record: SecureFileRead;
    try {
      record = await this.#readSecureFile(
        join(directory, "record.json"),
        MAX_RECORD_BYTES,
      );
    } catch (error) {
      if (error instanceof ObjectStorageNotFoundError) {
        throw new ObjectStorageIntegrityError(
          "Stored source binding is incomplete",
        );
      }
      throw error;
    }
    const parsed = parseBindingRecord(parseJsonRecord(record.bytes));
    if (
      !sameBinding(parsed.binding, binding)
      || bindingId(parsed.binding) !== bindingId(binding)
    ) {
      throw new ObjectStorageIntegrityError(
        "Stored source binding does not match its location",
      );
    }
    return parsed;
  }

  async #readObjectVerified(
    objectId: string,
    expectedByteLength: number | undefined,
    maxBytes: number,
  ): Promise<StoredObjectRead> {
    const digest = parseObjectId(objectId);
    const directory = this.#objectDirectory(digest);
    await this.#assertDirectory(directory);
    let recordFile: SecureFileRead;
    try {
      recordFile = await this.#readSecureFile(
        join(directory, "record.json"),
        MAX_RECORD_BYTES,
      );
    } catch (error) {
      if (error instanceof ObjectStorageNotFoundError) {
        throw new ObjectStorageIntegrityError(
          "Stored object is incomplete",
        );
      }
      throw error;
    }
    const record = parseObjectRecord(parseJsonRecord(recordFile.bytes));
    if (
      record.objectId !== objectId
      || (expectedByteLength !== undefined
        && record.byteLength !== expectedByteLength)
    ) {
      throw new ObjectStorageIntegrityError(
        "Stored object metadata does not match its identity",
      );
    }
    if (record.byteLength > this.#maxObjectBytes) {
      throw new ObjectStorageIntegrityError(
        "Stored object exceeds the configured storage limit",
      );
    }
    if (record.byteLength > maxBytes) {
      throw new ObjectStorageLimitError(
        maxBytes,
        record.byteLength,
        "Stored object exceeds the requested read limit",
      );
    }
    const payload = await this.#readSecureFile(
      join(directory, "data"),
      maxBytes,
      record.byteLength,
    );
    if (
      payload.size !== record.byteLength
      || sha256(payload.bytes) !== digest
    ) {
      throw new ObjectStorageIntegrityError(
        "Stored object bytes do not match their immutable identity",
      );
    }
    return Object.freeze({
      objectId,
      byteLength: record.byteLength,
      bytes: new Uint8Array(payload.bytes),
    });
  }

  async #readSecureFile(
    pathInput: string,
    maxBytes: number,
    expectedSize?: number,
  ): Promise<SecureFileRead> {
    const path = this.#withinRoot(pathInput);
    let pathInfo;
    try {
      pathInfo = await lstat(path);
    } catch (error) {
      if (isMissing(error)) {
        throw new ObjectStorageNotFoundError();
      }
      throw error;
    }
    if (
      pathInfo.isSymbolicLink()
      || !pathInfo.isFile()
      || pathInfo.nlink !== 1
    ) {
      throw new ObjectStorageIntegrityError(
        "Stored object file is invalid",
      );
    }
    verifyPrivateMode(pathInfo.mode);
    const canonical = await realpath(path);
    if (resolve(canonical) !== path) {
      throw new ObjectStorageIntegrityError(
        "Stored object file contains a symbolic link",
      );
    }

    const noFollow = "O_NOFOLLOW" in constants
      ? constants.O_NOFOLLOW
      : 0;
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | noFollow);
    } catch (error) {
      if (
        isNodeError(error, "ELOOP")
        || isNodeError(error, "EMLINK")
      ) {
        throw new ObjectStorageIntegrityError(
          "Stored object file contains a symbolic link",
        );
      }
      throw error;
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.nlink !== 1
        || before.size < 0
        || !Number.isSafeInteger(before.size)
      ) {
        throw new ObjectStorageIntegrityError(
          "Stored object file is invalid",
        );
      }
      verifyPrivateMode(before.mode);
      if (expectedSize !== undefined && before.size !== expectedSize) {
        throw new ObjectStorageIntegrityError(
          "Stored object size does not match its immutable metadata",
        );
      }
      if (before.size > maxBytes) {
        throw new ObjectStorageLimitError(
          maxBytes,
          before.size,
          "Stored object exceeds the requested read limit",
        );
      }
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (result.bytesRead < 1) {
          throw new ObjectStorageIntegrityError(
            "Stored object ended before its declared size",
          );
        }
        offset += result.bytesRead;
      }
      const trailing = Buffer.alloc(1);
      const extra = await handle.read(trailing, 0, 1, offset);
      if (extra.bytesRead !== 0) {
        throw new ObjectStorageIntegrityError(
          "Stored object exceeds its declared size",
        );
      }
      const after = await handle.stat();
      if (
        after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ino !== before.ino
        || after.dev !== before.dev
      ) {
        throw new ObjectStorageIntegrityError(
          "Stored object changed while it was being read",
        );
      }
      return { bytes, size: before.size };
    } finally {
      await handle.close();
    }
  }
}
