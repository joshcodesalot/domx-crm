import {
  BarChart2,
  LayoutGrid,
  LogOut,
  MessagesSquare,
  UserCog,
  Users,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import ThemeToggle from '@/components/ThemeToggle';

interface SidebarProps {
  activePage?: 'dashboard' | 'analytics' | 'chatter' | 'creators' | 'staff';
}

export default function Sidebar({ activePage = 'dashboard' }: SidebarProps) {
  const { user, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  const initial = user?.name?.charAt(0).toUpperCase() || 'U';

  const navClass = (page: string) =>
    page === activePage
      ? 'text-gray-900 dark:text-white'
      : 'text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors';

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
          <>
            <button
              type="button"
              onClick={() => navigate('/chatter')}
              className={navClass('chatter')}
              title="Messages"
            >
              <MessagesSquare className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => navigate('/creators/manage')}
              className={navClass('creators')}
              title="Creators"
            >
              <Users className="w-5 h-5" />
            </button>
          </>
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
