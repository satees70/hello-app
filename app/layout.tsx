import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { appForHost } from "@/lib/appIdentity";
import OfflineReady from "@/components/OfflineReady";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Per-subdomain metadata so the installed app (esp. iOS "Add to Home Screen") gets the right
// name and icon — Warehouse, Production, HR, Driver or Import.
export async function generateMetadata(): Promise<Metadata> {
  const app = appForHost((await headers()).get("host"));
  return {
    title: app.name,
    description: "SRRI EASWARI MILLS",
    manifest: "/manifest.webmanifest",
    appleWebApp: { capable: true, title: app.short, statusBarStyle: "default" },
    icons: { apple: app.icon, icon: app.icon },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",   // use the full screen on notched iPhones
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}<OfflineReady /></body>
    </html>
  );
}
