import type { ReactNode } from 'react';

/** Kiosk chrome: full-screen, no back-office sidebar — a POS terminal is its own device/session. */
export default function PosLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-slate-100">{children}</main>;
}
