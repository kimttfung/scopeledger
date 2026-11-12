import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReviewSurface } from "../../../apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-surface.js";
import { reviewFixture } from "../dynamic-client-review/fixtures.js";

const styles = new Proxy<Record<string, string>>({}, {
  get: (_target, property) => String(property),
});

test("dynamic review renders the private draft boundary without commercial claims", () => {
  const html = renderToStaticMarkup(
    <ReviewSurface review={reviewFixture} styles={styles} />,
  );
  assert.match(html, /Save a private server draft for recovery in another browser/);
  assert.match(html, /Drafts expire after seven inactive days/);
  assert.match(html, /create no submission, hold, notification, model call/);
  assert.match(html, /Payment remains separate/);
  assert.doesNotMatch(html, /draftDigest|participantSubjectDigest|actorId|email/i);
});

test("interactive draft controls recover, save, delete, and submit exact revisions", async () => {
  const source = await readFile(
    "apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-actions.tsx",
    "utf8",
  );
  for (const expected of [
    "Recover server draft",
    "Save private draft",
    "Delete saved draft",
    "seven-day inactivity expiry was refreshed",
    "draftRevision: draft.revision",
    "sourceText: normalizedSource",
    "credentials: \"same-origin\"",
    "cache: \"no-store\"",
  ]) {
    assert.match(source, new RegExp(expected));
  }
  assert.doesNotMatch(source, /maxLength=/);
  assert.doesNotMatch(
    source,
    /JSON\.stringify\([^)]*(participantSubjectDigest|actorId|draftDigest|email)/s,
  );
});
