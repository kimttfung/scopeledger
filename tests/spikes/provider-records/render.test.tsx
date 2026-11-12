import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProviderRecordsIndex,
  ProviderRecordView,
  type ProviderRecordsStyles,
} from "../../../apps/web/app/provider/records/records-surface.js";
import { recordDocument } from "./fixtures.js";

const styles = new Proxy({}, {
  get: (_target, property) => String(property),
}) as ProviderRecordsStyles;

test("project register renders only opaque selectors and safe display labels", () => {
  const html = renderToStaticMarkup(
    <ProviderRecordsIndex projects={[{
      projectLocator: `slr1h_${"a".repeat(43)}`,
      displayName: "<script>alert('unsafe')</script>",
    }]} styles={styles} />,
  );
  assert.match(html, /Projects available to this grant/u);
  assert.match(html, /View project record/u);
  assert.match(html, /&lt;script&gt;alert/u);
  assert.doesNotMatch(html, /<script>alert/u);
  assert.doesNotMatch(html, /inaccessible|total projects/iu);
});

test("project record renders history, gaps, disclaimers, downloads, and print", () => {
  const html = renderToStaticMarkup(
    <ProviderRecordView
      projectLocator={`slr1h_${"b".repeat(43)}`}
      record={recordDocument}
      styles={styles}
    />,
  );
  for (const expected of [
    "Cedar Roastery website",
    "Chronological history",
    "Case-study request",
    "Private provider-note content is not included",
    "This record is not a legal opinion.",
    "This record is not a delivery receipt.",
    "This record is not a dispute submission.",
    "This record is not proof of satisfactory delivery.",
    "Download JSON",
    "Download HTML",
    "Print project record",
    "Delivery facts",
    "Unsupported",
  ]) {
    assert.match(html, new RegExp(expected.replaceAll(".", "\\."), "u"));
  }
  assert.match(html, /<nav[^>]+aria-label="Project record sections"/u);
  assert.match(html, /<table>/u);
  assert.match(html, /<th scope="col"/u);
});

test("React rendering escapes export text and does not invent hidden fields", () => {
  const malicious = {
    ...recordDocument,
    project: {
      ...recordDocument.project,
      displayName: "<img src=x onerror=alert(1)>",
    },
    timeline: [{
      ...recordDocument.timeline[0],
      summary: "</td><script>alert('history')</script>",
    }],
  };
  const html = renderToStaticMarkup(
    <ProviderRecordView
      projectLocator={`slr1h_${"c".repeat(43)}`}
      record={malicious}
      styles={styles}
    />,
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.match(html, /&lt;\/td&gt;&lt;script&gt;alert/u);
  assert.doesNotMatch(html, /<script>alert|<img src=x/iu);
  assert.doesNotMatch(
    html,
    /actorId|grantEpoch|sessionId|storagePath|contentDigest/iu,
  );
});
