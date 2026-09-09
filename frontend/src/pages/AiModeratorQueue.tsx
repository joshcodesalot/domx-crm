import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import AppLayout from '@/components/AppLayout';
import {
  getAiQueue,
  getCreators,
  type AiIngestPlatform,
  type AiQueueBucket,
  type AiQueueItem,
  type Creator,
} from '@/lib/api';
import { useAiSuggestionEvents } from '@/hooks/useAiSuggestionEvents';

const TABS: { id: AiQueueBucket; label: string }[] = [
  { id: 'needs_review', label: 'Needs review' },
  { id: 'ai_handling', label: 'AI handling' },
  { id: 'taken_over', label: 'Taken over' },
  { id: 'paused', label: 'Paused' },
];

const selectClassName =
  'px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function formatWhen(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function chatterHref(item: AiQueueItem): string | null {
  if (!item.creatorId || !item.platformChatId) return null;
  const params = new URLSearchParams({
    creatorId: item.creatorId,
    chatId: item.platformChatId,
  });
  if (item.platform === 'maloum') return `/chatter?${params.toString()}`;
  if (item.platform === '4based') return `/chatter/4based?${params.toString()}`;
  return null;
}

export default function AiModeratorQueue() {
  const [bucket, setBucket] = useState<AiQueueBucket>('needs_review');
  const [creatorId, setCreatorId] = useState('');
  const [platform, setPlatform] = useState<AiIngestPlatform | ''>('');
  const [creators, setCreators] = useState<Creator[]>([]);
  const [items, setItems] = useState<AiQueueItem[]>([]);
  const [counts, setCounts] = useState<Record<AiQueueBucket, number>>({
    needs_review: 0,
    ai_handling: 0,
    taken_over: 0,
    paused: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getCreators()
      .then((result) => setCreators(result.creators || []))
      .catch(() => {
        // Filters stay empty if the creator list fails.
      });
  }, []);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAiQueue({
        bucket,
        creatorId: creatorId || undefined,
        platform: platform || undefined,
      });
      setItems(result.items || []);
      setCounts(result.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [bucket, creatorId, platform]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useAiSuggestionEvents({
    onSuggestion: () => {
      void loadQueue();
    },
  });

  const creatorOptions = useMemo(
    () =>
      creators
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [creators]
  );

  return (
    <AppLayout title="AI Queue" activePage="aiQueue">
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {TABS.map((tab) => {
          const active = bucket === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setBucket(tab.id)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                active
                  ? 'border-domx-600/40 bg-domx-50 dark:bg-domx-950/40 text-domx-700 dark:text-domx-300'
                  : 'border-gray-200 dark:border-white/10 text-gray-600 dark:text-zinc-300 hover:bg-gray-50 dark:hover:bg-white/5'
              }`}
            >
              {tab.label}
              <span className="ml-1.5 text-xs text-gray-400">
                {counts[tab.id] || 0}
              </span>
            </button>
          );
        })}
        <select
          value={creatorId}
          onChange={(event) => setCreatorId(event.target.value)}
          className={`${selectClassName} ml-auto`}
        >
          <option value="">All creators</option>
          {creatorOptions.map((creator) => (
            <option key={creator.id} value={creator.id}>
              {creator.displayName}
            </option>
          ))}
        </select>
        <select
          value={platform}
          onChange={(event) =>
            setPlatform(event.target.value as AiIngestPlatform | '')
          }
          className={selectClassName}
        >
          <option value="">All platforms</option>
          <option value="maloum">Maloum</option>
          <option value="4based">4based</option>
          <option value="telegram">Telegram</option>
        </select>
      </div>

      {error ? (
        <p className="text-sm text-red-500 mb-4">{error}</p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-gray-500">Loading queue…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing in this bucket.</p>
      ) : (
        <div className="border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-2 font-medium">Creator</th>
                <th className="px-4 py-2 font-medium">Platform</th>
                <th className="px-4 py-2 font-medium">Last inbound</th>
                <th className="px-4 py-2 font-medium">Draft</th>
                <th className="px-4 py-2 font-medium w-24" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const href = chatterHref(item);
                const preview =
                  item.suggestion?.replyEnglish?.trim() ||
                  item.suggestion?.reply?.trim() ||
                  '—';
                return (
                  <tr
                    key={item.conversationId}
                    className="border-t border-gray-100 dark:border-white/10"
                  >
                    <td className="px-4 py-3 text-gray-900 dark:text-zinc-100">
                      {item.creatorName}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{item.platform}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatWhen(item.lastInboundAt || item.lastMessageAt)}
                    </td>
                    <td className="px-4 py-3 text-gray-700 dark:text-zinc-300 max-w-md truncate">
                      {preview}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {href ? (
                        <Link
                          to={href}
                          className="text-xs px-2 py-1 rounded-md border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5"
                        >
                          Open
                        </Link>
                      ) : (
                        <span className="text-xs text-gray-400">Open</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AppLayout>
  );
}
