import pg from "pg";
import {
  ProtocolDatabase,
  validateSchemaName,
} from "@scopeledger/db";

const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
if (!connectionString || !schema) {
  throw new Error("Development database URL and schema are required");
}
validateSchemaName(schema);

const client = new pg.Client({ connectionString });
await client.connect();
try {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
} finally {
  await client.end();
}

const database = new ProtocolDatabase({
  connectionString,
  schema,
});
try {
  await database.migrate();
  console.log(`Migrated development schema ${schema}`);
} finally {
  await database.close();
}
