import { useEffect, useRef, useState } from 'react';
import {
  BarChart2,
  Bell,
  LayoutGrid,
  LogOut,
  MessageSquare,
  PanelsTopLeft,
  UserCog,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ThemeToggle from '@/components/ThemeToggle';
import maloumIcon from '@/assets/maloum_icon.png';

interface SidebarProps {
  activePage?: 'dashboard' | 'analytics' | 'chatter' | 'creators' | 'staff';
}

export default function Sidebar({ activePage = 'dashboard' }: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [maloumMenuOpen, setMaloumMenuOpen] = useState(false);
  const maloumMenuRef = useRef<HTMLDivElement>(null);

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  useEffect(() => {
    if (!maloumMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!maloumMenuRef.current?.contains(event.target as Node)) {
        setMaloumMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMaloumMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [maloumMenuOpen]);

  const initial = user?.name?.charAt(0).toUpperCase() || 'U';

  const navClass = (page: string) =>
    page === activePage
      ? 'text-gray-900 dark:text-white'
      : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors';

  function handleMaloumNavigate(view: 'chat' | 'notifications' | 'message-pro') {
    setMaloumMenuOpen(false);
    if (view === 'message-pro') {
      if (window.electronAPI?.openMessageProWindow) {
        void window.electronAPI.openMessageProWindow();
      }
      return;
    }
    if (view === 'notifications') {
      navigate('/chatter?view=notifications');
      return;
    }
    navigate('/chatter');
  }

  return (
    <aside className="w-16 flex flex-col items-center py-6 border-r border-gray-200 dark:border-white/10 shrink-0">
      <div className="w-8 h-8 bg-gray-900 dark:bg-white rounded flex items-center justify-center mb-10 shadow-sm">
        <span className="text-white dark:text-black font-bold text-xs tracking-tighter">
          DX
        </span>
      </div>

      <nav className="flex flex-col gap-6">
        {hasPermission('dashboard.view') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard')}
            className={navClass('dashboard')}
            title="Overview"
          >
            <LayoutGrid className="w-5 h-5" />
          </button>
        )}
        {hasPermission('analytics.view') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/messaging')}
            className={navClass('analytics')}
            title="Analytics"
          >
            <BarChart2 className="w-5 h-5" />
          </button>
        )}
        {hasPermission('creators.view') && (
          <div ref={maloumMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setMaloumMenuOpen((open) => !open)}
              className={`${navClass('chatter')} group`}
              title="Maloum"
              aria-haspopup="menu"
              aria-expanded={maloumMenuOpen}
            >
              <img
                src={maloumIcon}
                alt=""
                className={`w-5 h-5 rounded object-cover transition-opacity ${
                  activePage === 'chatter'
                    ? 'opacity-100'
                    : 'opacity-50 group-hover:opacity-100'
                }`}
              />
            </button>

            {maloumMenuOpen && (
              <div
                role="menu"
                className="absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 min-w-[160px] rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleMaloumNavigate('chat')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  Chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleMaloumNavigate('notifications')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <Bell className="w-4 h-4 shrink-0" />
                  Notifications
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => handleMaloumNavigate('message-pro')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <PanelsTopLeft className="w-4 h-4 shrink-0" />
                  Message Pro
                </button>
              </div>
            )}
          </div>
        )}
        {hasPermission('creators.manage') && (
          <button
            type="button"
            onClick={() => navigate('/creators/manage')}
            className={navClass('creators')}
            title="Creators"
          >
            <Users className="w-5 h-5" />
          </button>
        )}
        {hasPermission('staff.view') && (
          <button
            type="button"
            onClick={() => navigate('/staff/manage')}
            className={navClass('staff')}
            title="Manage Staff"
          >
            <UserCog className="w-5 h-5" />
          </button>
        )}
      </nav>

      <div className="mt-auto flex flex-col gap-4 items-center">
        <ThemeToggle className="p-0 hover:bg-transparent dark:hover:bg-transparent focus:ring-0" />
        <button
          type="button"
          onClick={handleLogout}
          className="text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          title="Log out"
        >
          <LogOut className="w-5 h-5" />
        </button>
        <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-medium">
          {initial}
        </div>
      </div>
    </aside>
  );
}
