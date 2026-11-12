import Link from "next/link";

type PaymentReturnShellProps = {
  kind: "return" | "cancel";
};

const content = {
  return: {
    title: "Back from PayPal",
    status: "Payment verification pending",
    description:
      "PayPal returned this browser to ScopeLedger. This redirect is not confirmation that payment completed.",
    detail:
      "ScopeLedger must verify the original Order and capture through its server-side payment worker before any payment condition or work readiness can change.",
  },
  cancel: {
    title: "PayPal approval was not completed here",
    status: "No payment result inferred",
    description:
      "Returning from or closing PayPal does not create, cancel, or complete a payment in ScopeLedger.",
    detail:
      "The original payment attempt must be checked server-side before another action is offered. No browser return can mark an agreement paid or ready.",
  },
} as const;

export default function PaymentReturnShell({
  kind,
}: PaymentReturnShellProps) {
  const copy = content[kind];

  return (
    <>
      <a className="skip-link" href="#payment-return-main">
        Skip to payment status
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Northstar Studio</span>
          <span className="prototype-label">Sandbox payment</span>
          <span className="role-label">Payer return</span>
        </div>
      </header>
      <div className="prototype-notice">
        Sandbox diagnostic only. This page does not record payment or authorize work.
      </div>
      <main className="payment-return-shell" id="payment-return-main">
        <section
          className="payment-return-panel"
          aria-labelledby="payment-return-title"
        >
          <h1 id="payment-return-title">{copy.title}</h1>
          <p className="payment-return-copy">{copy.description}</p>
          <div className="payment-return-status" role="status">
            <strong>{copy.status}</strong>
            <p>{copy.detail}</p>
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/">
              Return to request review
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
