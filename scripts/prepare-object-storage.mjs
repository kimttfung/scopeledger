import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const envPath = path.join(root, ".env.local");
const storageRoot = path.join(root, ".scopeledger-local", "object-storage");

let content;
try {
  content = await readFile(envPath, "utf8");
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    throw new Error("Create .env.local from .env.example before preparing object storage.");
  }
  throw error;
}

await mkdir(storageRoot, { recursive: true, mode: 0o700 });
await chmod(storageRoot, 0o700);

const line = `SCOPELEDGER_OBJECT_STORAGE_ROOT=${storageRoot}`;
const updated = /^SCOPELEDGER_OBJECT_STORAGE_ROOT=.*$/m.test(content)
  ? content.replace(/^SCOPELEDGER_OBJECT_STORAGE_ROOT=.*$/m, line)
  : `${content.trimEnd()}\n${line}\n`;
const temporaryPath = `${envPath}.object-storage.tmp`;
await writeFile(temporaryPath, updated, { encoding: "utf8", mode: 0o600 });
await rename(temporaryPath, envPath);

console.log("Prepared private local object storage.");
