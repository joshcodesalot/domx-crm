import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import {
  suggestReply,
  type SuggestReplyOption,
  type TranslateHistoryItem,
} from '@/lib/api';

export interface SuggestReplyApplyPayload {
  english: string;
  german: string;
  id: SuggestReplyOption['id'];
}

export interface SuggestReplyToolbarButtonProps {
  disabled?: boolean;
  /** Recent chat messages used as suggestion context. */
  getMessages: () => TranslateHistoryItem[];
  /** Optional async loader for fan notes (e.g. 4Based pivot). */
  getFanNotes?: () => Promise<string> | string;
  fanName?: string | null;
  onApply: (payload: SuggestReplyApplyPayload) => void;
}

export default function SuggestReplyToolbarButton({
  disabled = false,
  getMessages,
  getFanNotes,
  fanName = null,
  onApply,
}: SuggestReplyToolbarButtonProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SuggestReplyOption[] | null>(
    null
  );

  const loadSuggestions = useCallback(async () => {
    const messages = getMessages();
    if (messages.length === 0) {
      setError('Open a chat with messages first');
      setSuggestions(null);
      return;
    }

    setLoading(true);
    setError(null);
    setSuggestions(null);
    try {
      let fanNotes = '';
      if (getFanNotes) {
        fanNotes = (await getFanNotes()) || '';
      }
      const result = await suggestReply({
        messages,
        fanNotes,
        fanName: fanName || undefined,
      });
      setSuggestions(result.suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to draft replies');
    } finally {
      setLoading(false);
    }
  }, [getMessages, getFanNotes, fanName]);

  useEffect(() => {
    if (!open) return;
    void loadSuggestions();
    // Only draft when the popover opens; Refresh reloads explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleApply(option: SuggestReplyOption) {
    onApply({
      id: option.id,
      english: option.english,
      german: option.german,
    });
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
        title="AI suggest reply"
        aria-label="AI suggest reply"
        aria-expanded={open}
      >
        <Sparkles className="w-4 h-4" />
        <span className="text-xs font-medium hidden sm:inline">AI</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#151515] shadow-xl z-[70] overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 dark:border-zinc-800 flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-gray-800 dark:text-zinc-200">
              Suggest reply
            </p>
            <button
              type="button"
              onClick={() => void loadSuggestions()}
              disabled={loading}
              className="text-[11px] text-domx-600 dark:text-domx-400 hover:underline disabled:opacity-40"
            >
              Refresh
            </button>
          </div>

          <div className="max-h-80 overflow-y-auto p-2 space-y-2">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-500 dark:text-zinc-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                Drafting replies…
              </div>
            )}

            {!loading && error && (
              <p className="text-xs text-red-400 px-2 py-3">{error}</p>
            )}

            {!loading &&
              !error &&
              suggestions?.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleApply(option)}
                  className="w-full text-left rounded-lg border border-gray-200 dark:border-zinc-800 hover:border-domx-500/40 hover:bg-gray-50 dark:hover:bg-zinc-800/60 px-3 py-2.5 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-xs font-semibold text-gray-900 dark:text-white">
                      {option.label}
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400 dark:text-zinc-500">
                      {option.id === 'rapport' ? 'Tame' : 'Aggressive'}
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-500 dark:text-zinc-400 mb-1.5 leading-relaxed">
                    {option.english}
                  </p>
                  <p className="text-sm text-gray-900 dark:text-zinc-100 leading-relaxed">
                    {option.german}
                  </p>
                </button>
              ))}
          </div>

          <p className="px-3 py-2 text-[10px] text-gray-400 dark:text-zinc-500 border-t border-gray-100 dark:border-zinc-800">
            Selecting puts German in the chat box and skips re-translation.
          </p>
        </div>
      )}
    </div>
  );
}
