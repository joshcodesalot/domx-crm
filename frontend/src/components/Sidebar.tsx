import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  BarChart2,
  Bell,
  CalendarDays,
  ClipboardList,
  Clock3,
  LayoutGrid,
  List,
  LogIn,
  LogOut,
  LineChart,
  Megaphone,
  MessageSquare,
  Monitor,
  Moon,
  Newspaper,
  PanelsTopLeft,
  Receipt,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  UserCog,
  UserSearch,
  Users,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import GermanTimeClock from '@/components/GermanTimeClock';
import { useAuth } from '@/context/AuthContext';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useShell } from '@/context/ShellContext';
import { useTheme } from '@/hooks/useTheme';
import maloumIcon from '@/assets/maloum_icon.png';
import fourBasedIcon from '@/assets/4based_icon.ico';
import fanslyIcon from '@/assets/fansly.svg';
import telegramIcon from '@/assets/telegram_icon.svg';

export type SidebarPage =
  | 'dashboard'
  | 'analytics'
  | 'charts'
  | 'creatorAnalytics'
  | 'falseSales'
  | 'salesLogs'
  | 'crmActivity'
  | 'loginActivity'
  | 'chatter'
  | 'creators'
  | 'staff'
  | 'moderation'
  | 'account'
  | 'schedule'
  | 'marketing';

function formatUnreadCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    function onResize() {
      setMobile(window.innerWidth < 768);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return mobile;
}

function NavItem({
  active,
  title,
  icon,
  label,
  onClick,
  danger = false,
}: {
  active?: boolean;
  title: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`nav-link flex items-center w-full px-3 py-2 rounded-lg text-left transition-colors ${
        active
          ? 'text-gray-900 dark:text-white bg-gray-100 dark:bg-white/10 shadow-sm'
          : danger
            ? 'text-gray-500 dark:text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:text-red-400 dark:hover:bg-red-500/10'
            : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 hover:bg-gray-50 dark:hover:text-white dark:hover:bg-white/5'
      }`}
    >
      <span className="w-5 h-5 shrink-0 flex items-center justify-center">{icon}</span>
      <span className="sidebar-text ml-3 text-sm font-medium truncate">{label}</span>
    </button>
  );
}

function GroupTitle({ children }: { children: string }) {
  return (
    <p className="nav-group-title px-3 mb-1 text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-[0.12em] mt-5 first:mt-1">
      {children}
    </p>
  );
}

function UnreadCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto min-w-[18px] px-1.5 py-0.5 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none text-center">
      {formatUnreadCount(count)}
    </span>
  );
}

