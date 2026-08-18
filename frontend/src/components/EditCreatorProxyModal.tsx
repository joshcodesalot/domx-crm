import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import CreatorProxyFields from '@/components/CreatorProxyFields';
import {
  getCreatorProxy,
  updateCreatorProxy,
  type Creator,
} from '@/lib/api';
import { isValidProxyHostPort } from '@/lib/proxyUrl';

interface EditCreatorProxyModalProps {
  creator: Creator;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditCreatorProxyModal({
  creator,
  onClose,
  onSaved,
}: EditCreatorProxyModalProps) {
  const [proxyHost, setProxyHost] = useState('');
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hasCustomProxy, setHasCustomProxy] = useState(false);
  const [envLabel, setEnvLabel] = useState(
    creator.platform === '4based' ? 'FOURBASED_PROXY_URL' : 'MALOUM_PROXY_URL'
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await getCreatorProxy(creator.id);
        if (cancelled) return;
        setHasCustomProxy(data.hasCustomProxy);
        setProxyHost(data.proxyHost || '');
        setProxyUsername(data.proxyUsername || '');
        setEnvLabel(data.envLabel);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load proxy settings'
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [creator.id]);

  async function handleSave() {
    const host = proxyHost.trim();
    if (host && !isValidProxyHostPort(host)) {
      setError('Proxy address is invalid. Use host:port (for example 1.2.3.4:8080).');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateCreatorProxy(creator.id, {
        proxyHost: host,
        proxyUsername: proxyUsername.trim(),
        proxyPassword,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save proxy');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-white/10 p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
            <Globe className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold">Account proxy</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Set a proxy for {creator.displayName}. Leave the address blank to
              use {envLabel} from the server (.env).
              {creator.platform === 'maloum'
                ? ' Changing a Maloum proxy may require reconnecting so Cloudflare clearance matches the new IP.'
                : ''}
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Loading…</p>
        ) : (
          <div className="mb-4">
            <p className="text-xs text-gray-400 mb-3">
              Currently using:{' '}
              <span className="font-medium text-gray-600 dark:text-gray-300">
                {hasCustomProxy ? 'Custom proxy' : `.env (${envLabel})`}
              </span>
            </p>
            <CreatorProxyFields
              proxyHost={proxyHost}
              proxyUsername={proxyUsername}
              proxyPassword={proxyPassword}
              showPassword={showPassword}
              envLabel={envLabel}
              disabled={saving}
              passwordPlaceholder={
                hasCustomProxy ? 'Leave blank to keep existing' : 'Optional'
              }
              helperText={`Empty Address:Port saves as .env fallback (${envLabel}).`}
              onHostChange={setProxyHost}
              onUsernameChange={setProxyUsername}
              onPasswordChange={setProxyPassword}
              onToggleShowPassword={() => setShowPassword((v) => !v)}
              onEnter={() => {
                if (!saving && !loading) void handleSave();
              }}
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || loading}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
