import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readCapturedEmail } from "../../../lib/mailpit-message";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Local email preview | ScopeLedger",
  description: "Sanitized rendering of a local ScopeLedger demo email.",
  robots: { index: false, follow: false },
};

export default async function EmailPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let message;
  try {
    message = await readCapturedEmail(
      process.env.EMAIL_MAILPIT_API ?? "http://127.0.0.1:8025",
      id,
    );
  } catch {
    notFound();
  }
  return (
    <>
      <a className="skip-link" href="#email-preview-main">
        Skip to email preview
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Local email preview</span>
          <span className="prototype-label">Sanitized HTML</span>
          <span className="role-label">Mailpit message</span>
        </div>
      </header>
      <div className="prototype-notice">
        Rendered by ScopeLedger because the embedded Mailpit HTML iframe may be
        unavailable in this browser surface.
      </div>
      <main className="payment-return-shell" id="email-preview-main">
        <section
          className="payment-return-panel"
          aria-labelledby="email-preview-title"
        >
          <h1 id="email-preview-title">{message.subject}</h1>
          <div
            className="email-preview-content"
            dangerouslySetInnerHTML={{ __html: message.html }}
          />
          <div className="payment-return-status">
            <strong>Local preview only</strong>
            <p>
              HTML is sanitized and links are disabled. The original source,
              headers, text and raw MIME remain available in Mailpit.
            </p>
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/access-demo">
              Return to access verification
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
