import { Trash2 } from 'lucide-react';

interface RemoveCreatorModalProps {
  creatorName: string;
  removing: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function RemoveCreatorModal({
  creatorName,
  removing,
  onClose,
  onConfirm,
}: RemoveCreatorModalProps) {
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
          <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center shrink-0">
            <Trash2 className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Remove Creator</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Remove{' '}
              <span className="font-medium text-gray-900 dark:text-gray-100">
                {creatorName}
              </span>
              ? Their saved session will be deleted and chat access will stop.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={removing}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={removing}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {removing ? 'Removing...' : 'Remove Creator'}
          </button>
        </div>
      </div>
    </div>
  );
}
