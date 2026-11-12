import { RecordsExportError } from "./errors.js";
import { validateRecordExportV1 } from "./schema.js";
import { DEFAULT_EXPORT_LIMITS } from "./types.js";
import type { ExportLimits, RecordExportV1 } from "./types.js";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function renderInstant(value: string | null): string {
  if (value === null) return "<span>Timestamp unavailable</span>";
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>`;
}

function renderValue(value: unknown, key = ""): string {
  if (value === null) return "<span>Not recorded</span>";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return escapeHtml(String(value));
  if (typeof value === "string") {
    if (/At$/.test(key) && Number.isFinite(new Date(value).getTime())) {
      return renderInstant(value);
    }
    return escapeHtml(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "<span>None recorded</span>";
    return `<ul>${value.map((item) =>
      `<li>${renderValue(item)}</li>`).join("")}</ul>`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([name]) =>
        !["recordRef", "occurredAt", "attribution"].includes(name));
    if (entries.length === 0) return "<span>No additional fields</span>";
    return `<dl class="fact-fields">${entries.map(([name, child]) =>
      `<div><dt>${escapeHtml(humanize(name))}</dt><dd>${renderValue(
        child,
        name,
      )}</dd></div>`).join("")}</dl>`;
  }
  throw new RecordsExportError(
    "INVALID_RECORD",
    "HTML renderer received an unsupported record value",
  );
}

function renderFactSection(
  name: string,
  facts: readonly Record<string, unknown>[],
): string {
  const sectionId = `facts-${name.replace(/[A-Z]/g, (value) =>
    `-${value.toLowerCase()}`)}`;
  const title = humanize(name);
  return `<section aria-labelledby="${sectionId}"><h2 id="${sectionId}">${escapeHtml(
    title,
  )}</h2>${facts.length === 0
    ? "<p>No supported facts recorded.</p>"
    : `<ol class="fact-list">${facts.map((fact) =>
      `<li><article><h3><code>${escapeHtml(
        String(fact.recordRef),
      )}</code></h3><p><strong>Occurred:</strong> ${renderInstant(
        typeof fact.occurredAt === "string" ? fact.occurredAt : null,
      )}</p><p><strong>Attribution:</strong> ${escapeHtml(
        String(fact.attribution),
      )}</p>${renderValue(fact)}</article></li>`).join("")}</ol>`}</section>`;
}

export function renderRecordExportHtml(
  document: RecordExportV1,
  options: { limits?: Partial<ExportLimits> } = {},
): string {
  validateRecordExportV1(document);
  const maxHtmlBytes =
    options.limits?.maxHtmlBytes ?? DEFAULT_EXPORT_LIMITS.maxHtmlBytes;
  if (
    !Number.isSafeInteger(maxHtmlBytes)
    || maxHtmlBytes < 1
    || maxHtmlBytes > 32_000_000
  ) {
    throw new RecordsExportError(
      "BOUND_EXCEEDED",
      "HTML byte limit is invalid",
    );
  }

  const factSections = Object.entries(document.facts)
    .map(([name, facts]) =>
      renderFactSection(name, facts as readonly Record<string, unknown>[]))
    .join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(document.labels.title)} — ${escapeHtml(document.project.displayName)}</title>
<style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.45;color:CanvasText;background:Canvas}
body{margin:0 auto;max-width:76rem;padding:2rem}
header,section,footer{margin-block:0 2rem}
h1,h2,h3{line-height:1.2}
h2{border-bottom:2px solid CanvasText;padding-bottom:.35rem}
.notices{border:2px solid CanvasText;padding:1rem}
.timeline,.fact-list{padding-left:1.5rem}
.timeline li,.fact-list li{break-inside:avoid;margin-block:.75rem}
article{border:1px solid GrayText;padding:1rem}
.fact-fields{margin:0}
.fact-fields div{display:grid;grid-template-columns:minmax(10rem,16rem) 1fr;gap:1rem;border-top:1px solid ButtonBorder;padding:.4rem 0}
dt{font-weight:700}
dd{margin:0;overflow-wrap:anywhere}
code{overflow-wrap:anywhere}
table{border-collapse:collapse;width:100%}
caption{text-align:left;font-weight:700;margin-bottom:.5rem}
th,td{border:1px solid GrayText;padding:.5rem;text-align:left;vertical-align:top}
@media print{body{max-width:none;padding:.25in}a{color:inherit}.notices,article{break-inside:avoid}h2{break-after:avoid}}
@media (max-width:40rem){body{padding:1rem}.fact-fields div{display:block}.fact-fields dd{margin-top:.25rem}}
</style>
</head>
<body>
<header>
<p>ScopeLedger export contract <code>${escapeHtml(document.schemaVersion)}</code></p>
<h1>${escapeHtml(document.project.displayName)}</h1>
<dl>
<div><dt>Project record reference</dt><dd><code>${escapeHtml(document.project.recordRef)}</code></dd></div>
<div><dt>Project created</dt><dd>${renderInstant(document.project.createdAt)}</dd></div>
<div><dt>Attribution</dt><dd>${escapeHtml(document.project.attribution)}</dd></div>
</dl>
<aside class="notices" aria-labelledby="record-notices">
<h2 id="record-notices">Important export labels</h2>
<ul>${document.labels.notices.map((notice) =>
    `<li>${escapeHtml(notice)}</li>`).join("")}</ul>
</aside>
</header>
<main>
<section aria-labelledby="history-heading">
<h2 id="history-heading">Chronological history</h2>
${document.timeline.length === 0
    ? "<p>No timestamped facts recorded.</p>"
    : `<table><caption>Chronological attributed facts</caption><thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Attribution</th><th scope="col">Summary</th><th scope="col">Record</th></tr></thead><tbody>${document.timeline.map((item) =>
      `<tr><td>${renderInstant(item.occurredAt)}</td><td>${escapeHtml(
        humanize(item.kind),
      )}</td><td>${escapeHtml(item.attribution)}</td><td>${escapeHtml(
        item.summary,
      )}</td><td><code>${escapeHtml(item.recordRef)}</code></td></tr>`).join("")}</tbody></table>`}
</section>
${factSections}
<section aria-labelledby="gaps-heading">
<h2 id="gaps-heading">Unavailable, redacted, and unsupported gaps</h2>
${document.gaps.length === 0
    ? "<p>No gaps recorded.</p>"
    : `<table><caption>Known export gaps</caption><thead><tr><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Reason</th><th scope="col">Record</th></tr></thead><tbody>${document.gaps.map((gap) =>
      `<tr><td>${escapeHtml(humanize(gap.category))}</td><td>${escapeHtml(
        gap.status,
      )}</td><td>${escapeHtml(gap.reason)}</td><td><code>${escapeHtml(
        gap.recordRef,
      )}</code></td></tr>`).join("")}</tbody></table>`}
</section>
</main>
<footer>
<p>Delivery facts: unsupported. Delivery acceptance facts: unsupported.</p>
</footer>
</body>
</html>`;
  if (Buffer.byteLength(html, "utf8") > maxHtmlBytes) {
    throw new RecordsExportError(
      "OUTPUT_TOO_LARGE",
      "Standalone HTML exceeds the configured byte bound",
    );
  }
  return html;
}
