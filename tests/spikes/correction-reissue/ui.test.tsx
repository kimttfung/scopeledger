import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReviewSurface,
  type ReviewStyles,
} from "../../../apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-surface.js";
import { reviewFixture } from "../dynamic-client-review/fixtures.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as ReviewStyles;

test("reissued review renders carried correction context, exact differences, and prior lineage", () => {
  const review = {
    ...reviewFixture,
    unit: {
      ...reviewFixture.unit,
      version: 3,
      scope: ["One corrected populated case-study page."],
    },
    reissue: {
      previousVersion: 2,
      correctionContexts: [{
        statement: "The signed agreement includes the populated page.",
        claimedSourceType: "Signed agreement",
        sourceAvailability: "available" as const,
        providerResponse:
          "The current unit requires corrected terms and fresh consent.",
        sourceReview: "The signed agreement changes the current scope.",
        responseRevision: 1,
        assessedAt: "2026-11-12T10:00:00.000Z",
      }],
      differences: [{
        field: "Included scope",
        before: [
          "One populated case-study page using the included reusable layout",
        ],
        current: ["One corrected populated case-study page."],
      }, {
        field: "Commercial terms",
        before: ["Total: USD 300.00"],
        current: ["Total: USD 275.00"],
      }],
    },
    facts: {
      ...reviewFixture.facts,
      decision: {
        status: "not-recorded" as const,
        version: 3,
        recordedAt: null,
      },
      payment: {
        status: "not-authorized" as const,
        verifiedAt: null,
      },
      readiness: "review-hold" as const,
      acceptedVersion: 2,
      holds: [{ reason: "correction" }],
    },
    history: {
      previousVersionCount: 2,
      previousVersions: [{
        version: 2,
        publishedAt: "2026-11-10T12:00:00.000Z",
        decision: {
          status: "approved" as const,
          recordedAt: "2026-11-10T13:00:00.000Z",
        },
        obligation: {
          currency: "USD" as const,
          gross: "300.00",
          collectionStatus: "active" as const,
          paymentStatus: "verified" as const,
          verifiedAt: "2026-11-10T14:00:00.000Z",
        },
      }, ...reviewFixture.history.previousVersions],
      additionalPreviousVersions: 0,
    },
    actions: {
      ...reviewFixture.actions,
      decision: {
        available: true,
        responseAcknowledgementCount: 1,
      },
    },
  };

  const html = renderToStaticMarkup(
    <ReviewSurface review={review} styles={styles} />,
  );
  for (const expected of [
    "Correction context and exact version changes",
    "Version 2 remains immutable",
    "prior decision is not reused",
    "The signed agreement includes the populated page",
    "The signed agreement changes the current scope",
    "requires corrected terms and fresh consent",
    "Before · version 2",
    "Current · version 3",
    "One corrected populated case-study page",
    "Total: USD 275.00",
    "Historical obligation",
    "$300.00",
    "still active",
    "Payment verified",
    "fresh explicit decision",
  ]) {
    assert.match(html, new RegExp(expected.replaceAll("$", "\\$"), "u"));
  }
});

