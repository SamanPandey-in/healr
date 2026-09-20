import Link from "next/link";
import type { ReactNode } from "react";

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <span className="brand-mark" />
        <span>Self-Healing Infra</span>
      </Link>
      <div className="topbar-right">{children}</div>
    </header>
  );
}
