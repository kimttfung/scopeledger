import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Review this request | ScopeLedger",
  description:
    "A synthetic client-review prototype. No decisions are recorded and no payments are initiated.",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
