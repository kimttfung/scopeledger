import { randomUUID } from "node:crypto";
import {
  MailpitEmailClient,
  localEmailConfigFromEnvironment,
} from "@scopeledger/email-adapter";
import {
  PostgresNotificationOutboxStore,
  ProtocolDatabase,
} from "@scopeledger/db";
import {
  MailpitNotificationDelivery,
  NotificationWorker,
  notificationRecipientDirectoryFromEnvironment,
} from "../packages/notifications/dist/index.js";

let database;
let failed = false;
let summary = {
  claimed: 0,
  delivered: 0,
  recovered: 0,
  retried: 0,
  suppressed: 0,
  obsolete: 0,
  manual: 0,
};

try {
  const connectionString = process.env.SCOPELEDGER_DATABASE_URL;
  const schema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
  const mailpitApi = process.env.EMAIL_MAILPIT_API;
  if (!connectionString || !schema || !mailpitApi) {
    throw new Error("Notification database and Mailpit configuration is required");
  }
  database = new ProtocolDatabase({ connectionString, schema });
  const worker = new NotificationWorker(
    new PostgresNotificationOutboxStore(database),
    new MailpitNotificationDelivery(
      new MailpitEmailClient(localEmailConfigFromEnvironment()),
      mailpitApi,
    ),
    notificationRecipientDirectoryFromEnvironment(),
    {
      workerId: `local-${randomUUID().slice(0, 8)}`,
      batchSize: 10,
      leaseSeconds: 60,
    },
  );
  summary = await worker.runBatch();
} catch {
  failed = true;
} finally {
  if (database) {
    try {
      await database.close();
    } catch {
      failed = true;
    }
  }
}

console.log(JSON.stringify({
  ...summary,
  ok: !failed,
}, null, 2));
if (failed) process.exitCode = 1;
