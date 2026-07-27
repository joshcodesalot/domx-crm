import { useEffect, useState } from 'react';
import { ImageIcon, Loader2, Trash2, X } from 'lucide-react';
import {
  createCreatorScript,
  createScriptFolder,
  updateCreatorScript,
  type CreatorScript,
  type CreatorScriptFolder,
  type CreatorScriptMediaItem,
  type ScriptPlatform,
} from '@/lib/api';

export interface ScriptEditorModalProps {
  creatorId: string;
  platform: ScriptPlatform;
  folders: CreatorScriptFolder[];
  script: CreatorScript | null;
  onClose: () => void;
  onSaved: (script: CreatorScript, folders?: CreatorScriptFolder[]) => void;
  onFoldersChanged: (folders: CreatorScriptFolder[]) => void;
  onRequestVaultPick: () => void;
  pendingVaultMedia?: CreatorScriptMediaItem[] | null;
  onPendingVaultMediaConsumed?: () => void;
}

export default function ScriptEditorModal({
  creatorId,
  platform,
  folders,
  script,
  onClose,
  onSaved,
  onFoldersChanged,
  onRequestVaultPick,
  pendingVaultMedia,
  onPendingVaultMediaConsumed,
}: ScriptEditorModalProps) {
  const isEdit = Boolean(script);
  const [title, setTitle] = useState(script?.title || '');
  const [shortcutCode, setShortcutCode] = useState(script?.shortcutCode || '');
  const [messageText, setMessageText] = useState(script?.messageText || '');
  const [price, setPrice] = useState(
    script?.price != null && script.price > 0 ? String(script.price) : ''
  );
  const [folderId, setFolderId] = useState<string>(script?.folderId || '');
  const [media, setMedia] = useState<CreatorScriptMediaItem[]>(script?.media || []);
  const [newFolderName, setNewFolderName] = useState('');
  const [saving, setSaving] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingVaultMedia?.length) return;
    setMedia((prev) => {
      const seen = new Set(prev.map((m) => m.mediaKey));
      const next = [...prev];
      for (const item of pendingVaultMedia) {
        if (!item.mediaKey || seen.has(item.mediaKey)) continue;
        seen.add(item.mediaKey);
        next.push(item);
      }
      return next;
    });
    onPendingVaultMediaConsumed?.();
  }, [pendingVaultMedia, onPendingVaultMediaConsumed]);

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name || creatingFolder) return;
    setCreatingFolder(true);
    setError(null);
    try {
      const folder = await createScriptFolder(creatorId, { platform, name });
      onFoldersChanged([...folders, folder]);
      setFolderId(folder.id);
      setNewFolderName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create folder');
    } finally {
      setCreatingFolder(false);
    }
  }

  async function handleSave() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;
    setSaving(true);
    setError(null);
    try {
      const priceNum = price.trim() ? Number(price) : 0;
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        setError('Price must be a non-negative number');
        setSaving(false);
        return;
      }
      const payload = {
        title: trimmedTitle,
        shortcutCode: shortcutCode.trim() || null,
        messageText,
        price: priceNum,
        media,
        folderId: folderId || null,
      };
      const saved = isEdit && script
        ? await updateCreatorScript(creatorId, script.id, payload)
        : await createCreatorScript(creatorId, { platform, ...payload });
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save script');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />
      <div className="relative bg-white dark:bg-[#111] rounded-2xl shadow-xl w-full max-w-lg border border-gray-200 dark:border-white/10 flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">
              {isEdit ? 'Edit script' : 'Create script'}
            </h3>
            <p className="text-sm text-gray-500 dark:text-zinc-400 mt-0.5">
              Message, media, price, and shortcut
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

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4 min-h-0">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1.5">
              Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Welcome PPV"
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1.5">
                Shortcut code
              </label>
              <input
                type="text"
                value={shortcutCode}
                onChange={(e) => setShortcutCode(e.target.value)}
                placeholder="welcome1"
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1.5">
                Price
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0"
                className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1.5">
              Folder
            </label>
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
            >
              <option value="">No folder</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="New folder name…"
                className="flex-1 px-3 py-1.5 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40"
              />
              <button
                type="button"
                onClick={() => void handleCreateFolder()}
                disabled={!newFolderName.trim() || creatingFolder}
                className="px-3 py-1.5 text-xs font-medium rounded-xl border border-gray-200 dark:border-zinc-800 text-gray-700 dark:text-zinc-200 hover:bg-gray-100 dark:hover:bg-zinc-800 disabled:opacity-40"
              >
                {creatingFolder ? '…' : 'Add'}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-zinc-400 mb-1.5">
              Message
            </label>
            <textarea
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              rows={4}
              placeholder="Script message text…"
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-domx-500/40 resize-y"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium text-gray-500 dark:text-zinc-400">
                Media ({media.length})
              </label>
              <button
                type="button"
                onClick={onRequestVaultPick}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-domx-600/15 text-domx-600 dark:text-domx-400 hover:bg-domx-600/25"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                Add from vault
              </button>
            </div>
            {media.length === 0 ? (
              <p className="text-xs text-gray-400 dark:text-zinc-600 py-3 text-center border border-dashed border-gray-200 dark:border-zinc-800 rounded-xl">
                No media attached
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {media.map((item) => (
                  <div
                    key={item.mediaKey}
                    className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-200 dark:border-zinc-800 bg-zinc-900"
                  >
                    {item.previewUrl ? (
                      <img
                        src={item.previewUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-zinc-500">
                        {item.type || 'media'}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setMedia((prev) => prev.filter((m) => m.mediaKey !== item.mediaKey))
                      }
                      className="absolute top-0.5 right-0.5 p-0.5 rounded bg-black/70 text-white"
                      aria-label="Remove media"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-zinc-800 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 dark:text-zinc-300 hover:text-gray-900 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!title.trim() || saving}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-semibold text-white bg-domx-600 hover:bg-domx-500 rounded-xl disabled:opacity-40"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            {isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
