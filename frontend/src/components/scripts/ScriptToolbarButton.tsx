import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  FileText,
  Loader2,
  Search,
  Settings2,
} from 'lucide-react';
import {
  listCreatorScripts,
  type CreatorScript,
  type CreatorScriptFolder,
  type CreatorScriptMediaItem,
  type ScriptPlatform,
} from '@/lib/api';
import ScriptManageModal from './ScriptManageModal';
import ScriptEditorModal from './ScriptEditorModal';

export interface ScriptToolbarButtonProps {
  creatorId: string;
  platform: ScriptPlatform;
  fanId?: string | null;
  canManage: boolean;
  disabled?: boolean;
  onApply: (script: CreatorScript) => void;
  onRequestVaultPick: () => void;
  pendingVaultMedia?: CreatorScriptMediaItem[] | null;
  onPendingVaultMediaConsumed?: () => void;
  /** Increment to force a scripts reload (e.g. after mark sent). */
  refreshKey?: number;
}

export default function ScriptToolbarButton({
  creatorId,
  platform,
  fanId = null,
  canManage,
  disabled = false,
  onApply,
  onRequestVaultPick,
  pendingVaultMedia,
  onPendingVaultMediaConsumed,
  refreshKey = 0,
}: ScriptToolbarButtonProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manageMenuOpen, setManageMenuOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [folders, setFolders] = useState<CreatorScriptFolder[]>([]);
  const [scripts, setScripts] = useState<CreatorScript[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [folderFilter, setFolderFilter] = useState<string | 'all'>('all');

  const loadScripts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listCreatorScripts(creatorId, platform, fanId);
      setFolders(result.folders);
      setScripts(result.scripts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scripts');
    } finally {
      setLoading(false);
    }
  }, [creatorId, platform, fanId]);

  useEffect(() => {
    if (!pickerOpen && !manageOpen && !createOpen) return;
    void loadScripts();
  }, [pickerOpen, manageOpen, createOpen, loadScripts, refreshKey]);

  useEffect(() => {
    if (!pickerOpen && !manageMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setPickerOpen(false);
        setManageMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPickerOpen(false);
        setManageMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen, manageMenuOpen]);

  const filteredScripts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scripts.filter((s) => {
      if (folderFilter !== 'all') {
        if (folderFilter === 'none') {
          if (s.folderId) return false;
        } else if (s.folderId !== folderFilter) {
          return false;
        }
      }
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        (s.shortcutCode || '').toLowerCase().includes(q) ||
        s.messageText.toLowerCase().includes(q)
      );
    });
  }, [scripts, search, folderFilter]);

  function handleApply(script: CreatorScript) {
    onApply(script);
    setPickerOpen(false);
    setSearch('');
  }

  return (
    <div ref={rootRef} className="relative flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => {
          setManageMenuOpen(false);
          setPickerOpen((v) => !v);
        }}
        disabled={disabled}
        className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
        title="Scripts"
        aria-label="Open scripts"
        aria-expanded={pickerOpen}
      >
        <FileText className="w-4 h-4" />
        <span className="text-xs font-medium hidden sm:inline">Scripts</span>
      </button>

      {canManage && (
        <button
          type="button"
          onClick={() => {
            setPickerOpen(false);
            setManageMenuOpen((v) => !v);
          }}
          disabled={disabled}
          className="p-1.5 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800 transition-colors disabled:opacity-40"
          title="Manage scripts"
          aria-label="Manage scripts menu"
          aria-expanded={manageMenuOpen}
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}

      {manageMenuOpen && canManage && (
        <div className="absolute bottom-full right-0 mb-2 w-48 rounded-xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#151515] shadow-xl z-[70] py-1 overflow-hidden">
          <button
            type="button"
            onClick={() => {
              setManageMenuOpen(false);
              setCreateOpen(true);
            }}
            className="w-full text-left px-3 py-2 text-sm text-gray-800 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800"
          >
            Create script
          </button>
          <button
            type="button"
            onClick={() => {
              setManageMenuOpen(false);
              setManageOpen(true);
            }}
            className="w-full text-left px-3 py-2 text-sm text-gray-800 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 inline-flex items-center gap-2"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Manage scripts
          </button>
        </div>
      )}

      {pickerOpen && (
        <div className="absolute bottom-full right-0 mb-2 w-[min(100vw-2rem,22rem)] rounded-2xl border border-gray-200 dark:border-zinc-800 bg-white dark:bg-[#111] shadow-2xl z-[70] flex flex-col max-h-[min(70vh,28rem)] overflow-hidden">
          <div className="px-3 pt-3 pb-2 shrink-0 space-y-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search scripts or shortcut…"
                autoFocus
                className="w-full pl-8 pr-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-domx-500/40"
              />
            </div>
            <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
              <button
                type="button"
                onClick={() => setFolderFilter('all')}
                className={`shrink-0 px-2 py-1 text-[11px] rounded-lg border ${
                  folderFilter === 'all'
                    ? 'border-domx-500/50 bg-domx-600/15 text-domx-600 dark:text-domx-400'
                    : 'border-transparent bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-zinc-400'
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setFolderFilter('none')}
                className={`shrink-0 px-2 py-1 text-[11px] rounded-lg border ${
                  folderFilter === 'none'
                    ? 'border-domx-500/50 bg-domx-600/15 text-domx-600 dark:text-domx-400'
                    : 'border-transparent bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-zinc-400'
                }`}
              >
                Unfiled
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFolderFilter(f.id)}
                  className={`shrink-0 px-2 py-1 text-[11px] rounded-lg border max-w-[8rem] truncate ${
                    folderFilter === f.id
                      ? 'border-domx-500/50 bg-domx-600/15 text-domx-600 dark:text-domx-400'
                      : 'border-transparent bg-gray-100 dark:bg-zinc-900 text-gray-600 dark:text-zinc-400'
                  }`}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-gray-400">
                <Loader2 className="w-5 h-5 animate-spin" />
              </div>
            ) : error ? (
              <p className="text-xs text-red-400 px-2 py-4 text-center">{error}</p>
            ) : filteredScripts.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-zinc-600 px-2 py-6 text-center">
                No scripts found
              </p>
            ) : (
              <div className="space-y-1">
                {filteredScripts.map((script) => (
                  <button
                    key={script.id}
                    type="button"
                    onClick={() => handleApply(script)}
                    className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-gray-100 dark:hover:bg-zinc-800/80 transition-colors"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                            {script.title}
                          </p>
                          {script.sentToFan && (
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                              Sent
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-500 dark:text-zinc-500 mt-0.5 truncate">
                          {script.shortcutCode ? (
                            <span className="font-mono text-domx-600 dark:text-domx-400">
                              /{script.shortcutCode}
                            </span>
                          ) : null}
                          {script.shortcutCode ? ' · ' : ''}
                          {script.price > 0 ? `€${script.price}` : 'Free'}
                          {script.media.length > 0
                            ? ` · ${script.media.length} media`
                            : ''}
                        </p>
                        {script.messageText.trim() ? (
                          <p className="text-[11px] text-gray-400 dark:text-zinc-600 mt-1 line-clamp-2">
                            {script.messageText}
                          </p>
                        ) : null}
                      </div>
                      {script.media[0]?.previewUrl ? (
                        <img
                          src={script.media[0].previewUrl}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover shrink-0 border border-gray-200 dark:border-zinc-800"
                        />
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {manageOpen && (
        <ScriptManageModal
          creatorId={creatorId}
          platform={platform}
          folders={folders}
          scripts={scripts}
          onClose={() => setManageOpen(false)}
          onChanged={({ folders: nextFolders, scripts: nextScripts }) => {
            setFolders(nextFolders);
            setScripts(nextScripts);
          }}
          onRequestVaultPick={onRequestVaultPick}
          pendingVaultMedia={pendingVaultMedia}
          onPendingVaultMediaConsumed={onPendingVaultMediaConsumed}
        />
      )}

      {createOpen && (
        <ScriptEditorModal
          creatorId={creatorId}
          platform={platform}
          folders={folders}
          script={null}
          onClose={() => setCreateOpen(false)}
          onFoldersChanged={setFolders}
          onSaved={(saved) => {
            setScripts((prev) => [...prev, saved]);
            setCreateOpen(false);
          }}
          onRequestVaultPick={onRequestVaultPick}
          pendingVaultMedia={pendingVaultMedia}
          onPendingVaultMediaConsumed={onPendingVaultMediaConsumed}
        />
      )}
    </div>
  );
}
