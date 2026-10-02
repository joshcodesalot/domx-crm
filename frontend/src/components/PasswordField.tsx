import { Eye, EyeOff } from 'lucide-react';
import { useState, type InputHTMLAttributes } from 'react';

export default function PasswordField({
  id,
  label,
  className = '',
  ...props
}: {
  id: string;
  label: string;
} & InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium mb-1.5">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          {...props}
          type={visible ? 'text' : 'password'}
          className={`w-full rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-black/20 pl-3 pr-11 py-3 text-sm outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500 ${className}`}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg"
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
