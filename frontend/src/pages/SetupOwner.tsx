import { ArrowRight, Check, Loader2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import AuthLayout from '@/components/AuthLayout';
import PasswordField from '@/components/PasswordField';
import { useAuth } from '@/context/AuthContext';

export default function SetupOwner() {
  const { registerOwner, isAuthenticated, isLoading, needsOwnerSetup } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle');

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F7F8FA] dark:bg-darkbase-900">
        <div className="text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!needsOwnerSetup) {
    return <Navigate to="/login" replace />;
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setStatus('loading');

    try {
      await registerOwner(name, email, password);
      setStatus('success');
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Registration failed');
    }
  }

  const buttonClass =
    status === 'success'
      ? 'w-full inline-flex items-center justify-center gap-2 rounded-xl bg-green-600 hover:bg-green-500 text-white font-semibold text-sm px-5 py-3 shadow-sm transition-colors'
      : 'w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm px-5 py-3 shadow-sm transition-colors';

  const fieldClass =
    'w-full rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/20 px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500';

  return (
    <AuthLayout
      title="Create the owner account"
      subtitle="This account manages creators, staff, and the workspace."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="name" className="block text-sm font-medium mb-1.5">
            Full name
          </label>
          <input
            type="text"
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            placeholder="Your name"
            required
            disabled={status === 'loading' || status === 'success'}
          />
        </div>
        <div>
          <label htmlFor="email" className="block text-sm font-medium mb-1.5">
            Work email
          </label>
          <input
            type="email"
            id="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
            placeholder="name@company.com"
            required
            disabled={status === 'loading' || status === 'success'}
          />
        </div>
        <PasswordField
          id="password"
          label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
          minLength={8}
          disabled={status === 'loading' || status === 'success'}
        />
        <PasswordField
          id="confirmPassword"
          label="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="••••••••"
          required
          minLength={8}
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
              <span>Creating account...</span>
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
              <span>Create owner account</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
