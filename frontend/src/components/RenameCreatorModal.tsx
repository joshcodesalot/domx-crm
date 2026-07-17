import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { renameCreator } from '@/lib/api';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 focus:outline-none focus:ring-2 focus:ring-brand-500/40';

interface RenameCreatorModalProps {
  creatorId: string;
  currentDisplayName: string;
  onClose: () => void;
  onSaved: () => void;
}

export default function RenameCreatorModal({
  creatorId,
  currentDisplayName,
  onClose,
  onSaved,
}: RenameCreatorModalProps) {
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = displayName.trim();
  const unchanged = trimmed === currentDisplayName.trim();
  const canSave = trimmed.length > 0 && !unchanged && !saving;

  async function handleSave() {
    if (!canSave) return;

    setSaving(true);
    setError(null);

    try {
      await renameCreator(creatorId, trimmed);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename creator');
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
            <Pencil className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold">Rename Creator</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Change how this creator appears in DomX. This does not change their
              Maloum username.
            </p>
          </div>
        </div>

        <div className="mb-4">
          <label
            htmlFor="rename-creator-display-name"
            className="block text-sm font-medium mb-1.5"
          >
            Display name
          </label>
          <input
            type="text"
            id="rename-creator-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Creator display name"
            className={inputClassName}
            autoFocus
            disabled={saving}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canSave) {
                void handleSave();
              }
            }}
          />
        </div>

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
            disabled={!canSave}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
