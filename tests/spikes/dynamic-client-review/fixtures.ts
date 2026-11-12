import type {
  ReviewProjection,
} from "../../../apps/web/app/api/review/service.js";
import {
  ReviewLocatorCodec,
} from "../../../apps/web/app/api/review/service.js";

export const locatorSecret = "11".repeat(32);
const codec = new ReviewLocatorCodec(locatorSecret);
const projectLocator = codec.project("workspace-one", "project-one");
const requestLocator = codec.request(
  "workspace-one",
  "project-one",
  "request-one",
);

export const reviewFixture: ReviewProjection = {
  project: { label: "Cedar Roastery website" },
  request: { label: "Case-study request" },
  unit: {
    title: "One populated case-study page",
    version: 2,
    publishedAt: "2026-11-10T12:00:00.000Z",
    treatment: "payable",
    approverCondition:
      "Named project approver with explicit authority attestation",
    scope: [
      "One populated case-study page using the included reusable layout",
    ],
    exclusions: [
      "No custom photography",
      "No additional pages",
      "No general site redesign",
    ],
    rationale:
      "Provider reviewed the client context and removed the included layout from the payable unit.",
    timing: {
      description:
        "Five working days after approval, full completed payment, and receipt of required content",
      deliveryDependencies: [
        "The included reusable layout precedes final page delivery",
      ],
    },
    dependencies: [],
    prerequisites: [],
  },
  commercial: {
    kind: "payable",
    policy: "full-prepayment",
    currency: "USD",
    lines: [{
      description: "One populated case-study page",
      quantity: "1",
      unitPrice: "300.00",
      amount: "300.00",
    }],
    subtotal: "300.00",
    tax: {
      treatment: "none",
      amount: "0.00",
      declaration: "Provider-declared synthetic no tax added",
    },
    gross: "300.00",
  },
  attribution: {
    sources: [{
      label: "Published source 1",
      version: 1,
      availability: "available",
      origin: "Agreement",
      coverage: "Available in the published review basis",
    }],
    baselines: [{
      label: "Confirmed baseline 1",
      version: 1,
      coverage: "Confirmed published baseline",
    }],
  },
  facts: {
    decision: {
      status: "approved",
      version: 2,
      recordedAt: "2026-11-10T13:00:00.000Z",
    },
    payment: {
      status: "verified",
      verifiedAt: "2026-11-10T14:00:00.000Z",
    },
    readiness: "ready",
    acceptedVersion: 2,
    holds: [],
    workStart: {
      recorded: false,
      version: null,
      recordedAt: null,
    },
  },
  history: {
    previousVersionCount: 1,
    previousVersions: [{
      version: 1,
      publishedAt: "2026-11-09T12:00:00.000Z",
    }],
    additionalPreviousVersions: 0,
  },
  actions: {
    endpoint: [
      "/api/review",
      projectLocator,
      requestLocator,
      codec.mutationUnit(
        "workspace-one",
        "project-one",
        "request-one",
        "unit-one",
        2,
        "a".repeat(64),
      ),
    ].join("/"),
    decision: {
      available: false,
      responseAcknowledgementCount: 0,
    },
    question: { available: true },
    correction: { available: true },
    payment: { available: false, url: null },
  },
};
