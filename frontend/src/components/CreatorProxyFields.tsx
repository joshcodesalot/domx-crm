import { Eye, EyeOff } from 'lucide-react';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-brand-500';

interface CreatorProxyFieldsProps {
  proxyHost: string;
  proxyUsername: string;
  proxyPassword: string;
  showPassword: boolean;
  envLabel: string;
  disabled?: boolean;
  passwordPlaceholder?: string;
  helperText?: string;
  onHostChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onToggleShowPassword: () => void;
  onEnter?: () => void;
}

export default function CreatorProxyFields({
  proxyHost,
  proxyUsername,
  proxyPassword,
  showPassword,
  envLabel,
  disabled = false,
  passwordPlaceholder = 'Optional',
  helperText,
  onHostChange,
  onUsernameChange,
  onPasswordChange,
  onToggleShowPassword,
  onEnter,
}: CreatorProxyFieldsProps) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1.5">
          Proxy Address:Port{' '}
          <span className="text-gray-400 font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={proxyHost}
          onChange={(e) => onHostChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && onEnter) onEnter();
          }}
          placeholder="host:port"
          className={inputClassName}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1.5">Username</label>
          <input
            type="text"
            value={proxyUsername}
            onChange={(e) => onUsernameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onEnter) onEnter();
            }}
            placeholder="Optional"
            className={inputClassName}
            disabled={disabled}
            autoComplete="off"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1.5">Password</label>
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={proxyPassword}
              onChange={(e) => onPasswordChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && onEnter) onEnter();
              }}
              placeholder={passwordPlaceholder}
              className={`${inputClassName} pr-10`}
              disabled={disabled}
              autoComplete="new-password"
            />
            <button
              type="button"
              onClick={onToggleShowPassword}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              aria-label={showPassword ? 'Hide proxy password' : 'Show proxy password'}
            >
              {showPassword ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </button>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {helperText ||
          `Leave blank to use ${envLabel} from the server (.env). Username and password are optional for IP-auth proxies.`}
      </p>
    </div>
  );
}
