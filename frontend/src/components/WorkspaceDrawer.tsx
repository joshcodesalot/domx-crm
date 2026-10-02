import { type ReactNode } from 'react';
import { useShell, type DrawerSize } from '@/context/ShellContext';

export function WorkspaceDrawer({
  id,
  size,
  className = '',
  children,
}: {
  id: string;
  size: DrawerSize;
  className?: string;
  children: ReactNode;
}) {
  const { isWorkspaceOpen, closeWorkspacePanel } = useShell();
  const open = isWorkspaceOpen(id);
  return (
    <aside
      id={id}
      className={`workspace-drawer drawer-${size} ${open ? 'workspace-open' : ''} ${className}`}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (!target.closest('[data-drawer-list]')) return;
        if (target.closest('button, a')) closeWorkspacePanel(id);
      }}
    >
      {children}
    </aside>
  );
}

export function WorkspaceDrawerButton({
  id,
  size,
  label,
  className = '',
  children,
}: {
  id: string;
  size: DrawerSize;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const { toggleWorkspacePanel, isWorkspaceOpen } = useShell();
  const open = isWorkspaceOpen(id);
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 h-9 px-2.5 rounded-lg border text-xs font-medium transition-colors ${
        open
          ? 'border-gray-300 dark:border-white/20 bg-gray-100 dark:bg-white/10 text-gray-900 dark:text-white'
          : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5'
      } ${className}`}
      onClick={() => toggleWorkspacePanel(id, size)}
      aria-expanded={open}
      aria-controls={id}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}
