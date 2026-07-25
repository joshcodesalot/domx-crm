import { useEffect, useMemo, useState } from 'react';
import { Plus, SlidersHorizontal, X } from 'lucide-react';

const QUICK_EMOJIS_KEY = 'domx_quick_emojis';
const CUSTOM_EMOJIS_KEY = 'domx_custom_emojis';
const QUICK_EMOJIS_CHANGED_EVENT = 'domx:quick-emojis-changed';

const DEFAULT_QUICK_EMOJIS = ['🥰', '🔥', '💜', '😘', '🙈', '❤️', '💋', '😉'];

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Lust & Sex',
    emojis: ['😈', '💦', '🍑', '🍆', '👅', '👄', '🥵', '🍒'],
  },
  {
    label: 'Sexy & Teasing',
    emojis: ['😏', '😉', '😘', '💋', '🤤', '👀', '🫦', '💃'],
  },
  {
    label: 'Flirty',
    emojis: ['🥰', '😍', '💕', '💖', '💗', '💓', '💞', '💘', '❤️', '💜', '🧡', '💛'],
  },
  {
    label: 'Playful',
    emojis: ['🙈', '🤭', '😜', '🤪', '😋', '😛', '🤗', '😌', '✨', '🌟', '🔥', '💯'],
  },
];

function readStoredEmojis(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return fallback;
    const emojis = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return emojis.length > 0 || key === CUSTOM_EMOJIS_KEY ? emojis : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredEmojis(key: string, emojis: string[]) {
  localStorage.setItem(key, JSON.stringify(emojis));
}

/** Split a string into emoji graphemes (handles multi-codepoint emojis). */
function extractEmojis(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const parts: string[] = [];
    for (const { segment } of segmenter.segment(trimmed)) {
      const s = segment.trim();
      if (!s || /\s/.test(s)) continue;
      // Keep graphemes that look like emoji (skip plain letters/digits)
      if (/\p{Extended_Pictographic}/u.test(s) || /\p{Emoji_Presentation}/u.test(s)) {
        parts.push(s);
      }
    }
    return parts;
  }

  const matches = trimmed.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu);
  return matches ?? [];
}

interface QuickEmojiBarProps {
  onInsert: (emoji: string) => void;
  disabled?: boolean;
}

