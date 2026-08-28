import { useEffect, useRef, useState } from 'react';
import {
  BarChart2,
  Bell,
  CalendarDays,
  LayoutGrid,
  LineChart,
  List,
  LogOut,
  Megaphone,
  MessageSquare,
  Newspaper,
  PanelsTopLeft,
  Receipt,
  ShieldAlert,
  Sparkles,
  Settings,
  UserCog,
  UserSearch,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ThemeToggle from '@/components/ThemeToggle';
import maloumIcon from '@/assets/maloum_icon.png';
import fourBasedIcon from '@/assets/4based_icon.ico';
import telegramIcon from '@/assets/telegram_icon.svg';

interface SidebarProps {
  activePage?:
    | 'dashboard'
    | 'analytics'
    | 'charts'
    | 'creatorAnalytics'
    | 'falseSales'
    | 'salesLogs'
    | 'chatter'
    | 'creators'
    | 'staff'
    | 'moderation'
    | 'account'
    | 'schedule';
}

export default function Sidebar({ activePage = 'dashboard' }: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [maloumMenuOpen, setMaloumMenuOpen] = useState(false);
  const [fourBasedMenuOpen, setFourBasedMenuOpen] = useState(false);
  const [telegramMenuOpen, setTelegramMenuOpen] = useState(false);
  const maloumMenuRef = useRef<HTMLDivElement>(null);
  const fourBasedMenuRef = useRef<HTMLDivElement>(null);
  const telegramMenuRef = useRef<HTMLDivElement>(null);
  const hash =
    typeof window !== 'undefined' ? window.location.hash : '';
  const isFourBasedActive =
    hash.includes('/chatter/4based') || hash.includes('/message-pro/4based');
  const isTelegramActive =
    hash.includes('/chatter/telegram') || hash.includes('/message-pro/telegram');
  const isMaloumActive =
    activePage === 'chatter' &&
    !isFourBasedActive &&
    !isTelegramActive &&
    !hash.includes('/chatter/schedule');

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  useEffect(() => {
    if (!maloumMenuOpen && !fourBasedMenuOpen && !telegramMenuOpen) {
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
      if (
        telegramMenuOpen &&
        telegramMenuRef.current &&
        !telegramMenuRef.current.contains(target)
      ) {
        setTelegramMenuOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMaloumMenuOpen(false);
        setFourBasedMenuOpen(false);
        setTelegramMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [maloumMenuOpen, fourBasedMenuOpen, telegramMenuOpen]);

  const initial = user?.name?.charAt(0).toUpperCase() || 'U';

  const navClass = (page: string) =>
    page === activePage
      ? 'text-gray-900 dark:text-white'
      : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors';

  async function openMessagePro(platform: 'maloum' | '4based' | 'telegram') {
    const route =
      platform === '4based'
        ? '/message-pro/4based'
        : platform === 'telegram'
          ? '/message-pro/telegram'
          : '/message-pro';
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
      | 'feed'
      | 'fan-scraper'
      | 'lists'
      | 'ai-bulk-reply'
      | 'notifications'
      | 'schedule'
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
    if (view === 'feed') {
      navigate('/chatter/maloum/feed');
      return;
    }
    if (view === 'schedule') {
      navigate('/chatter/schedule');
      return;
    }
    if (view === 'fan-scraper') {
      navigate('/chatter/maloum/fan-scraper');
      return;
    }
    if (view === 'lists') {
      navigate('/chatter/maloum/lists');
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
      | 'feed'
      | 'fan-scraper'
      | 'ai-bulk-reply'
      | 'notifications'
      | 'schedule'
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
    if (view === 'feed') {
      navigate('/chatter/4based/feed');
      return;
    }
    if (view === 'schedule') {
      navigate('/chatter/schedule');
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

  async function handleTelegramNavigate(
    view: 'chat' | 'message-pro' | 'sexting-session'
  ) {
    setTelegramMenuOpen(false);
    if (view === 'message-pro') {
      await openMessagePro('telegram');
      return;
    }
    if (view === 'sexting-session') {
      navigate('/chatter/telegram/sexting-session');
      return;
    }
    navigate('/chatter/telegram');
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
        {(user?.role === 'owner' || user?.role === 'manager') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/charts')}
            className={navClass('charts')}
            title="Charts"
          >
            <LineChart className="w-5 h-5" />
          </button>
        )}
        {(user?.role === 'owner' || user?.role === 'manager') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/creator-analytics')}
            className={navClass('creatorAnalytics')}
            title="Creator Analytics"
          >
            <Users className="w-5 h-5" />
          </button>
        )}
        {hasPermission('analytics.view') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/messaging')}
            className={navClass('analytics')}
            title="Messaging Analytics"
          >
            <BarChart2 className="w-5 h-5" />
          </button>
        )}
        {hasPermission('analytics.view') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/sales-logs')}
            className={navClass('salesLogs')}
            title="Sales Logs"
          >
            <Receipt className="w-5 h-5" />
          </button>
        )}
        {(user?.role === 'owner' || user?.role === 'manager') && (
          <button
            type="button"
            onClick={() => navigate('/dashboard/false-sales')}
            className={navClass('falseSales')}
            title="False Sales Review"
          >
            <ShieldAlert className="w-5 h-5" />
          </button>
        )}
        {hasPermission('mass_messages.send') && (
          <button
            type="button"
            onClick={() => navigate('/chatter/schedule')}
            className={navClass('schedule')}
            title="Content schedule"
          >
            <CalendarDays className="w-5 h-5" />
          </button>
        )}
        {hasPermission('creators.view') && (
          <div ref={maloumMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setFourBasedMenuOpen(false);
                setTelegramMenuOpen(false);
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
                    onClick={() => void handleMaloumNavigate('feed')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Newspaper className="w-4 h-4 shrink-0" />
                    Feed
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleMaloumNavigate('schedule')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <CalendarDays className="w-4 h-4 shrink-0" />
                    Schedule
                  </button>
                )}
                {hasPermission('fan_scraper.use') && (
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
                    onClick={() => void handleMaloumNavigate('lists')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <List className="w-4 h-4 shrink-0" />
                    Lists
                  </button>
                )}
                {(user?.role === 'owner' || user?.role === 'manager') && (
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
                setTelegramMenuOpen(false);
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
                    onClick={() => void handleFourBasedNavigate('feed')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <Newspaper className="w-4 h-4 shrink-0" />
                    Feed
                  </button>
                )}
                {hasPermission('mass_messages.send') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void handleFourBasedNavigate('schedule')}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    <CalendarDays className="w-4 h-4 shrink-0" />
                    Schedule
                  </button>
                )}
                {hasPermission('fan_scraper.use') && (
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
                {(user?.role === 'owner' || user?.role === 'manager') && (
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
        {hasPermission('creators.view') && (
          <div ref={telegramMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setMaloumMenuOpen(false);
                setFourBasedMenuOpen(false);
                setTelegramMenuOpen((open) => !open);
              }}
              className={`${
                isTelegramActive
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors'
              } group`}
              title="Telegram"
              aria-haspopup="menu"
              aria-expanded={telegramMenuOpen}
            >
              <img
                src={telegramIcon}
                alt=""
                className={`w-5 h-5 rounded-full transition-opacity ${
                  isTelegramActive
                    ? 'opacity-100'
                    : 'opacity-50 group-hover:opacity-100'
                }`}
              />
            </button>

            {telegramMenuOpen && (
              <div
                role="menu"
                className="absolute left-full top-1/2 -translate-y-1/2 ml-3 z-50 min-w-[180px] rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg py-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleTelegramNavigate('chat')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <MessageSquare className="w-4 h-4 shrink-0" />
                  Chat
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleTelegramNavigate('message-pro')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <PanelsTopLeft className="w-4 h-4 shrink-0" />
                  Message Pro
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => void handleTelegramNavigate('sexting-session')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                >
                  <Sparkles className="w-4 h-4 shrink-0" />
                  Sexting Session
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
          onClick={() => navigate('/account/settings')}
          className={navClass('account')}
          title="Account Settings"
        >
          <Settings className="w-5 h-5" />
        </button>
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
