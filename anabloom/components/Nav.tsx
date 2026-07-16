"use client";

import { signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { setActiveCompanyAction } from "@/app/actions";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/ledger", label: "Ledger" },
  { href: "/properties", label: "Properties" },
  { href: "/tenants", label: "Tenants & Leases" },
  { href: "/reports", label: "Reports" },
  { href: "/suppliers", label: "Suppliers" },
  { href: "/bills", label: "Bills" },
  { href: "/assets", label: "Fixed Assets" },
  { href: "/reconciliation", label: "Bank Rec" },
  { href: "/accounts", label: "Accounts" },
  { href: "/settings", label: "Settings" },
];

interface Co {
  id: string;
  name: string;
}

export default function Nav({ name, activeCompany, companies }: { name: string; activeCompany: Co; companies: Co[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [coOpen, setCoOpen] = useState(false);
  const active = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <header className="no-print bg-primary text-white sticky top-0 z-20">
      <div className="mx-auto max-w-6xl px-4 flex items-center justify-between h-14">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-xl font-bold">
            Anabloom
          </Link>
          {/* Company switcher */}
          <div className="relative">
            <button onClick={() => setCoOpen(!coOpen)} className="flex items-center gap-1 rounded-md bg-white/15 px-2 py-1 text-sm hover:bg-white/25">
              <span className="max-w-[160px] truncate">{activeCompany.name}</span>
              <span className="text-xs">▾</span>
            </button>
            {coOpen && (
              <div className="absolute left-0 mt-1 w-64 rounded-md bg-white text-ink shadow-lg border border-line py-1 z-30">
                <div className="px-3 py-1 text-xs text-muted uppercase tracking-wide">Switch company</div>
                {companies.map((c) => (
                  <form key={c.id} action={setActiveCompanyAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <button className={`w-full text-left px-3 py-2 text-sm hover:bg-canvas ${c.id === activeCompany.id ? "font-semibold text-primary" : ""}`}>
                      {c.id === activeCompany.id ? "● " : "○ "}
                      {c.name}
                    </button>
                  </form>
                ))}
                <div className="border-t border-line mt-1 pt-1">
                  <Link href="/group" onClick={() => setCoOpen(false)} className="block px-3 py-2 text-sm hover:bg-canvas text-primary">
                    ⌂ Group overview
                  </Link>
                  <Link href="/settings" onClick={() => setCoOpen(false)} className="block px-3 py-2 text-sm hover:bg-canvas">
                    ＋ Manage companies
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
        <nav className="hidden xl:flex items-center gap-1">
          <Link href="/group" className={`px-3 py-1.5 rounded-md text-sm border border-white/40 ${active("/group") ? "bg-white text-primary font-semibold" : "hover:bg-white/10"}`}>
            Group
          </Link>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={`px-3 py-1.5 rounded-md text-sm ${active(l.href) ? "bg-white/20 font-semibold" : "hover:bg-white/10"}`}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-sm text-white/80">{name}</span>
          <button onClick={() => signOut({ callbackUrl: "/login" })} className="text-sm hover:underline">
            Sign out
          </button>
          <button className="xl:hidden" onClick={() => setOpen(!open)} aria-label="Menu">
            ☰
          </button>
        </div>
      </div>
      {open && (
        <nav className="xl:hidden border-t border-white/20 px-4 py-2 flex flex-col gap-1">
          <Link href="/group" onClick={() => setOpen(false)} className={`px-3 py-2 rounded-md text-sm ${active("/group") ? "bg-white/20 font-semibold" : ""}`}>
            Group overview
          </Link>
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
