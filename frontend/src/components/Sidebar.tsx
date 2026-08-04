import { useEffect, useRef, useState } from 'react';
import {
  BarChart2,
  Bell,
  LayoutGrid,
  LogOut,
  Megaphone,
  MessageSquare,
  PanelsTopLeft,
  ShieldAlert,
  Sparkles,
  UserCog,
  UserSearch,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ThemeToggle from '@/components/ThemeToggle';
import maloumIcon from '@/assets/maloum_icon.png';
import fourBasedIcon from '@/assets/4based_icon.ico';

interface SidebarProps {
  activePage?:
    | 'dashboard'
    | 'analytics'
    | 'chatter'
    | 'creators'
    | 'staff'
    | 'moderation';
}

export default function Sidebar({ activePage = 'dashboard' }: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [maloumMenuOpen, setMaloumMenuOpen] = useState(false);
  const [fourBasedMenuOpen, setFourBasedMenuOpen] = useState(false);
  const maloumMenuRef = useRef<HTMLDivElement>(null);
  const fourBasedMenuRef = useRef<HTMLDivElement>(null);
  const hash =
    typeof window !== 'undefined' ? window.location.hash : '';
  const isFourBasedActive =
    hash.includes('/chatter/4based') || hash.includes('/message-pro/4based');
  const isMaloumActive =
    activePage === 'chatter' && !isFourBasedActive;

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  useEffect(() => {
    if (!maloumMenuOpen && !fourBasedMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      if (
        maloumMenuOpen &&
        maloumMenuRef.current &&
        !maloumMenuRef.current.contains(target)
      ) {
        setMaloumMenuOpen(false);
      }
      if (
        fourBasedMenuOpen &&
        fourBasedMenuRef.current &&
        !fourBasedMenuRef.current.contains(target)
      ) {
        setFourBasedMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMaloumMenuOpen(false);
        setFourBasedMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [maloumMenuOpen, fourBasedMenuOpen]);

  const initial = user?.name?.charAt(0).toUpperCase() || 'U';

  const navClass = (page: string) =>
    page === activePage
      ? 'text-gray-900 dark:text-white'
      : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors';

  async function openMessagePro(platform: 'maloum' | '4based') {
    const route = platform === '4based' ? '/message-pro/4based' : '/message-pro';
    if (window.electronAPI?.openMessageProWindow) {
      try {
        await window.electronAPI.openMessageProWindow(platform);
        return;
      } catch {
        // Fall through to in-app navigation
      }
    }
    navigate(route);
  }

  async function handleMaloumNavigate(
    view:
      | 'chat'
      | 'message-pro'
      | 'mass-message'
      | 'fan-scraper'
      | 'ai-bulk-reply'
      | 'notifications'
  ) {
    setMaloumMenuOpen(false);
    if (view === 'message-pro') {
      await openMessagePro('maloum');
      return;
    }
    if (view === 'mass-message') {
      navigate('/chatter/maloum/mass-message');
      return;
    }
    if (view === 'fan-scraper') {
      navigate('/chatter/maloum/fan-scraper');
      return;
    }
    if (view === 'ai-bulk-reply') {
      navigate('/chatter/maloum/ai-bulk-reply');
      return;
    }
    if (view === 'notifications') {
      navigate('/chatter/maloum/notifications');
      return;
    }
    navigate('/chatter');
  }

  async function handleFourBasedNavigate(
    view:
      | 'chat'
      | 'message-pro'
      | 'mass-message'
      | 'fan-scraper'
      | 'ai-bulk-reply'
      | 'notifications'
  ) {
    setFourBasedMenuOpen(false);
    if (view === 'message-pro') {
      await openMessagePro('4based');
      return;
    }
    if (view === 'mass-message') {
      navigate('/chatter/4based/mass-message');
      return;
    }
    if (view === 'fan-scraper') {
      navigate('/chatter/4based/fan-scraper');
      return;
    }
    if (view === 'ai-bulk-reply') {
      navigate('/chatter/4based/ai-bulk-reply');
      return;
    }
    if (view === 'notifications') {
      navigate('/chatter/4based/notifications');
      return;
    }
    navigate('/chatter/4based');
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
              onClick={() => {
                setFourBasedMenuOpen(false);
                setMaloumMenuOpen((open) => !open);
              }}
              className={`${
                isMaloumActive
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors'
              } group`}
              title="Maloum"
              aria-haspopup="menu"
              aria-expanded={maloumMenuOpen}
            >
              <img
                src={maloumIcon}
                alt=""
                className={`w-5 h-5 rounded object-cover transition-opacity ${
                  isMaloumActive
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
                  onClick={() => void handleMaloumNavigate('chat')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  Chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleMaloumNavigate('notifications')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <Bell className="w-4 h-4 shrink-0" />
                  Notifications
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleMaloumNavigate('message-pro')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <PanelsTopLeft className="w-4 h-4 shrink-0" />
                  Message Pro
                </button>
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleMaloumNavigate('mass-message')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Megaphone className="w-4 h-4 shrink-0" />
                    Mass Message
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleMaloumNavigate('fan-scraper')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <UserSearch className="w-4 h-4 shrink-0" />
                    Fan Scraper
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleMaloumNavigate('ai-bulk-reply')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    AI Bulk Reply
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {hasPermission('creators.view') && (
          <div ref={fourBasedMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setMaloumMenuOpen(false);
                setFourBasedMenuOpen((open) => !open);
              }}
              className={`${
                isFourBasedActive
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors'
              } group`}
              title="4based"
              aria-haspopup="menu"
              aria-expanded={fourBasedMenuOpen}
            >
              <img
                src={fourBasedIcon}
                alt=""
                className={`w-5 h-5 rounded object-cover transition-opacity ${
                  isFourBasedActive
                    ? 'opacity-100'
                    : 'opacity-50 group-hover:opacity-100'
                }`}
              />
            </button>

            {fourBasedMenuOpen && (
              <div
                role="menu"
                className="absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 min-w-[160px] rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleFourBasedNavigate('chat')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  Chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleFourBasedNavigate('notifications')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <Bell className="w-4 h-4 shrink-0" />
                  Notifications
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleFourBasedNavigate('message-pro')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <PanelsTopLeft className="w-4 h-4 shrink-0" />
                  Message Pro
                </button>
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleFourBasedNavigate('mass-message')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Megaphone className="w-4 h-4 shrink-0" />
                    Mass Message
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleFourBasedNavigate('fan-scraper')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <UserSearch className="w-4 h-4 shrink-0" />
                    Fan Scraper
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleFourBasedNavigate('ai-bulk-reply')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Sparkles className="w-4 h-4 shrink-0" />
                    AI Bulk Reply
                  </button>
                )}
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
        {(hasPermission('moderation.manage') ||
          hasPermission('moderation.review')) && (
          <button
            type="button"
            onClick={() => navigate('/staff/moderation')}
            className={navClass('moderation')}
            title="Keyword Moderation"
          >
            <ShieldAlert className="w-5 h-5" />
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
