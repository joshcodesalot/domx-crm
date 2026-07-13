import { type ReactNode } from 'react';
import Sidebar from '@/components/Sidebar';

interface AppLayoutProps {
  title: string;
  activePage?: 'dashboard' | 'analytics' | 'creators' | 'staff';
  children: ReactNode;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function AppLayout({
  title,
  activePage = 'dashboard',
  children,
}: AppLayoutProps) {
  return (
    <div className="bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 min-h-screen flex antialiased">
      <Sidebar activePage={activePage} />

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-16 border-b border-gray-200 dark:border-white/10 flex items-center justify-between px-8">
          <h1 className="text-sm font-medium text-gray-500 dark:text-gray-400">
            {title}
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 px-3 py-1 bg-gray-100 dark:bg-white/5 rounded-full">
              {formatDate(new Date())}
            </span>
          </div>
        </header>

        <div className="p-8 overflow-y-auto flex-1">{children}</div>
      </main>
    </div>
  );
}
