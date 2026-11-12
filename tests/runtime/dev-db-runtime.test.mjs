import assert from "node:assert/strict";
import test from "node:test";
import { devPostgresContainerArgs } from "../../scripts/run-dev-db.mjs";

test("development PostgreSQL binds only to loopback and has explicit ownership", () => {
  const args = devPostgresContainerArgs();
  assert.ok(args.includes("127.0.0.1:5433:5432"));
  assert.ok(args.includes("scopeledger.dev.owner=scopeledger"));
  assert.ok(args.includes("scopeledger-dev-postgres-data:/var/lib/postgresql/data"));
});

test("development PostgreSQL uses the pinned durable image configuration", () => {
  const args = devPostgresContainerArgs();
  assert.ok(args.includes(
    "postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f",
  ));
  assert.ok(args.includes("fsync=on"));
  assert.ok(args.includes("synchronous_commit=on"));
});
