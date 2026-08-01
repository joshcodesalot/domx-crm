import { useMemo, useState } from 'react';
import {
  FolderPlus,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import {
  createScriptFolder,
  deleteCreatorScript,
  deleteScriptFolder,
  updateScriptFolder,
  type CreatorScript,
  type CreatorScriptFolder,
  type ScriptPlatform,
} from '@/lib/api';
import { useConfirm } from '@/context/ConfirmDialogContext';
import ScriptEditorModal from './ScriptEditorModal';
import type { CreatorScriptMediaItem } from '@/lib/api';

export interface ScriptManageModalProps {
  creatorId: string;
  platform: ScriptPlatform;
  folders: CreatorScriptFolder[];
  scripts: CreatorScript[];
  onClose: () => void;
  onChanged: (next: {
    folders: CreatorScriptFolder[];
    scripts: CreatorScript[];
  }) => void;
  onRequestVaultPick: () => void;
  pendingVaultMedia?: CreatorScriptMediaItem[] | null;
  onPendingVaultMediaConsumed?: () => void;
}

export default function ScriptManageModal({
  creatorId,
  platform,
  folders,
  scripts,
  onClose,
  onChanged,
  onRequestVaultPick,
  pendingVaultMedia,
  onPendingVaultMediaConsumed,
}: ScriptManageModalProps) {
  const confirm = useConfirm();
  const [localFolders, setLocalFolders] = useState(folders);
  const [localScripts, setLocalScripts] = useState(scripts);
  const [editorScript, setEditorScript] = useState<CreatorScript | null | 'new'>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scriptsByFolder = useMemo(() => {
    const map = new Map<string | null, CreatorScript[]>();
    map.set(null, []);
    for (const f of localFolders) map.set(f.id, []);
    for (const s of localScripts) {
      const key = s.folderId && map.has(s.folderId) ? s.folderId : null;
      map.get(key)!.push(s);
    }
    return map;
  }, [localFolders, localScripts]);

  function pushChange(
    nextFolders: CreatorScriptFolder[],
    nextScripts: CreatorScript[]
  ) {
    setLocalFolders(nextFolders);
    setLocalScripts(nextScripts);
    onChanged({ folders: nextFolders, scripts: nextScripts });
  }

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name || busyId) return;
    setBusyId('folder-create');
    setError(null);
    try {
      const folder = await createScriptFolder(creatorId, { platform, name });
      pushChange([...localFolders, folder], localScripts);
      setNewFolderName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRenameFolder(folderId: string) {
    const name = renameValue.trim();
    if (!name) return;
    setBusyId(folderId);
    setError(null);
    try {
      const updated = await updateScriptFolder(creatorId, folderId, { name });
      pushChange(
        localFolders.map((f) => (f.id === folderId ? updated : f)),
        localScripts
      );
      setRenamingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename folder');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteFolder(folderId: string) {
    const ok = await confirm({
      title: 'Delete folder',
      message: 'Delete this folder? Scripts will move to No folder.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(folderId);
    setError(null);
    try {
      await deleteScriptFolder(creatorId, folderId);
      pushChange(
        localFolders.filter((f) => f.id !== folderId),
        localScripts.map((s) =>
          s.folderId === folderId ? { ...s, folderId: null } : s
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete folder');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDeleteScript(scriptId: string) {
    const ok = await confirm({
      title: 'Delete script',
      message: 'Delete this script?',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(scriptId);
    setError(null);
    try {
      await deleteCreatorScript(creatorId, scriptId);
      pushChange(
        localFolders,
        localScripts.filter((s) => s.id !== scriptId)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete script');
    } finally {
      setBusyId(null);
    }
  }

  function renderScriptRow(script: CreatorScript) {
    return (
      <div
        key={script.id}
        className="flex items-center gap-2 px-3 py-2 rounded-xl bg-gray-50 dark:bg-zinc-900/80 border border-gray-100 dark:border-zinc-800"
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
            {script.title}
          </p>
          <p className="text-[11px] text-gray-500 dark:text-zinc-500 truncate">
            {script.shortcutCode ? `/${script.shortcutCode}` : 'No shortcut'}
            {script.price > 0 ? ` · €${script.price}` : ''}
            {script.media.length > 0 ? ` · ${script.media.length} media` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditorScript(script)}
          className="p-1.5 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-zinc-800"
          title="Edit"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void handleDeleteScript(script.id)}
          disabled={busyId === script.id}
          className="p-1.5 rounded-lg text-red-500 hover:bg-red-500/10 disabled:opacity-40"
          title="Delete"
        >
          {busyId === script.id ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
        <button
          type="button"
          aria-label="Close modal backdrop"
          className="absolute inset-0 bg-black/50"
          onClick={onClose}
        />
        <div className="relative bg-white dark:bg-[#111] rounded-2xl shadow-xl w-full max-w-lg border border-gray-200 dark:border-white/10 flex flex-col max-h-[85vh]">
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 shrink-0">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                Manage scripts
              </h3>
              <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">
                Create, edit, or remove scripts and folders
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-gray-500 dark:text-zinc-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-zinc-800"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="border-t border-gray-100 dark:border-zinc-800" />

          <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5 min-h-0">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEditorScript('new')}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-domx-600 hover:bg-domx-500 rounded-xl"
              >
                <Plus className="w-4 h-4" />
                New script
              </button>
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
                Folders
              </p>
              <div className="flex items-center gap-2 mb-3">
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="New folder name…"
                  className="flex-1 px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
                />
                <button
                  type="button"
                  onClick={() => void handleCreateFolder()}
                  disabled={!newFolderName.trim() || busyId === 'folder-create'}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 disabled:opacity-40"
                >
                  <FolderPlus className="w-4 h-4" />
                  Add
                </button>
              </div>

              {localFolders.map((folder) => (
                <div
                  key={folder.id}
                  className="mb-4 rounded-xl border border-gray-100 dark:border-zinc-800 overflow-hidden"
                >
                  <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-zinc-900/60">
                    {renamingId === folder.id ? (
                      <>
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          className="flex-1 px-2 py-1 text-sm rounded-lg border border-gray-200 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                          autoFocus
                        />
                        <button
                          type="button"
                          onClick={() => void handleRenameFolder(folder.id)}
                          className="text-xs font-medium text-domx-600"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={() => setRenamingId(null)}
                          className="text-xs text-gray-500"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="flex-1 text-sm font-medium text-gray-900 dark:text-white truncate">
                          {folder.name}
                        </p>
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingId(folder.id);
                            setRenameValue(folder.name);
                          }}
                          className="p-1 rounded text-gray-500 hover:text-gray-900 dark:hover:text-white"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteFolder(folder.id)}
                          className="p-1 rounded text-red-500 hover:bg-red-500/10"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                  <div className="p-2 space-y-1.5">
                    {(scriptsByFolder.get(folder.id) || []).length === 0 ? (
                      <p className="text-xs text-gray-400 dark:text-zinc-600 px-1 py-2">
                        Empty folder
                      </p>
                    ) : (
                      (scriptsByFolder.get(folder.id) || []).map(renderScriptRow)
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 dark:text-zinc-500 mb-2">
                No folder
              </p>
              <div className="space-y-1.5">
                {(scriptsByFolder.get(null) || []).length === 0 ? (
                  <p className="text-xs text-gray-400 dark:text-zinc-600 py-2">
                    No unfiled scripts
                  </p>
                ) : (
                  (scriptsByFolder.get(null) || []).map(renderScriptRow)
                )}
              </div>
            </div>

            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
        </div>
      </div>

      {editorScript !== null && (
        <ScriptEditorModal
          creatorId={creatorId}
          platform={platform}
          folders={localFolders}
          script={editorScript === 'new' ? null : editorScript}
          onClose={() => setEditorScript(null)}
          onFoldersChanged={(next) => {
            setLocalFolders(next);
            onChanged({ folders: next, scripts: localScripts });
          }}
          onSaved={(saved) => {
            const exists = localScripts.some((s) => s.id === saved.id);
            const nextScripts = exists
              ? localScripts.map((s) => (s.id === saved.id ? { ...s, ...saved } : s))
              : [...localScripts, saved];
            pushChange(localFolders, nextScripts);
            setEditorScript(null);
          }}
          onRequestVaultPick={onRequestVaultPick}
          pendingVaultMedia={pendingVaultMedia}
          onPendingVaultMediaConsumed={onPendingVaultMediaConsumed}
        />
      )}
    </>
  );
}
