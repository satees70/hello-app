import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anabloom — Property Accounting",
  description: "Simple double-entry accounting for property management.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
