import { ArrowRight, Check, Loader2, Mail } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import AuthLayout from '@/components/AuthLayout';
import PasswordField from '@/components/PasswordField';
import { useAuth } from '@/context/AuthContext';
import { homePath } from '@/lib/homePath';

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
        to={user?.mustChangePassword ? '/change-password' : homePath(user)}
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
      ? 'w-full inline-flex items-center justify-center gap-2 rounded-xl bg-green-600 hover:bg-green-500 text-white font-semibold text-sm px-5 py-3 shadow-sm transition-colors'
      : 'w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm px-5 py-3 shadow-sm transition-colors';

  return (
    <AuthLayout title="Welcome back" subtitle="Sign in with your work account to continue.">
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
          <label htmlFor="email" className="block text-sm font-medium mb-1.5">
            Work email
          </label>
          <div className="relative">
            <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="email"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/20 pl-10 pr-3 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500"
              placeholder="name@company.com"
              required
              disabled={status === 'loading' || status === 'success'}
            />
          </div>
        </div>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          placeholder="••••••••"
          required
          disabled={status === 'loading' || status === 'success'}
        />
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
              <span>Sign in</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
