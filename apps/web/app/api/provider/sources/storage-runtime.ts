import {
  LocalObjectStorage,
  type PrivateSourceObjectStorage,
} from "@scopeledger/object-storage-adapter";

const MAX_SOURCE_BYTES = 10_000_000;

type SourceStorageGlobal = typeof globalThis & {
  __scopeledgerProviderSourceStorage?: Readonly<{
    root: string;
    storage: Promise<PrivateSourceObjectStorage>;
  }>;
};

export async function providerSourceStorage(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PrivateSourceObjectStorage> {
  const root = environment.SCOPELEDGER_OBJECT_STORAGE_ROOT;
  if (!root || root.trim() !== root) {
    throw new Error("Provider source storage is not configured");
  }
  const global = globalThis as SourceStorageGlobal;
  if (global.__scopeledgerProviderSourceStorage?.root === root) {
    return global.__scopeledgerProviderSourceStorage.storage;
  }
  const storage = LocalObjectStorage.open({
    root,
    maxObjectBytes: MAX_SOURCE_BYTES,
    maxReadBytes: MAX_SOURCE_BYTES,
  });
  global.__scopeledgerProviderSourceStorage = Object.freeze({ root, storage });
  try {
    return await storage;
  } catch (error) {
    if (global.__scopeledgerProviderSourceStorage?.storage === storage) {
      delete global.__scopeledgerProviderSourceStorage;
    }
    throw error;
  }
}
