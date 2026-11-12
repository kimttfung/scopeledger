import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AccessSessionCodec } from "@scopeledger/access";
import { ProtocolDatabase, sql } from "@scopeledger/db";
import {
  ReviewLoadError,
  ReviewLocatorCodec,
  type ReviewLocators,
  type ReviewProjection,
  type ReviewSession,
} from "../../../apps/web/app/api/review/service.js";

const databaseUrl = process.env.SCOPELEDGER_DATABASE_URL;
const databaseSchema = process.env.SCOPELEDGER_DATABASE_SCHEMA;
const secret = process.env.ACCESS_SESSION_SECRET;
const recipient = process.env.EMAIL_DEMO_RECIPIENT;
const configured = Boolean(
  databaseUrl
  && databaseSchema
  && secret
  && recipient,
);

test("the seeded Cedar unit loads through opaque locators and canonical checks", {
  skip: configured ? false : "local protocol database is not configured",
}, async () => {
  const moduleUrl = pathToFileURL(resolve(
    "apps/web/app/api/review/database.ts",
  )).href;
  const {
    loadDatabaseReview,
    loadDatabaseReviewMutationBasis,
  } = await import(moduleUrl) as Readonly<{
    loadDatabaseReview: (input: Readonly<{
      database: ProtocolDatabase;
      codec: ReviewLocatorCodec;
      expectedSubject: string;
      locators: ReviewLocators;
      session: ReviewSession;
    }>) => Promise<ReviewProjection>;
    loadDatabaseReviewMutationBasis: (input: Readonly<{
      database: ProtocolDatabase;
      codec: ReviewLocatorCodec;
      expectedSubject: string;
      locators: ReviewLocators;
      session: ReviewSession & { challengeId: string };
    }>) => Promise<Readonly<{
      version: number;
      digest: string;
      terminalDecision: "approve" | "decline" | null;
    }>>;
  }>;
  const database = new ProtocolDatabase({
    connectionString: databaseUrl!,
    schema: databaseSchema!,
    maxConnections: 2,
  });
  try {
    const codec = new ReviewLocatorCodec(secret!);
    const review = await loadDatabaseReview({
      database,
      codec,
      expectedSubject: new AccessSessionCodec(secret!).subject(
        recipient!,
        "client-approver",
      ),
      locators: {
        projectLocator: codec.project(
          "demo-workspace",
          "cedar-roastery",
        ),
        requestLocator: codec.request(
          "demo-workspace",
          "cedar-roastery",
          "packet-review",
        ),
        unitLocator: codec.unit(
          "demo-workspace",
          "cedar-roastery",
          "packet-review",
          "unit-u1",
        ),
      },
      session: {
        role: "client-approver",
        subject: new AccessSessionCodec(secret!).subject(
          recipient!,
          "client-approver",
        ),
      },
    });
    assert.equal(review.unit.title, "One populated case-study page");
    assert.equal(review.unit.version, 2);
    assert.equal(review.unit.scope.length, 1);
    assert.equal(review.attribution.sources.length, 1);
    assert.equal(review.history.previousVersionCount, 1);
    const actionParts = review.actions.endpoint.split("/");
    const actionLocators = {
      projectLocator: actionParts.at(-3)!,
      requestLocator: actionParts.at(-2)!,
      unitLocator: actionParts.at(-1)!,
    };
    const mutationBasis = await loadDatabaseReviewMutationBasis({
      database,
      codec,
      expectedSubject: new AccessSessionCodec(secret!).subject(
        recipient!,
        "client-approver",
      ),
      locators: actionLocators,
      session: {
        role: "client-approver",
        subject: new AccessSessionCodec(secret!).subject(
          recipient!,
          "client-approver",
        ),
        challengeId: "00000000-0000-4000-8000-000000000001",
      },
    });
    assert.equal(mutationBasis.version, review.unit.version);

    const oldVersion = await database.transaction(
      async (transaction) => (await sql<{ digest: string }>`
        select digest from unit_versions
        where workspace_id = 'demo-workspace'
          and project_id = 'cedar-roastery'
          and unit_id = 'unit-u1'
          and version = 1
      `.execute(transaction)).rows[0],
    );
    assert.ok(oldVersion);
    await assert.rejects(
      loadDatabaseReviewMutationBasis({
        database,
        codec,
        expectedSubject: new AccessSessionCodec(secret!).subject(
          recipient!,
          "client-approver",
        ),
        locators: {
          projectLocator: actionLocators.projectLocator,
          requestLocator: actionLocators.requestLocator,
          unitLocator: codec.mutationUnit(
            "demo-workspace",
            "cedar-roastery",
            "packet-review",
            "unit-u1",
            1,
            oldVersion.digest,
          ),
        },
        session: {
          role: "client-approver",
          subject: new AccessSessionCodec(secret!).subject(
            recipient!,
            "client-approver",
          ),
          challengeId: "00000000-0000-4000-8000-000000000001",
        },
      }),
      (error: unknown) =>
        error instanceof ReviewLoadError
        && error.code === "STALE_RECORD",
    );
    const serialized = JSON.stringify(review);
    for (const privateValue of [
      "cedar-approver",
      "cedar-sow",
      "cedar-baseline",
      "unit-u1",
      "packet-review",
      "merchantId",
      "digest",
      "order_id",
      "capture_id",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    await database.close();
  }
});
