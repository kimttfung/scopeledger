import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { verifiedProvider } from "../../api/analysis/provider-api";
import {
  listProviderParticipants,
} from "../../api/provider/participants/runtime";
import ParticipantRegister from "./participant-register";
import styles from "./participants.module.css";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Participant authority | ScopeLedger",
  description:
    "Protected provider lifecycle controls for project approvers and obligation payers.",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

function Unavailable({
  title,
  message,
}: Readonly<{
  title: string;
  message: string;
}>) {
  return (
    <>
      <a className="skip-link" href="#participant-main">
        Skip to participant authority
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Participant authority</span>
          <span className="role-label">Provider</span>
        </div>
      </header>
      <main className="payment-return-shell" id="participant-main">
        <section className="payment-return-panel">
          <h1>{title}</h1>
          <div className="payment-return-status" role="status">
            <strong>Protected lifecycle unavailable</strong>
            <p>{message}</p>
          </div>
          <div className="payment-return-actions">
            <Link className="button" href="/provider">
              Return to provider workspace
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}

export default async function ProviderParticipantsPage() {
  const access = await verifiedProvider();
  if (!access.ok) {
    if (access.code === "AUTHENTICATION_REQUIRED") {
      redirect("/auth/login?returnTo=/provider/participants");
    }
    return (
      <Unavailable
        title="Participant authority is unavailable"
        message={access.message}
      />
    );
  }
  let participants;
  try {
    participants = await listProviderParticipants();
  } catch {
    return (
      <Unavailable
        title="Participant authority is unavailable"
        message="Current provider-authorized projects and approved obligations could not be loaded."
      />
    );
  }
  return (
    <>
      <div
        aria-hidden="true"
        dangerouslySetInnerHTML={{
          __html: `<!--
THESIS: Participant authority is a current-state register with protected previews, not a people directory or editable permissions matrix.
OWN-WORLD: Cool-white studio surfaces, fine rules, restrained cobalt actions, and aligned status rows with no decorative elevation.
STORY: The provider scans project approvers and approved-obligation payers, previews one prospective authority change, then explicitly confirms it.
FIRST VIEWPORT: A concise authority explanation leads directly into the approver register; approved obligations follow in the same ruled ledger.
FORM: Established Studio Standards extended as a two-register operations surface; no new visual world or staging seed.
-->`,
        }}
      />
      <a className="skip-link" href="#participant-main">
        Skip to participant authority
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/">
            ScopeLedger<span className="wordmark-dot">.</span>
          </Link>
          <span className="studio-name">Provider workspace</span>
          <span className="prototype-label">Participant authority</span>
          <span className="role-label">Verified provider</span>
        </div>
      </header>
      <div className="prototype-notice">
        <p>
          Verified identity opens this register. Every preview and confirmation
          independently requires the current server-side provider grant.
        </p>
        <Link href="/provider">Provider access</Link>
      </div>
      <main className={styles.main} id="participant-main">
        <section className={styles.intro} aria-labelledby="participant-title">
          <div>
            <h1 id="participant-title">Participant authority register</h1>
            <p>
              Revoke prospective authority immediately or restore the fixed
              local demo participant under a fresh epoch. Historical decisions,
              captures, and attribution remain immutable.
            </p>
          </div>
          <aside className={styles.boundary}>
            <strong>Preview before confirmation</strong>
            The browser sends only opaque selectors. Actor identities, grants,
            epochs, project records, obligations, and timestamps remain
            server-owned.
          </aside>
        </section>
        <ParticipantRegister initialParticipants={participants} />
      </main>
    </>
  );
}
