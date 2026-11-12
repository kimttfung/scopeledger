import type { Metadata } from "next";
import Link from "next/link";
import AccessDemo from "./access-demo";

export const metadata: Metadata = {
  title: "Local access verification | ScopeLedger",
  description: "Local-only client and payer channel verification demo.",
  robots: { index: false, follow: false },
};

export default function AccessDemoPage() {
  return (
    <>
      <a className="skip-link" href="#access-demo-main">
        Skip to local access verification
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Local verification</span>
          <span className="prototype-label">Mailpit demo</span>
          <span className="role-label">Client / payer</span>
        </div>
      </header>
      <div className="prototype-notice">
        Local demonstration only. No email leaves this computer.
      </div>
      <main className="payment-return-shell" id="access-demo-main">
        <section
          className="payment-return-panel"
          aria-labelledby="access-demo-title"
        >
          <h1 id="access-demo-title">Verify a local participant channel</h1>
          <p className="payment-return-copy">
            Send a short-lived code to the private Mailpit inbox, then verify
            control of the client-approver or payer test channel.
          </p>
          <AccessDemo />
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
