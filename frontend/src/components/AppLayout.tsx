import { type ReactNode } from 'react';
import AppShell from '@/components/AppShell';
import type { SidebarPage } from '@/components/Sidebar';

interface AppLayoutProps {
  title: string;
  activePage?: SidebarPage;
  children: ReactNode;
}

export default function AppLayout({
  title,
  activePage = 'dashboard',
  children,
}: AppLayoutProps) {
  return (
    <AppShell title={title} activePage={activePage}>
      {children}
    </AppShell>
  );
}
