import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';

export type DrawerSize = 'md' | 'lg' | 'xl';

export interface WorkspacePanel {
  id: string;
  size: DrawerSize;
}

interface ShellContextValue {
  desktopCollapsed: boolean;
  mobileOpen: boolean;
  toggleSidebar: () => void;
  closeMobileSidebar: () => void;
  workspacePanel: WorkspacePanel | null;
  isWorkspaceOpen: (id: string) => boolean;
  openWorkspacePanel: (id: string, size: DrawerSize) => void;
  toggleWorkspacePanel: (id: string, size: DrawerSize) => void;
  closeWorkspacePanel: (id: string) => void;
  closeWorkspacePanels: () => void;
}

const ShellContext = createContext<ShellContextValue | null>(null);
const COLLAPSED_KEY = 'domx-sidebar-collapsed';
const CLOSE_EVENT = 'domx-close-drawers';

function isMobileWidth() {
  return window.innerWidth < 768;
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const pathRef = useRef(location.pathname);
  const [desktopCollapsed, setDesktopCollapsed] = useState(
    () => localStorage.getItem(COLLAPSED_KEY) === '1'
  );
  const [mobileOpen, setMobileOpen] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel | null>(null);

  const setBodyWorkspace = useCallback((panel: WorkspacePanel | null) => {
    document.body.classList.remove(
      'workspace-md-open',
      'workspace-lg-open',
      'workspace-xl-open'
    );
    if (panel) {
      document.body.classList.add(`workspace-${panel.size}-open`);
    }
  }, []);

  const closeWorkspacePanels = useCallback(() => {
    setWorkspacePanel(null);
    setBodyWorkspace(null);
    window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
  }, [setBodyWorkspace]);

  const closeMobileSidebar = useCallback(() => {
    setMobileOpen(false);
    document.body.classList.remove('overflow-hidden');
  }, []);

  const openWorkspacePanel = useCallback(
    (id: string, size: DrawerSize) => {
      setWorkspacePanel({ id, size });
      setBodyWorkspace({ id, size });
      window.dispatchEvent(
        new CustomEvent(CLOSE_EVENT, { detail: { except: id } })
      );
    },
    [setBodyWorkspace]
  );

  const toggleWorkspacePanel = useCallback(
    (id: string, size: DrawerSize) => {
      setWorkspacePanel((current) => {
        if (current?.id === id) {
          setBodyWorkspace(null);
          window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
          return null;
        }
        setBodyWorkspace({ id, size });
        window.dispatchEvent(
          new CustomEvent(CLOSE_EVENT, { detail: { except: id } })
        );
        return { id, size };
      });
    },
    [setBodyWorkspace]
  );

  const closeWorkspacePanel = useCallback(
    (id: string) => {
      setWorkspacePanel((current) => {
        if (current?.id !== id) return current;
        setBodyWorkspace(null);
        return null;
      });
    },
    [setBodyWorkspace]
  );

  const toggleSidebar = useCallback(() => {
    if (isMobileWidth()) {
      setMobileOpen((open) => {
        const next = !open;
        document.body.classList.toggle('overflow-hidden', next);
        return next;
      });
      return;
    }
    setDesktopCollapsed((collapsed) => {
      const next = !collapsed;
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      closeMobileSidebar();
      closeWorkspacePanels();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeMobileSidebar, closeWorkspacePanels]);

  useEffect(() => {
    function onResize() {
      if (!isMobileWidth()) {
        setMobileOpen(false);
        document.body.classList.remove('overflow-hidden');
      }
      setWorkspacePanel(null);
      setBodyWorkspace(null);
      window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setBodyWorkspace]);

  useEffect(() => {
    if (pathRef.current === location.pathname) return;
    pathRef.current = location.pathname;
    closeMobileSidebar();
    setWorkspacePanel(null);
    setBodyWorkspace(null);
    window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
  }, [location.pathname, closeMobileSidebar, setBodyWorkspace]);

  const value = useMemo<ShellContextValue>(
    () => ({
      desktopCollapsed,
      mobileOpen,
      toggleSidebar,
      closeMobileSidebar,
      workspacePanel,
      isWorkspaceOpen: (id: string) => workspacePanel?.id === id,
      openWorkspacePanel,
      toggleWorkspacePanel,
      closeWorkspacePanel,
      closeWorkspacePanels,
    }),
    [
      desktopCollapsed,
      mobileOpen,
      toggleSidebar,
      closeMobileSidebar,
      workspacePanel,
      openWorkspacePanel,
      toggleWorkspacePanel,
      closeWorkspacePanel,
      closeWorkspacePanels,
    ]
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const value = useContext(ShellContext);
  if (!value) {
    throw new Error('useShell must be used within ShellProvider');
  }
  return value;
}

export function useSyncedDrawer(
  id: string,
  size: DrawerSize,
  open: boolean,
  setOpen: (next: boolean) => void
) {
  const { openWorkspacePanel, closeWorkspacePanel } = useShell();

  useEffect(() => {
    if (!open) return;
    const onClose = (event: Event) => {
      const except = (event as CustomEvent<{ except?: string }>).detail?.except;
      if (except === id) return;
      setOpen(false);
    };
    window.addEventListener(CLOSE_EVENT, onClose);
    openWorkspacePanel(id, size);
    return () => {
      window.removeEventListener(CLOSE_EVENT, onClose);
      closeWorkspacePanel(id);
    };
  }, [open, id, size, setOpen, openWorkspacePanel, closeWorkspacePanel]);
}
