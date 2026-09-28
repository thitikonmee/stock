import type { Metadata } from 'next';
import { Noto_Sans_Thai } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const thai = Noto_Sans_Thai({ subsets: ['thai', 'latin'], variable: '--font-thai', display: 'swap' });

export const metadata: Metadata = {
  title: 'StockOS',
  description: 'ระบบสต็อก + POS + ขายหลายช่องทาง',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" className={thai.variable}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
