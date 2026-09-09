import ToggleSwitch from '@/components/ToggleSwitch';
import type { AiCreatorSettings } from '@/lib/api';

const MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'suggest_only', label: 'Suggest only' },
  { value: 'auto_low_risk', label: 'Auto low-risk' },
];

function modeLabel(mode: string): string {
  switch (mode) {
    case 'off':
      return 'Off';
    case 'shadow':
      return 'Shadow';
    case 'suggest_only':
      return 'Suggest only';
    case 'auto_low_risk':
      return 'Auto low-risk';
    case 'auto':
      return 'Auto';
    case 'human_takeover':
      return 'Taken over';
    default:
      return mode;
  }
}

interface AiCreatorModeControlProps {
  creatorId: string;
  settings?: AiCreatorSettings;
  error?: string | null;
  saving?: boolean;
  onChange: (patch: { mode?: string; paused?: boolean }) => void;
}

export default function AiCreatorModeControl({
  creatorId,
  settings,
  error,
  saving = false,
  onChange,
}: AiCreatorModeControlProps) {
  const globalOff = settings?.globalEnabled === false;
  const disabled = !settings || saving || globalOff;
  const options = [...MODE_OPTIONS];
  if (
    settings &&
    (settings.mode === 'auto' || settings.mode === 'human_takeover') &&
    !options.some((option) => option.value === settings.mode)
  ) {
    options.push({ value: settings.mode, label: modeLabel(settings.mode) });
  }

  const showEffective =
    Boolean(settings?.globalEnabled) &&
    settings != null &&
    settings.effectiveMode !== settings.mode;

  return (
    <div className="flex flex-col items-end gap-0.5 mr-1 min-w-0">
      <div className="flex items-center gap-1.5">
        <select
          id={`ai-mode-${creatorId}`}
          aria-label="AI mode"
          value={settings?.mode ?? 'off'}
          disabled={disabled}
          onChange={(event) => onChange({ mode: event.target.value })}
          className="max-w-[9.5rem] px-1.5 py-1 text-xs border border-gray-200 dark:border-white/10 rounded-md bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span title="Pause AI" className="inline-flex">
          <ToggleSwitch
            checked={Boolean(settings?.paused)}
            disabled={disabled}
            onChange={(paused) => onChange({ paused })}
            aria-label="Pause AI"
          />
        </span>
      </div>
      {globalOff && (
        <span className="text-[10px] leading-tight text-gray-400">
          Global AI is off
        </span>
      )}
      {showEffective && settings && (
        <span className="text-[10px] leading-tight text-gray-400">
          Effective: {modeLabel(settings.effectiveMode)}
        </span>
      )}
      {error && (
        <span className="text-[10px] leading-tight text-red-400 max-w-[10rem] truncate" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