export default function Sidebar({ activePage = 'dashboard' }: { activePage?: SidebarPage }) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { desktopCollapsed, mobileOpen, closeMobileSidebar } = useShell();
  const { isDark, toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const labeled = isMobile || !desktopCollapsed;
  const { creators, creatorsLoading, badgesByCreatorId, throneUnread } = useCreatorLive({
    wantBadges: hasPermission('creators.view'),
  });
  const isChatter = user?.role === 'chatter';
  const platformsWithCreators = useMemo(() => {
    const present = new Set<'maloum' | '4based' | 'telegram' | 'fansly'>();
    for (const creator of creators) {
      present.add(creator.platform);
    }
    return present;
  }, [creators]);
  const unreadTotals = useMemo(() => {
    const totals = {
      maloum: { messages: 0, notifications: 0 },
      '4based': { messages: 0, notifications: 0 },
      telegram: { messages: 0, notifications: 0 },
      fansly: { messages: 0, notifications: 0 },
    };
    for (const creator of creators) {
      const badges = badgesByCreatorId[creator.id];
      totals[creator.platform].messages += badges?.messages ?? 0;
      totals[creator.platform].notifications += badges?.notifications ?? 0;
    }
    return totals;
  }, [creators, badgesByCreatorId]);

  const path = location.pathname;
  const [openPlatform, setOpenPlatform] = useState<
    'maloum' | '4based' | 'telegram' | 'fansly' | null
  >(null);
  const [flyoutTop, setFlyoutTop] = useState(0);
  const [flyoutLeft, setFlyoutLeft] = useState(0);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const maloumMenuRef = useRef<HTMLDivElement>(null);
  const fourBasedMenuRef = useRef<HTMLDivElement>(null);
  const telegramMenuRef = useRef<HTMLDivElement>(null);
  const fanslyMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (path.startsWith('/chatter/fansly')) {
      setOpenPlatform('fansly');
    } else if (path.startsWith('/chatter/4based') || path.startsWith('/message-pro/4based')) {
      setOpenPlatform('4based');
    } else if (
      path.startsWith('/chatter/telegram') ||
      path.startsWith('/message-pro/telegram')
    ) {
      setOpenPlatform('telegram');
    } else if (
      path === '/chatter' ||
      path.startsWith('/chatter/maloum') ||
      path === '/message-pro'
    ) {
      setOpenPlatform('maloum');
    }
  }, [path]);

  useEffect(() => {
    if (labeled || !openPlatform) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as Node;
      const ref =
        openPlatform === 'maloum'
          ? maloumMenuRef
          : openPlatform === '4based'
            ? fourBasedMenuRef
            : openPlatform === 'fansly'
              ? fanslyMenuRef
              : telegramMenuRef;
      const insideButton = ref.current?.contains(target) ?? false;
      const insideFlyout = flyoutRef.current?.contains(target) ?? false;
      if (!insideButton && !insideFlyout) {
        setOpenPlatform(null);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [labeled, openPlatform]);

  function go(to: string) {
    closeMobileSidebar();
    setOpenPlatform(null);
    navigate(to);
  }

  async function openMessagePro(platform: 'maloum' | '4based' | 'telegram') {
    closeMobileSidebar();
    setOpenPlatform(null);
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

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  const initial = user?.name?.charAt(0).toUpperCase() || 'U';
  const canSendMass = hasPermission('mass_messages.send');
  const canScrape = hasPermission('fan_scraper.use');

  function toolActive(href: string) {
    return path === href;
  }

  function renderTools(
    tools: {
      label: string;
      icon: ReactNode;
      onClick: () => void;
      active: boolean;
      unread?: number;
    }[]
  ) {
    return tools.map((tool) => (
      <button
        key={tool.label}
        type="button"
        onClick={tool.onClick}
        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left rounded-lg ${
          tool.active
            ? 'text-gray-900 dark:text-white bg-gray-100 dark:bg-white/10'
            : 'text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/5'
        }`}
      >
        <span className="w-4 h-4 shrink-0">{tool.icon}</span>
        <span className="truncate">{tool.label}</span>
        <UnreadCount count={tool.unread || 0} />
      </button>
    ));
  }

  function platformBlock(options: {
    id: 'maloum' | '4based' | 'telegram' | 'fansly';
    label: string;
    icon: ReactNode;
    unread: number;
    menuRef: RefObject<HTMLDivElement | null>;
    tools: {
      label: string;
      icon: ReactNode;
      onClick: () => void;
      active: boolean;
      unread?: number;
    }[];
  }) {
    const expanded = openPlatform === options.id;
    return (
      <div key={options.id} ref={options.menuRef as RefObject<HTMLDivElement>} className="relative">
        <button
          type="button"
          title={
            options.unread > 0
              ? `${options.label} (${formatUnreadCount(options.unread)} unread)`
              : options.label
          }
          aria-expanded={expanded}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setFlyoutTop(rect.top);
            setFlyoutLeft(rect.right + 8);
            setOpenPlatform((current) => (current === options.id ? null : options.id));
          }}
          className={`nav-link relative flex items-center w-full px-3 py-2 rounded-lg text-left transition-colors ${
            expanded
              ? 'text-gray-900 dark:text-white bg-gray-100 dark:bg-white/10'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 hover:bg-gray-50 dark:hover:text-white dark:hover:bg-white/5'
          }`}
        >
          <span className="w-5 h-5 shrink-0 flex items-center justify-center relative">
            {options.icon}
            {!labeled && options.unread > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-0.5 rounded-full bg-red-500 text-white text-[9px] font-semibold leading-[14px] text-center">
                {formatUnreadCount(options.unread)}
              </span>
            )}
          </span>
          <span className="sidebar-text ml-3 text-sm font-medium truncate flex-1">
            {options.label}
          </span>
          {labeled && <UnreadCount count={options.unread} />}
        </button>
        {expanded && labeled && (
          <div className="mt-1 ml-4 pl-2 border-l border-gray-200 dark:border-white/10 space-y-0.5">
            {renderTools(options.tools)}
          </div>
        )}
        {expanded &&
          !labeled &&
          createPortal(
            <div
              ref={flyoutRef}
              role="menu"
              className="fixed z-[60] min-w-[180px] rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg py-1"
              style={{ top: flyoutTop, left: flyoutLeft }}
            >
              {renderTools(options.tools)}
            </div>,
            document.body
          )}
      </div>
    );
  }

  const maloumTools = [
    {
      label: 'Chat',
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => go('/chatter'),
      active: toolActive('/chatter'),
    },
    {
      label: 'Notifications',
      icon: <Bell className="w-4 h-4" />,
      onClick: () => go('/chatter/maloum/notifications'),
      active: toolActive('/chatter/maloum/notifications'),
      unread: unreadTotals.maloum.notifications,
    },
    {
      label: 'Message Pro',
      icon: <PanelsTopLeft className="w-4 h-4" />,
      onClick: () => void openMessagePro('maloum'),
      active: toolActive('/message-pro'),
    },
    ...(canSendMass
      ? [
          {
            label: 'Mass Message',
            icon: <Megaphone className="w-4 h-4" />,
            onClick: () => go('/chatter/maloum/mass-message'),
            active: toolActive('/chatter/maloum/mass-message'),
          },
          {
            label: 'Feed',
            icon: <Newspaper className="w-4 h-4" />,
            onClick: () => go('/chatter/maloum/feed'),
            active: toolActive('/chatter/maloum/feed'),
          },
          {
            label: 'Lists',
            icon: <List className="w-4 h-4" />,
            onClick: () => go('/chatter/maloum/lists'),
            active: toolActive('/chatter/maloum/lists'),
          },
        ]
      : []),
    ...(canScrape
      ? [
          {
            label: 'Fan Scraper',
            icon: <UserSearch className="w-4 h-4" />,
            onClick: () => go('/chatter/maloum/fan-scraper'),
            active: toolActive('/chatter/maloum/fan-scraper'),
          },
        ]
      : []),
  ];

  const fourBasedTools = [
    {
      label: 'Chat',
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => go('/chatter/4based'),
      active: toolActive('/chatter/4based'),
    },
    {
      label: 'Notifications',
      icon: <Bell className="w-4 h-4" />,
      onClick: () => go('/chatter/4based/notifications'),
      active: toolActive('/chatter/4based/notifications'),
      unread: unreadTotals['4based'].notifications,
    },
    {
      label: 'Message Pro',
      icon: <PanelsTopLeft className="w-4 h-4" />,
      onClick: () => void openMessagePro('4based'),
      active: toolActive('/message-pro/4based'),
    },
    ...(canSendMass
      ? [
          {
            label: 'Mass Message',
            icon: <Megaphone className="w-4 h-4" />,
            onClick: () => go('/chatter/4based/mass-message'),
            active: toolActive('/chatter/4based/mass-message'),
          },
          {
            label: 'Feed',
            icon: <Newspaper className="w-4 h-4" />,
            onClick: () => go('/chatter/4based/feed'),
            active: toolActive('/chatter/4based/feed'),
          },
        ]
      : []),
    ...(canScrape
      ? [
          {
            label: 'Fan Scraper',
            icon: <UserSearch className="w-4 h-4" />,
            onClick: () => go('/chatter/4based/fan-scraper'),
            active: toolActive('/chatter/4based/fan-scraper'),
          },
        ]
      : []),
  ];

  const telegramTools = [
    {
      label: 'Chat',
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => go('/chatter/telegram'),
      active: toolActive('/chatter/telegram'),
    },
    {
      label: 'Notifications',
      icon: <Bell className="w-4 h-4" />,
      onClick: () => go('/chatter/telegram/notifications'),
      active: toolActive('/chatter/telegram/notifications'),
      unread: throneUnread,
    },
    {
      label: 'Message Pro',
      icon: <PanelsTopLeft className="w-4 h-4" />,
      onClick: () => void openMessagePro('telegram'),
      active: toolActive('/message-pro/telegram'),
    },
    ...(canSendMass
      ? [
          {
            label: 'Mass Message',
            icon: <Megaphone className="w-4 h-4" />,
            onClick: () => go('/chatter/telegram/mass-message'),
            active: toolActive('/chatter/telegram/mass-message'),
          },
          {
            label: 'Lists',
            icon: <List className="w-4 h-4" />,
            onClick: () => go('/chatter/telegram/lists'),
            active: toolActive('/chatter/telegram/lists'),
          },
        ]
      : []),
    {
      label: 'Sexting Session',
      icon: <Sparkles className="w-4 h-4" />,
      onClick: () => go('/chatter/telegram/sexting-session'),
      active: toolActive('/chatter/telegram/sexting-session'),
    },
  ];

  const isManager = user?.role === 'owner' || user?.role === 'manager';
  const chatterCreatorsPending = isChatter && creatorsLoading && creators.length === 0;

  const fanslyTools = [
    {
      label: 'Chat',
      icon: <MessageSquare className="w-4 h-4" />,
      onClick: () => go('/chatter/fansly'),
      active: toolActive('/chatter/fansly'),
    },
    {
      label: 'Notifications',
      icon: <Bell className="w-4 h-4" />,
      onClick: () => go('/chatter/fansly/notifications'),
      active: toolActive('/chatter/fansly/notifications'),
      unread: unreadTotals.fansly.notifications,
    },
  ];

  function chatterCanSeePlatform(id: 'maloum' | '4based' | 'telegram' | 'fansly') {
    if (!isChatter) return true;
    if (chatterCreatorsPending) return false;
    return platformsWithCreators.has(id);
  }

  const visiblePlatforms = (
    ['maloum', '4based', 'telegram', 'fansly'] as const
  ).filter((id) => chatterCanSeePlatform(id));

  return (
    <aside
      id="app-sidebar"
      aria-label="Primary navigation"
      className={`fixed inset-y-0 left-0 z-50 md:relative md:z-auto flex flex-col border-r border-gray-200 dark:border-white/10 bg-white dark:bg-[#0a0a0a] shrink-0 py-4 ${
        mobileOpen ? '' : '-translate-x-full'
      } md:translate-x-0 ${desktopCollapsed ? 'desktop-collapsed' : ''}`}
    >
      <div className="px-4 mb-4 flex items-center nav-link gap-3 shrink-0">
        <button
          type="button"
          onClick={() => go('/dashboard')}
          title="DomX"
          className="w-8 h-8 shrink-0 bg-gray-900 dark:bg-white rounded-lg flex items-center justify-center shadow-sm"
        >
          <span className="text-white dark:text-black font-bold text-xs tracking-tighter">
            DX
          </span>
        </button>
        <span className="sidebar-text logo-full font-bold text-lg tracking-tight">DomX</span>
      </div>

      <nav className="flex-1 overflow-y-auto overflow-x-hidden px-3 pb-3 space-y-1">
        {(hasPermission('dashboard.view') || isManager || hasPermission('analytics.view')) && (
          <GroupTitle>Core</GroupTitle>
        )}
        {hasPermission('dashboard.view') && (
          <NavItem
            active={activePage === 'dashboard'}
            title="Overview"
            label="Overview"
            icon={<LayoutGrid className="w-5 h-5" />}
            onClick={() => go('/dashboard')}
          />
        )}
        {isManager && (
          <NavItem
            active={activePage === 'charts'}
            title="Charts"
            label="Charts"
            icon={<LineChart className="w-5 h-5" />}
            onClick={() => go('/dashboard/charts')}
          />
        )}
        {isManager && (
          <NavItem
            active={activePage === 'creatorAnalytics'}
            title="Creator Analytics"
            label="Creator Analytics"
            icon={<Users className="w-5 h-5" />}
            onClick={() => go('/dashboard/creator-analytics')}
          />
        )}
        {hasPermission('analytics.view') && (
          <NavItem
            active={activePage === 'analytics'}
            title="Messaging Analytics"
            label="Messaging Analytics"
            icon={<BarChart2 className="w-5 h-5" />}
            onClick={() => go('/dashboard/messaging')}
          />
        )}

        {canSendMass && (
          <>
            <GroupTitle>Operations</GroupTitle>
            <NavItem
              active={activePage === 'schedule'}
              title="Content Schedule"
              label="Content Schedule"
              icon={<CalendarDays className="w-5 h-5" />}
              onClick={() => go('/chatter/schedule')}
            />
          </>
        )}

        {(hasPermission('analytics.view') || isManager) && (
          <GroupTitle>Logs & Activity</GroupTitle>
        )}
        {hasPermission('analytics.view') && (
          <NavItem
            active={activePage === 'salesLogs'}
            title="Sales Logs"
            label="Sales Logs"
            icon={<Receipt className="w-5 h-5" />}
            onClick={() => go('/dashboard/sales-logs')}
          />
        )}
        {hasPermission('analytics.view') && (
          <NavItem
            active={activePage === 'crmActivity'}
            title="CRM Activity"
            label="CRM Activity"
            icon={<ClipboardList className="w-5 h-5" />}
            onClick={() => go('/dashboard/crm-activity')}
          />
        )}
        {hasPermission('analytics.view') && (
          <NavItem
            active={activePage === 'loginActivity'}
            title="Login Activity"
            label="Login Activity"
            icon={<LogIn className="w-5 h-5" />}
            onClick={() => go('/dashboard/login-activity')}
          />
        )}
        {isManager && (
          <NavItem
            active={activePage === 'falseSales'}
            title="False Sales Review"
            label="False Sales Review"
            icon={<ShieldAlert className="w-5 h-5" />}
            onClick={() => go('/dashboard/false-sales')}
          />
        )}

        {(hasPermission('marketing.view') ||
          hasPermission('creators.manage') ||
          hasPermission('staff.view') ||
          hasPermission('moderation.manage') ||
          hasPermission('moderation.review')) && <GroupTitle>Management</GroupTitle>}
        {hasPermission('marketing.view') && (
          <NavItem
            active={activePage === 'marketing'}
            title="Marketing"
            label="Marketing"
            icon={<Monitor className="w-5 h-5" />}
            onClick={() => go('/marketing')}
          />
        )}
        {hasPermission('creators.manage') && (
          <NavItem
            active={activePage === 'creators'}
            title="Creators"
            label="Creators"
            icon={<Users className="w-5 h-5" />}
            onClick={() => go('/creators/manage')}
          />
        )}
        {hasPermission('staff.view') && (
          <NavItem
            active={activePage === 'staff'}
            title="Manage Staff"
            label="Manage Staff"
            icon={<UserCog className="w-5 h-5" />}
            onClick={() => go('/staff/manage')}
          />
        )}
        {(hasPermission('moderation.manage') || hasPermission('moderation.review')) && (
          <NavItem
            active={activePage === 'moderation'}
            title="Keyword Moderation"
            label="Keyword Moderation"
            icon={<ShieldCheck className="w-5 h-5" />}
            onClick={() => go('/staff/moderation')}
          />
        )}

        {hasPermission('creators.view') && visiblePlatforms.length > 0 && (
          <>
            <GroupTitle>Platforms</GroupTitle>
            {visiblePlatforms.includes('maloum') &&
              platformBlock({
                id: 'maloum',
                label: 'Maloum',
                icon: <img src={maloumIcon} alt="" className="w-5 h-5 rounded object-cover" />,
                unread: unreadTotals.maloum.messages,
                menuRef: maloumMenuRef,
                tools: maloumTools,
              })}
            {visiblePlatforms.includes('4based') &&
              platformBlock({
                id: '4based',
                label: '4based',
                icon: <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded object-cover" />,
                unread: unreadTotals['4based'].messages,
                menuRef: fourBasedMenuRef,
                tools: fourBasedTools,
              })}
            {visiblePlatforms.includes('fansly') &&
              platformBlock({
                id: 'fansly',
                label: 'Fansly',
                icon: <img src={fanslyIcon} alt="" className="w-5 h-5 object-contain" />,
                unread: unreadTotals.fansly.messages,
                menuRef: fanslyMenuRef,
                tools: fanslyTools,
              })}
            {visiblePlatforms.includes('telegram') &&
              platformBlock({
                id: 'telegram',
                label: 'Telegram',
                icon: (
                  <img src={telegramIcon} alt="" className="w-5 h-5 rounded-full object-cover" />
                ),
                unread: unreadTotals.telegram.messages,
                menuRef: telegramMenuRef,
                tools: telegramTools,
              })}
          </>
        )}
      </nav>

      <div className="px-3 pt-3 mt-auto border-t border-gray-200 dark:border-white/10 space-y-1 shrink-0">
        <div className="nav-link flex items-center px-3 py-2 text-gray-500 dark:text-gray-400" title="Berlin time">
          <Clock3 className="w-5 h-5 shrink-0 opacity-70" />
          <span className="sidebar-text ml-3 text-[11px] font-mono tracking-wider">
            <GermanTimeClock compact />
          </span>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          title="Toggle theme"
          className="nav-link w-full flex items-center px-3 py-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-gray-900 hover:bg-gray-50 dark:hover:text-white dark:hover:bg-white/5 text-left"
        >
          {isDark ? <Sun className="w-5 h-5 shrink-0" /> : <Moon className="w-5 h-5 shrink-0" />}
          <span className="sidebar-text ml-3 text-sm font-medium">Toggle Theme</span>
        </button>
        <NavItem
          active={activePage === 'account'}
          title="Account Settings"
          label="Settings"
          icon={<Settings className="w-5 h-5" />}
          onClick={() => go('/account/settings')}
        />
        <NavItem
          title="Log out"
          label="Log out"
          danger
          icon={<LogOut className="w-5 h-5" />}
          onClick={() => void handleLogout()}
        />
        <div className="nav-link flex items-center px-3 py-3 mt-1 border-t border-gray-100 dark:border-white/5">
          <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-xs font-semibold shrink-0">
            {initial}
          </div>
          <div className="sidebar-text ml-3 min-w-0">
            <div className="text-sm font-medium truncate">{user?.name || 'User'}</div>
            <div className="text-[10px] text-gray-500 truncate">{user?.email || ''}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
