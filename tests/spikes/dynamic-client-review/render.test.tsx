import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ReviewSurface,
  type ReviewStyles,
} from "../../../apps/web/app/review/[projectLocator]/[requestLocator]/[unitLocator]/review-surface.js";
import { reviewFixture } from "./fixtures.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as ReviewStyles;

test("the generic review renders exact terms, attribution, facts, and history", () => {
  const html = renderToStaticMarkup(
    <ReviewSurface review={reviewFixture} styles={styles} />,
  );
  for (const expected of [
    "Cedar Roastery website",
    "Case-study request",
    "One populated case-study page",
    "Version 2",
    "Additional payable work",
    "One populated case-study page using the included reusable layout",
    "No custom photography",
    "removed the included layout from the payable unit",
    "$300.00",
    "Provider-declared synthetic no tax added",
    "Full prepayment after approval",
    "Published source 1",
    "Available in the published review basis",
    "Confirmed baseline 1",
    "Approved",
    "Payment verified",
    "Ready for additional work",
    "Not recorded",
    "Historical-version disclosure",
    "Version 1",
    "Record your response",
    "A terminal decision is already recorded",
    "Ask a question",
    "Submit a context correction",
    "Payment remains separate",
    "Start or reconcile payment · unavailable",
  ]) {
    assert.match(html, new RegExp(expected.replaceAll("$", "\\$")));
  }
  assert.match(html, /<main/);
  assert.match(html, /<nav[^>]+aria-label="Review sections"/);
  assert.match(html, /<table>/);
  assert.match(html, /<th scope="row"/);
});

test("an undecided review renders preview-first accessible mutation controls", () => {
  const review = {
    ...reviewFixture,
    facts: {
      ...reviewFixture.facts,
      decision: {
        status: "not-recorded" as const,
        version: 2,
        recordedAt: null,
      },
      payment: {
        status: "not-authorized" as const,
        verifiedAt: null,
      },
      readiness: "awaiting-agreement" as const,
      acceptedVersion: null,
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
    "Required acknowledgements",
    "I reviewed version 2",
    "I am authorized to decide",
    "1 current correction response",
    "Preview approval",
    "Preview decline",
    "Approval may create an obligation",
    "Ask a question",
    "Submit a context correction",
  ]) {
    assert.match(html, new RegExp(expected));
  }
  assert.match(html, /type="checkbox"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(
    html,
    /<button[^>]*>[^<]*(?:Start payment|Pay now|Checkout)/i,
  );
});

test("rendering omits private identities, locators, digests, and provider details", () => {
  const privateValues = [
    "cedar-approver",
    "/private/storage/cedar.pdf",
    "a".repeat(64),
    "PAYPAL-CAPTURE-ID",
    "PAYPAL-ORDER-ID",
    "provider private note",
  ];
  const html = renderToStaticMarkup(
    <ReviewSurface review={reviewFixture} styles={styles} />,
  );
  for (const value of privateValues) assert.equal(html.includes(value), false);
});
