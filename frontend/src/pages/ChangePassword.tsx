import { ArrowRight, Loader2, Lock } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import ThemeToggle from '@/components/ThemeToggle';
import { useAuth } from '@/context/AuthContext';
import { APP_VERSION } from '@/lib/appVersion';

export default function ChangePassword() {
  const navigate = useNavigate();
  const { changePassword, isAuthenticated, isLoading, user } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading'>('idle');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] dark:bg-darkbase-900">
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!user?.mustChangePassword) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('loading');

    try {
      await changePassword(newPassword, confirmPassword);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Failed to change password');
    }
  }

  const buttonClass =
    'w-full text-white bg-brand-600 hover:bg-brand-500 focus:ring-4 focus:outline-none focus:ring-brand-500/50 font-medium rounded-lg text-sm px-5 py-2.5 text-center transition-all duration-200 shadow-sm mt-6 flex justify-center items-center gap-2';

  return (
    <div className="bg-[#F7F8FA] dark:bg-darkbase-900 text-gray-900 dark:text-gray-100 min-h-screen flex flex-col transition-colors duration-300 antialiased">
      <div className="absolute top-6 right-6">
        <ThemeToggle />
      </div>

      <main className="flex-grow flex items-center justify-center p-4">
        <div className="w-full max-w-[420px] bg-white dark:bg-darkbase-800 rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.04)] dark:shadow-[0_2px_15px_rgba(0,0,0,0.3)] border border-gray-200/60 dark:border-darkbase-700 overflow-hidden">
          <div className="p-8 sm:p-10">
            <div className="mb-8 text-center flex flex-col items-center">
              <div className="w-12 h-12 bg-gray-900 dark:bg-white rounded-lg flex items-center justify-center mb-5 shadow-sm">
                <span className="text-white dark:text-black font-bold text-xl tracking-tighter">
                  DX
                </span>
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white">
                Set Your Password
              </h1>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
                Choose a new password before continuing
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {error && (
                <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div>
                  <label
                    htmlFor="newPassword"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                  >
                    New Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type="password"
                      id="newPassword"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="bg-gray-50 dark:bg-darkbase-900 border border-gray-300 dark:border-darkbase-700 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 block w-full pl-10 p-2.5 transition-all duration-200 outline-none"
                      placeholder="••••••••"
                      minLength={8}
                      required
                      disabled={status === 'loading'}
                    />
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="confirmPassword"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                  >
                    Confirm Password
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                      <Lock className="w-4 h-4" />
                    </div>
                    <input
                      type="password"
                      id="confirmPassword"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="bg-gray-50 dark:bg-darkbase-900 border border-gray-300 dark:border-darkbase-700 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 block w-full pl-10 p-2.5 transition-all duration-200 outline-none"
                      placeholder="••••••••"
                      minLength={8}
                      required
                      disabled={status === 'loading'}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={status === 'loading'}
                  className={buttonClass}
                >
                  {status === 'loading' ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Updating...</span>
                    </>
                  ) : (
                    <>
                      <span>Update Password</span>
                      <ArrowRight className="w-4 h-4 opacity-70" />
                    </>
                  )}
              </button>
            </form>
          </div>
        </div>
      </main>

      <footer className="py-6 text-center text-xs text-gray-400 dark:text-gray-500 font-mono tracking-tight">
        DomX Dashboard &copy; 2026 • v{APP_VERSION}
      </footer>
    </div>
  );
}
