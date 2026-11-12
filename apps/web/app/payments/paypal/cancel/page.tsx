import type { Metadata } from "next";
import PaymentReturnShell from "../payment-return-shell";

export const metadata: Metadata = {
  title: "PayPal approval not completed | ScopeLedger",
  description:
    "A sandbox cancellation return that does not infer a payment result.",
  robots: { index: false, follow: false },
};

export default function PayPalCancelPage() {
  return <PaymentReturnShell kind="cancel" />;
}
