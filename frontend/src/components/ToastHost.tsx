import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { ToastItem, ToastTone } from '@/context/ToastContext';

const TONE_STYLES: Record<
  ToastTone,
  { iconWrap: string; icon: typeof Info; border: string }
> = {
  error: {
    iconWrap: 'bg-red-100 dark:bg-red-900/30 text-red-600',
    icon: AlertCircle,
    border: 'border-red-200 dark:border-red-900/40',
  },
  success: {
    iconWrap: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600',
    icon: CheckCircle2,
    border: 'border-emerald-200 dark:border-emerald-900/40',
  },
  info: {
    iconWrap: 'bg-sky-100 dark:bg-sky-900/30 text-sky-600',
    icon: Info,
    border: 'border-gray-200 dark:border-white/10',
  },
};

interface ToastHostProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export default function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 z-[110] flex flex-col gap-2 w-full max-w-sm pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((toast) => {
        const style = TONE_STYLES[toast.tone];
        const Icon = style.icon;
        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-white dark:bg-[#111] shadow-lg px-4 py-3 ${style.border}`}
            role="status"
          >
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${style.iconWrap}`}
            >
              <Icon className="w-4 h-4" />
            </div>
            <p className="flex-1 text-sm text-gray-800 dark:text-zinc-200 pt-1 whitespace-pre-wrap">
              {toast.message}
            </p>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-white/5 shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
