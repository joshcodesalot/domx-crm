import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import {
  upsertVaultMediaNote,
  type VaultNotePlatform,
} from '@/lib/api';

const VAULT_NOTE_MAX_LENGTH = 2000;

const textareaClassName =
  'w-full min-h-[120px] px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 focus:outline-none focus:ring-2 focus:ring-brand-500/40 resize-y';

export interface VaultMediaNoteModalProps {
  creatorId: string;
  platform: VaultNotePlatform;
  mediaKey: string;
  initialNote: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: (note: string) => void;
}

export default function VaultMediaNoteModal({
  creatorId,
  platform,
  mediaKey,
  initialNote,
  canEdit,
  onClose,
  onSaved,
}: VaultMediaNoteModalProps) {
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNote(initialNote);
    setError(null);
  }, [initialNote, mediaKey]);

  const trimmed = note.trim();
  const unchanged = trimmed === initialNote.trim();
  const tooLong = trimmed.length > VAULT_NOTE_MAX_LENGTH;
  const canSave = canEdit && !unchanged && !tooLong && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await upsertVaultMediaNote(creatorId, platform, mediaKey, trimmed);
      onSaved(result.note || '');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save note');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!canEdit || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await upsertVaultMediaNote(creatorId, platform, mediaKey, '');
      onSaved(result.note || '');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear note');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />

      <div
        className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-white/10 p-6"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
            <Info className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold">Vault note</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {canEdit
                ? 'Internal DomX note for this vault item. Not synced to the platform.'
                : 'Internal DomX note for this vault item.'}
            </p>
          </div>
        </div>

        {canEdit ? (
          <div className="mb-4">
            <label
              htmlFor="vault-media-note"
              className="block text-sm font-medium mb-1.5"
            >
              Note
            </label>
            <textarea
              id="vault-media-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a description or note…"
              className={textareaClassName}
              disabled={saving}
              autoFocus
              maxLength={VAULT_NOTE_MAX_LENGTH + 50}
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 text-right">
              {trimmed.length}/{VAULT_NOTE_MAX_LENGTH}
            </p>
          </div>
        ) : (
          <div className="mb-4 min-h-[80px] px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 whitespace-pre-wrap break-words">
            {initialNote.trim() ? (
              initialNote
            ) : (
              <span className="text-gray-400 dark:text-gray-500">No note</span>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 mb-4">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2">
          {canEdit && initialNote.trim() ? (
            <button
              type="button"
              onClick={() => void handleClear()}
              disabled={saving}
              className="mr-auto px-4 py-2 text-sm font-medium text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/40 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
            >
              Clear
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            {canEdit ? 'Cancel' : 'Close'}
          </button>
          {canEdit ? (
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface VaultMediaNoteButtonProps {
  hasNote: boolean;
  onOpen: () => void;
  className?: string;
}

/** Top-left overlay control for vault tiles. Callers must stopPropagation on open. */
export function VaultMediaNoteButton({
  hasNote,
  onOpen,
  className = '',
}: VaultMediaNoteButtonProps) {
  return (
    <button
      type="button"
      title={hasNote ? 'View note' : 'Add note'}
      aria-label={hasNote ? 'View vault media note' : 'Open vault media note'}
      className={`absolute top-1.5 left-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-full transition-colors ${
        hasNote
          ? 'bg-brand-600 text-white shadow-sm'
          : 'bg-black/55 text-white/90 hover:bg-black/70'
      } ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Info className="w-3.5 h-3.5" />
    </button>
  );
}
