import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import {
  getCreatorProxy,
  updateCreatorProxy,
  type Creator,
} from '@/lib/api';
import { parseLooseProxyLine } from '@/lib/proxyUrl';

const inputClassName =
  'w-full px-3 py-2 text-sm font-mono border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500';

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
  const [proxyLine, setProxyLine] = useState('');
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
        setEnvLabel(data.envLabel);
        if (data.proxyHost && data.proxyUsername) {
          setProxyLine(`${data.proxyHost}:${data.proxyUsername}`);
        } else {
          setProxyLine(data.proxyHost || '');
        }
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
    const line = proxyLine.trim();
    if (!line) {
      setSaving(true);
      setError(null);
      try {
        await updateCreatorProxy(creator.id, {
          proxyHost: '',
          proxyUsername: '',
          proxyPassword: '',
        });
        onSaved();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save proxy');
      } finally {
        setSaving(false);
      }
      return;
    }

    const parsed = parseLooseProxyLine(line);
    if (!parsed) {
      setError(
        'Use host:port:user:pass (for example isp.decodo.com:10001:user:pass).'
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateCreatorProxy(creator.id, {
        proxyHost: parsed.hostPort,
        proxyUsername: parsed.username,
        proxyPassword: parsed.password,
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
              Leave blank to use {envLabel} from .env.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Loading…</p>
        ) : (
          <div className="mb-4">
            <label className="block text-sm font-medium mb-1.5">
              Proxy{' '}
              <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={proxyLine}
              onChange={(e) => setProxyLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving && !loading) void handleSave();
              }}
              placeholder="isp.decodo.com:10001:user:pass"
              className={inputClassName}
              disabled={saving}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              host:port:user:pass
            </p>
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