export default function QuickEmojiBar({ onInsert, disabled = false }: QuickEmojiBarProps) {
  const [quickEmojis, setQuickEmojis] = useState<string[]>(() =>
    readStoredEmojis(QUICK_EMOJIS_KEY, DEFAULT_QUICK_EMOJIS),
  );
  const [customEmojis, setCustomEmojis] = useState<string[]>(() =>
    readStoredEmojis(CUSTOM_EMOJIS_KEY, []),
  );
  const [modalOpen, setModalOpen] = useState(false);

  // Draft state while modal is open
  const [draftSelected, setDraftSelected] = useState<string[]>([]);
  const [draftCustom, setDraftCustom] = useState<string[]>([]);
  const [addInput, setAddInput] = useState('');

  // Keep Maloum + 4based bars in sync while both panels stay mounted
  useEffect(() => {
    function syncFromStorage() {
      setQuickEmojis(readStoredEmojis(QUICK_EMOJIS_KEY, DEFAULT_QUICK_EMOJIS));
      setCustomEmojis(readStoredEmojis(CUSTOM_EMOJIS_KEY, []));
    }
    window.addEventListener(QUICK_EMOJIS_CHANGED_EVENT, syncFromStorage);
    window.addEventListener('storage', syncFromStorage);
    return () => {
      window.removeEventListener(QUICK_EMOJIS_CHANGED_EVENT, syncFromStorage);
      window.removeEventListener('storage', syncFromStorage);
    };
  }, []);

  useEffect(() => {
    if (!modalOpen) return;
    setDraftSelected([...quickEmojis]);
    setDraftCustom([...customEmojis]);
    setAddInput('');
  }, [modalOpen, quickEmojis, customEmojis]);

  const catalogCategories = useMemo(() => {
    const categories = [...EMOJI_CATEGORIES];
    if (draftCustom.length > 0) {
      categories.push({ label: 'Your emojis', emojis: draftCustom });
    }
    return categories;
  }, [draftCustom]);

  function toggleEmoji(emoji: string) {
    setDraftSelected((prev) =>
      prev.includes(emoji) ? prev.filter((e) => e !== emoji) : [...prev, emoji],
    );
  }

  function handleAddCustom() {
    const extracted = extractEmojis(addInput);
    if (extracted.length === 0) return;
    setDraftCustom((prev) => {
      const next = [...prev];
      for (const emoji of extracted) {
        if (!next.includes(emoji)) next.push(emoji);
      }
      return next;
    });
    // Auto-select newly added emojis
    setDraftSelected((prev) => {
      const next = [...prev];
      for (const emoji of extracted) {
        if (!next.includes(emoji)) next.push(emoji);
      }
      return next;
    });
    setAddInput('');
  }

  function removeCustom(emoji: string) {
    setDraftCustom((prev) => prev.filter((e) => e !== emoji));
    setDraftSelected((prev) => prev.filter((e) => e !== emoji));
  }

  function handleSave() {
    const selected = draftSelected.length > 0 ? draftSelected : DEFAULT_QUICK_EMOJIS;
    writeStoredEmojis(QUICK_EMOJIS_KEY, selected);
    writeStoredEmojis(CUSTOM_EMOJIS_KEY, draftCustom);
    setQuickEmojis(selected);
    setCustomEmojis(draftCustom);
    window.dispatchEvent(new Event(QUICK_EMOJIS_CHANGED_EVENT));
    setModalOpen(false);
  }

  function handleCancel() {
    setModalOpen(false);
  }

  return (
    <>
      <div className="flex items-center gap-1.5 mb-2 px-0.5">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          disabled={disabled}
          className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0 disabled:opacity-40"
          title="Quick emoji selection"
          aria-label="Customize quick emojis"
        >
          <SlidersHorizontal className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-gray-200 dark:bg-zinc-700 shrink-0" />
        <div className="flex items-center gap-0.5 overflow-x-auto min-w-0">
          {quickEmojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onInsert(emoji)}
              disabled={disabled}
              className="w-8 h-8 flex items-center justify-center text-lg rounded-lg hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors shrink-0 disabled:opacity-40"
              title={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close modal backdrop"
            className="absolute inset-0 bg-black/50"
            onClick={handleCancel}
          />

          <div className="relative bg-white dark:bg-[#111] rounded-2xl shadow-xl w-full max-w-md border border-gray-200 dark:border-white/10 flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 shrink-0">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                  Quick emoji selection
                </h3>
                <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">
                  Emojis for quick access
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-sm font-medium text-red-500 dark:text-red-400">
                  {draftSelected.length} selected
                </span>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="p-1 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="border-t border-gray-100 dark:border-zinc-800" />

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5 min-h-0">
              {/* Preview */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
                  Preview
                </p>
                <div className="flex items-center gap-1 px-3 py-2.5 rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/80 min-h-[44px]">
                  {draftSelected.length === 0 ? (
                    <span className="text-xs text-gray-400 dark:text-zinc-600">
                      No emojis selected
                    </span>
                  ) : (
                    draftSelected.map((emoji) => (
                      <span key={emoji} className="text-xl leading-none">
                        {emoji}
                      </span>
                    ))
                  )}
                </div>
              </div>

              {/* Categories */}
              {catalogCategories.map((category) => (
                <div key={category.label}>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
                    {category.label}
                  </p>
                  <div className="grid grid-cols-8 gap-1.5">
                    {category.emojis.map((emoji) => {
                      const selected = draftSelected.includes(emoji);
                      const isCustom = category.label === 'Your emojis';
                      return (
                        <button
                          key={`${category.label}-${emoji}`}
                          type="button"
                          onClick={() => toggleEmoji(emoji)}
                          title={isCustom ? 'Click to toggle · hover to remove' : emoji}
                          className={`relative group w-9 h-9 flex items-center justify-center text-xl rounded-xl border transition-colors ${
                            selected
                              ? 'bg-red-900/40 border-red-700/50 dark:bg-red-950/60 dark:border-red-800/60'
                              : 'bg-gray-100 dark:bg-zinc-900 border-transparent hover:bg-gray-200 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {emoji}
                          {isCustom && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                removeCustom(emoji);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  removeCustom(emoji);
                                }
                              }}
                              className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                              aria-label={`Remove ${emoji}`}
                            >
                              <X className="w-2.5 h-2.5" />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Add your own */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
                  Add your own
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={addInput}
                    onChange={(e) => setAddInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustom();
                      }
                    }}
                    placeholder="Type or paste emojis..."
                    className="flex-1 px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-domx-500/40"
                  />
                  <button
                    type="button"
                    onClick={handleAddCustom}
                    disabled={!addInput.trim()}
                    className="w-9 h-9 flex items-center justify-center rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-600 dark:text-zinc-300 hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
                    aria-label="Add emojis"
                    title="Add"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <p className="text-xs text-gray-500 dark:text-zinc-500 mt-2">
                  Paste several at once. Added emojis join your catalog — hover one to remove it.
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-zinc-800 shrink-0">
              <button
                type="button"
                onClick={handleCancel}
                className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                className="px-5 py-2 text-sm font-semibold text-white bg-domx-600 hover:bg-domx-500 rounded-xl transition-colors shadow-lg shadow-domx-600/20"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
