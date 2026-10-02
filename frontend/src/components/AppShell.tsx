import { type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import Sidebar, { type SidebarPage } from '@/components/Sidebar';
import { useShell } from '@/context/ShellContext';

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface AppShellProps {
  title: string;
  activePage?: SidebarPage;
  headerExtras?: ReactNode;
  bleed?: boolean;
  children: ReactNode;
}

export default function AppShell({
  title,
  activePage = 'dashboard',
  headerExtras,
  bleed = false,
  children,
}: AppShellProps) {
  const { mobileOpen, toggleSidebar, closeMobileSidebar, closeWorkspacePanels } = useShell();

  return (
    <div className="bg-white dark:bg-[#0a0a0a] text-gray-900 dark:text-gray-100 h-screen flex antialiased overflow-hidden">
      <div
        className={`fixed inset-0 bg-gray-900/60 dark:bg-black/80 z-40 backdrop-blur-sm md:hidden ${
          mobileOpen ? '' : 'hidden'
        }`}
        onClick={closeMobileSidebar}
      />
      <Sidebar activePage={activePage} />
      <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <header className="h-16 shrink-0 border-b border-gray-200 dark:border-white/10 flex items-center justify-between gap-3 px-4 sm:px-6 md:px-8 bg-white/90 dark:bg-[#0a0a0a]/90 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={toggleSidebar}
              className="p-2 -ml-2 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:hover:text-white dark:hover:bg-white/5"
              aria-label="Toggle navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-sm font-semibold text-gray-900 dark:text-white border-l border-gray-200 dark:border-white/10 pl-3 truncate">
              {title}
            </h1>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {headerExtras}
            <span className="hidden sm:inline-flex text-xs text-gray-400 px-3 py-1 bg-gray-100 dark:bg-white/5 rounded-full">
              {formatDate(new Date())}
            </span>
          </div>
        </header>
        <div
          className={
            bleed
              ? 'flex-1 min-h-0 flex overflow-hidden'
              : 'flex-1 overflow-y-auto p-4 sm:p-6 md:p-8'
          }
        >
          {children}
        </div>
        <div className="workspace-overlay" onClick={closeWorkspacePanels} />
      </main>
    </div>
  );
}
