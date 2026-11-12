import { lstat, readlink, symlink } from "node:fs/promises";
import { resolve } from "node:path";

const rootEnvironment = resolve(".env.local");
const webEnvironment = resolve("apps/web/.env.local");
const expectedTarget = "../../.env.local";

try {
  const root = await lstat(rootEnvironment);
  if (!root.isFile()) {
    throw new Error("Repository .env.local is not a regular file");
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    console.log("Repository .env.local is absent; starting web without external-service configuration");
    process.exit(0);
  }
  throw error;
}

try {
  const current = await lstat(webEnvironment);
  if (!current.isSymbolicLink() || await readlink(webEnvironment) !== expectedTarget) {
    throw new Error("apps/web/.env.local exists but is not the expected ignored link to the root environment");
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    await symlink(expectedTarget, webEnvironment);
  } else {
    throw error;
  }
}

console.log("Prepared ignored apps/web/.env.local link");
