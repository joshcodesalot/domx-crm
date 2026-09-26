import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import CreatorProxyFields from '@/components/CreatorProxyFields';
import { getBrowserProfileProxy, updateBrowserProfileProxy } from '@/lib/api';
import { isValidProxyHostPort } from '@/lib/proxyUrl';

interface EditBrowserProxyModalProps {
  creator: { id: string; displayName: string };
  onClose: () => void;
  onSaved: () => void;
}

export default function EditBrowserProxyModal({
  creator,
  onClose,
  onSaved,
}: EditBrowserProxyModalProps) {
  const [proxyHost, setProxyHost] = useState('');
  const [proxyUsername, setProxyUsername] = useState('');
  const [proxyPassword, setProxyPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [hasProxy, setHasProxy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await getBrowserProfileProxy(creator.id);
        if (cancelled) return;
        setHasProxy(data.hasProxy);
        setProxyHost(data.proxyHost || '');
        setProxyUsername(data.proxyUsername || '');
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load browser proxy');
        }
      } finally {
        if (!cancelled) setLoading(false);
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
      await updateBrowserProfileProxy(creator.id, {
        proxyHost: host,
        proxyUsername: proxyUsername.trim(),
        proxyPassword,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save browser proxy');
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
          <div>
            <h3 className="text-lg font-semibold">Browser proxy</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Proxy for the Clearcote profile of {creator.displayName}. Location follows this
              proxy the next time the browser opens. Leave the address blank to clear it.
            </p>
          </div>
        </div>
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Loading…</p>
        ) : (
          <div className="mb-4">
            <CreatorProxyFields
              proxyHost={proxyHost}
              proxyUsername={proxyUsername}
              proxyPassword={proxyPassword}
              showPassword={showPassword}
              envLabel="browser proxy"
              disabled={saving}
              passwordPlaceholder={hasProxy ? 'Leave blank to keep existing' : 'Optional'}
              helperText="Empty Address:Port clears the browser proxy. A new profile starts from the creator proxy."
              onHostChange={setProxyHost}
              onUsernameChange={setProxyUsername}
              onPasswordChange={setProxyPassword}
              onToggleShowPassword={() => setShowPassword((value) => !value)}
              onEnter={() => {
                if (!saving && !loading) void handleSave();
              }}
            />
          </div>
        )}
        {error && <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>}
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
