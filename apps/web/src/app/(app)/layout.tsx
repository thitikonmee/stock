import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { COOKIES } from '@/lib/server/session';

/** Signed-in area. Without a refresh cookie there is no session to resume. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const jar = await cookies();
  if (!jar.get(COOKIES.refresh)) redirect('/login');
  return <Shell>{children}</Shell>;
}
