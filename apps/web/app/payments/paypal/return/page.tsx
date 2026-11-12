import type { Metadata } from "next";
import PaymentReturnShell from "../payment-return-shell";

export const metadata: Metadata = {
  title: "Back from PayPal | ScopeLedger",
  description:
    "A sandbox payment return that requires server-side verification.",
  robots: { index: false, follow: false },
};

export default function PayPalReturnPage() {
  return <PaymentReturnShell kind="return" />;
}
