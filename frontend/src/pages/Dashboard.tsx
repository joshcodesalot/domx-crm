import { Navigate } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import { useAuth } from '@/context/AuthContext';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
}

export default function Dashboard() {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppLayout title="Overview" activePage="dashboard">
      <div className="max-w-5xl mx-auto">
        <div className="mb-10">
          <h2 className="text-2xl font-semibold mb-1">{getGreeting()}</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Welcome back, {user.name}
          </p>
        </div>

        <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 flex items-center justify-center">
          <p className="text-sm text-gray-400 dark:text-gray-500">
            Your dashboard is ready. Content will appear here.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
