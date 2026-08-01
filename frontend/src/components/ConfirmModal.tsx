import { useEffect } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';

export type ConfirmVariant = 'danger' | 'default';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: ConfirmVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const isDanger = variant === 'danger';
  const Icon = isDanger ? Trash2 : AlertTriangle;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 text-gray-900 dark:text-gray-100">
      <button
        type="button"
        aria-label="Close modal backdrop"
        className="absolute inset-0 bg-black/40 dark:bg-black/70"
        onClick={onCancel}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-md border border-gray-200 dark:border-white/10 p-6"
      >
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
              isDanger
                ? 'bg-red-100 dark:bg-red-900/30'
                : 'bg-amber-100 dark:bg-amber-900/30'
            }`}
          >
            <Icon
              className={`w-5 h-5 ${
                isDanger
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-600 dark:text-amber-400'
              }`}
            />
          </div>
          <div>
            <h3
              id="confirm-modal-title"
              className="text-lg font-semibold text-gray-900 dark:text-white"
            >
              {title}
            </h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 whitespace-pre-wrap">
              {message}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
              isDanger
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-brand-600 hover:bg-brand-500'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
