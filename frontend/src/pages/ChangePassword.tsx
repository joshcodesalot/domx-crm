import { ArrowRight, Loader2 } from 'lucide-react';
import { FormEvent, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import AuthLayout from '@/components/AuthLayout';
import PasswordField from '@/components/PasswordField';
import { useAuth } from '@/context/AuthContext';
import { homePath } from '@/lib/homePath';

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
    return <Navigate to={homePath(user)} replace />;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setStatus('loading');

    try {
      await changePassword(newPassword, confirmPassword);
      navigate(homePath(user), { replace: true });
    } catch (err) {
      setStatus('idle');
      setError(err instanceof Error ? err.message : 'Failed to change password');
    }
  }

  const buttonClass =
    'w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand-600 hover:bg-brand-500 text-white font-semibold text-sm px-5 py-3 shadow-sm transition-colors';

  return (
    <AuthLayout
      title="Set your password"
      subtitle="Choose a new password before continuing."
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
        <PasswordField
          id="newPassword"
          label="New password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="••••••••"
          minLength={8}
          required
          disabled={status === 'loading'}
        />
        <PasswordField
          id="confirmPassword"
          label="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="••••••••"
          minLength={8}
          required
          disabled={status === 'loading'}
        />
        <button type="submit" disabled={status === 'loading'} className={buttonClass}>
          {status === 'loading' ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Updating...</span>
            </>
          ) : (
            <>
              <span>Update password</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </AuthLayout>
  );
}
