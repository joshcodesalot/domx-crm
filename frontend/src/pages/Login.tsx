import { ArrowRight, Check, Loader2, Lock, Mail } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import ThemeToggle from '@/components/ThemeToggle';
import { useAuth } from '@/context/AuthContext';
import { APP_VERSION } from '@/lib/appVersion';

export default function Login() {
  const { login, isAuthenticated, isLoading, needsOwnerSetup, user } = useAuth();
  const location = useLocation();
  const redirectReason = (location.state as { reason?: string } | null)?.reason ?? null;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] dark:bg-darkbase-900">
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return (
      <Navigate
        to={user?.mustChangePassword ? '/change-password' : '/dashboard'}
        replace
      />
    );
  }

  if (needsOwnerSetup) {
    return <Navigate to="/setup" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('loading');

    try {
      await login(email, password);
      setStatus('success');
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  const buttonClass =
    status === 'success'
      ? 'w-full text-white bg-green-600 hover:bg-green-500 focus:ring-4 focus:outline-none focus:ring-green-500/50 font-medium rounded-lg text-sm px-5 py-2.5 text-center transition-all duration-200 shadow-sm mt-6 flex justify-center items-center gap-2'
      : 'w-full text-white bg-brand-600 hover:bg-brand-500 focus:ring-4 focus:outline-none focus:ring-brand-500/50 font-medium rounded-lg text-sm px-5 py-2.5 text-center transition-all duration-200 shadow-sm mt-6 flex justify-center items-center gap-2';

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
                Log in to Dom<span className="text-brand-500">X</span>
              </h1>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              {redirectReason && (
                <div className="text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
                  {redirectReason}
                </div>
              )}

              {error && (
                <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <div>
                <label
                  htmlFor="email"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  Work Email
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    id="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="bg-gray-50 dark:bg-darkbase-900 border border-gray-300 dark:border-darkbase-700 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 block w-full pl-10 p-2.5 transition-all duration-200 outline-none"
                    placeholder="name@company.com"
                    required
                    disabled={status === 'loading' || status === 'success'}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="password"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Password
                  </label>
                  <span className="text-xs font-medium text-brand-600 dark:text-brand-400">
                    Forgot password?
                  </span>
                </div>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                    <Lock className="w-4 h-4" />
                  </div>
                  <input
                    type="password"
                    id="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="bg-gray-50 dark:bg-darkbase-900 border border-gray-300 dark:border-darkbase-700 text-gray-900 dark:text-white text-sm rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-brand-500 block w-full pl-10 p-2.5 transition-all duration-200 outline-none"
                    required
                    disabled={status === 'loading' || status === 'success'}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={status === 'loading' || status === 'success'}
                className={buttonClass}
              >
                {status === 'loading' && (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Authenticating...</span>
                  </>
                )}
                {status === 'success' && (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Success</span>
                  </>
                )}
                {status === 'idle' && (
                  <>
                    <span>Sign In</span>
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
