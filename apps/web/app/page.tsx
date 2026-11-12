import ReviewRequest from "./review-request";

const directionContract = `<!--
THESIS: A client understands the corrected scope before deciding; no invoice dashboard.
OWN-WORLD: Studio Standards. Cool white, ink, cobalt indices, fine rules, readable system sans, tabular amounts, equal-weight decisions.
STORY: The supplied promise establishes existing inclusion; only the populated page remains proposed. No prototype action records consent or moves money.
FIRST VIEWPORT: A compact studio header and section index lead to the request, included work, and a concise before/context/current summary. Exact terms, attributed evidence, and the decision follow vertically.
FORM: Grounded direction 4, seed 3c1eccd6. User-approved composition B, with C's compact comparison. Review-before-commit staging uses explicit previews, never optimistic financial facts.
-->`;

export default function Page() {
  return (
    <>
      <div hidden dangerouslySetInnerHTML={{ __html: directionContract }} />
      <ReviewRequest />
    </>
  );
}
