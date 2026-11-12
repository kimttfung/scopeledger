import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "@scopeledger/db";
import type { ProtocolDatabase } from "@scopeledger/db";

async function observe(database: ProtocolDatabase, description: string, condition: () => Promise<boolean>) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail(`Timed out observing PostgreSQL barrier: ${description}`);
}

/** A test-only trigger blocks the first transaction just before commit, while its real row locks remain held. */
export async function commitBarrier(database: ProtocolDatabase, event: string, resourceId: string) {
  assert.match(event, /^[a-z-]+$/);
  assert.match(resourceId, /^(?:[A-Za-z0-9_-]+|\*)$/);
  const key = randomInt(1, 1_000_000_000);
  const controller = await database.pool.connect();
  await controller.query("select pg_advisory_lock($1)", [key]);
  await sql.raw(`CREATE FUNCTION proof_commit_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event = '${event}' AND ('${resourceId}' = '*' OR NEW.resource_id = '${resourceId}') THEN
        PERFORM pg_advisory_xact_lock(${key});
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER proof_commit_gate BEFORE INSERT ON protocol_history
      FOR EACH ROW EXECUTE FUNCTION proof_commit_gate();`).execute(database.kysely);
  let released = false;
  return {
    waitForFirst: async (pid: number) => observe(database, `first backend ${pid} waiting on owned advisory gate`, async () => {
      const rows = await database.pool.query<{ waiting: boolean }>(
        "select wait_event_type = 'Lock' and lower(coalesce(wait_event,'')) = 'advisory' as waiting from pg_stat_activity where pid = $1", [pid],
      );
      return rows.rows[0]?.waiting === true;
    }),
    waitForBlocked: async (firstPid: number, secondPid: number) => observe(database, `owned backend ${secondPid} blocked by ${firstPid}`, async () => {
      const rows = await database.pool.query<{ blocked: boolean }>(
        "select $1::integer = any(pg_blocking_pids($2::integer)) as blocked", [firstPid, secondPid],
      );
      return rows.rows[0]?.blocked === true;
    }),
    release: async () => {
      if (released) return;
      released = true;
      await controller.query("select pg_advisory_unlock($1)", [key]);
      controller.release();
    },
    dispose: async () => {
      if (!released) {
        released = true;
        await controller.query("select pg_advisory_unlock($1)", [key]);
        controller.release();
      }
      await sql.raw("DROP TRIGGER proof_commit_gate ON protocol_history; DROP FUNCTION proof_commit_gate()").execute(database.kysely);
    },
  };
}

export async function settled<T>(work: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try { return { value: await work }; } catch (error) { return { error }; }
}
