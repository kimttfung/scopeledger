import { ProtocolDatabase } from "@scopeledger/db";

type ProtocolDatabaseGlobal = typeof globalThis & {
  __scopeledgerProtocolDatabase?: ProtocolDatabase;
};

export function protocolDatabase(): ProtocolDatabase | null {
  const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
  const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
  if (!connectionString || !schema) return null;
  const global = globalThis as ProtocolDatabaseGlobal;
  global.__scopeledgerProtocolDatabase ??= new ProtocolDatabase({
    connectionString,
    schema,
  });
  return global.__scopeledgerProtocolDatabase;
}
