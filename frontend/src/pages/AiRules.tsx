import { useCallback, useEffect, useState } from 'react';
import AppLayout from '@/components/AppLayout';
import {
  approveAiRuleSuggestion,
  getAiRuleSuggestions,
  rejectAiRuleSuggestion,
  type AiRuleScope,
  type AiRuleSuggestion,
} from '@/lib/api';

const SCOPES: AiRuleScope[] = ['CREATOR', 'PLATFORM', 'FAN', 'GLOBAL'];

const selectClassName =
  'px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

export default function AiRules() {
  const [items, setItems] = useState<AiRuleSuggestion[]>([]);
  const [scopes, setScopes] = useState<Record<string, AiRuleScope>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAiRuleSuggestions('pending');
      setItems(result.suggestions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scopeFor = (item: AiRuleSuggestion): AiRuleScope =>
    scopes[item.id] || item.proposedScope || 'CREATOR';

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AppLayout title="AI Rules" activePage="aiRules">
      <p className="text-sm text-gray-500 dark:text-zinc-400 mb-4">
        Edit-send diffs wait here. Approving writes a scoped rule. Nothing is
        auto-promoted.
      </p>

      {error ? <p className="text-sm text-red-500 mb-4">{error}</p> : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-gray-500">Loading suggestions…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No pending rule suggestions.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-gray-200 dark:border-white/10 p-4"
            >
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">
                {item.platform || '—'} · {item.creatorId || 'creator'}
              </p>
              <p className="text-[11px] text-gray-500 mb-1">Before</p>
              <p className="text-sm text-gray-600 dark:text-zinc-400 mb-2 whitespace-pre-wrap">
                {item.beforeText || '—'}
              </p>
              <p className="text-[11px] text-gray-500 mb-1">After</p>
              <p className="text-sm text-gray-900 dark:text-zinc-100 mb-3 whitespace-pre-wrap">
                {item.afterText || '—'}
              </p>
              <p className="text-xs text-gray-500 mb-3">{item.proposedRule}</p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={scopeFor(item)}
                  onChange={(event) =>
                    setScopes((current) => ({
                      ...current,
                      [item.id]: event.target.value as AiRuleScope,
                    }))
                  }
                  disabled={busyId === item.id}
                  className={selectClassName}
                >
                  {SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() =>
                    run(item.id, async () => {
                      await approveAiRuleSuggestion(item.id, {
                        scope: scopeFor(item),
                      });
                    })
                  }
                  className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() =>
                    run(item.id, async () => {
                      await rejectAiRuleSuggestion(item.id);
                    })
                  }
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AppLayout>
  );
}
