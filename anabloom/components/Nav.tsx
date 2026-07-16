"use client";

import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/ledger", label: "Ledger" },
  { href: "/properties", label: "Properties" },
  { href: "/tenants", label: "Tenants & Leases" },
  { href: "/reports", label: "Reports" },
  { href: "/assets", label: "Fixed Assets" },
  { href: "/reconciliation", label: "Bank Rec" },
  { href: "/accounts", label: "Accounts" },
  { href: "/settings", label: "Settings" },
];

export default function Nav({ name }: { name: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="no-print bg-primary text-white sticky top-0 z-20">
      <div className="mx-auto max-w-6xl px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-2">
          <Link href="/" className="text-xl font-bold">
            Anabloom
          </Link>
        </div>
        <nav className="hidden lg:flex items-center gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm ${active(l.href) ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-sm text-white/80">{name}</span>
          <button onClick={() => signOut({ callbackUrl: "/login" })} className="text-sm hover:underline">
            Sign out
          </button>
          <button className="lg:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="lg:hidden border-t border-white/20 px-4 py-2 flex flex-col gap-1">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={`px-3 py-2 rounded-md text-sm ${active(l.href) ? "bg-white/20 font-semibold" : ""}`}>
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
