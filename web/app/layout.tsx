import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Self-Healing Infra — Live Demo",
  description: "Trigger a real incident, watch AI diagnose it, approve the fix, and see it heal.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
