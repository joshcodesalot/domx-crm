import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useCreatorLive } from '@/context/CreatorLiveContext';
import { useToast } from '@/context/ToastContext';
import {
  createTelegramSextingSession,
  type Creator,
  type TelegramSextingGoal,
  type TelegramSextingIntensity,
  type TelegramSextingOrgasmRule,
  type TelegramSextingSession,
} from '@/lib/api';

const INTENSITY_OPTIONS: TelegramSextingIntensity[] = ['soft', 'medium', 'extreme'];
const ORGASM_OPTIONS: TelegramSextingOrgasmRule[] = [
  'denied',
  'ruined',
  'full',
  'multiple',
];
const GOAL_OPTIONS: TelegramSextingGoal[] = [
  'training',
  'punishment',
  'reward',
  'edge-only',
];

export const SEXTING_FORM_INPUT_CLASS =
  'w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1a1a1a] px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-zinc-500';

function formatLabel(value: string): string {
  return value
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function TelegramSextingSessionForm({
  defaultFanName = '',
  groupPeerId: lockedGroupPeerId = '',
  defaultCreatorIds = [],
  lockGroupId = false,
  lockCreators = false,
  groupLabel = '',
  compact = false,
  onCreated,
}: {
  defaultFanName?: string;
  groupPeerId?: string;
  defaultCreatorIds?: string[];
  lockGroupId?: boolean;
  lockCreators?: boolean;
  groupLabel?: string;
  compact?: boolean;
  onCreated: (session: TelegramSextingSession) => void;
}) {
  const { toast } = useToast();
  const { creators } = useCreatorLive({ platform: 'telegram' });
  const telegramCreators = useMemo(
    () => creators.filter((creator) => creator.platform === 'telegram'),
    [creators]
  );

  const [slaveName, setSlaveName] = useState('');
  const [fanName, setFanName] = useState(defaultFanName);
  const [groupPeerId, setGroupPeerId] = useState(lockedGroupPeerId);
  const [selectedCreatorIds, setSelectedCreatorIds] = useState<string[]>(defaultCreatorIds);
  const [creatorMenuOpen, setCreatorMenuOpen] = useState(false);
  const [toys, setToys] = useState('');
  const [intensity, setIntensity] = useState<TelegramSextingIntensity>('medium');
  const [orgasmRule, setOrgasmRule] = useState<TelegramSextingOrgasmRule>('denied');
  const [themes, setThemes] = useState('');
  const [goal, setGoal] = useState<TelegramSextingGoal>('training');
  const [scenario, setScenario] = useState('');
  const [extraInstructions, setExtraInstructions] = useState('');
  const [numberOfBlocks, setNumberOfBlocks] = useState(20);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (defaultFanName) setFanName(defaultFanName);
  }, [defaultFanName]);

  useEffect(() => {
    if (lockedGroupPeerId) setGroupPeerId(lockedGroupPeerId);
  }, [lockedGroupPeerId]);

  const defaultCreatorKey = defaultCreatorIds.join(',');
  useEffect(() => {
    if (!defaultCreatorKey) return;
    const extras = defaultCreatorKey.split(',').filter(Boolean);
    setSelectedCreatorIds((prev) => {
      const next = new Set([...prev, ...extras]);
      return [...next];
    });
  }, [defaultCreatorKey]);

  const selectedCreators = useMemo(
    () =>
      selectedCreatorIds
        .map((id) => telegramCreators.find((creator) => creator.id === id))
        .filter((creator): creator is Creator => Boolean(creator)),
    [selectedCreatorIds, telegramCreators]
  );

  function toggleCreator(id: string) {
    if (lockCreators) return;
    setSelectedCreatorIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  async function handleGenerate(event: FormEvent) {
    event.preventDefault();
    if (generating) return;
    if (!slaveName.trim() || !fanName.trim() || !groupPeerId.trim()) {
      toast.error('Slave name, fan name, and chat ID are required');
      return;
    }
    if (selectedCreatorIds.length === 0) {
      toast.error('Select at least one Telegram creator');
      return;
    }

    setGenerating(true);
    try {
      const result = await createTelegramSextingSession({
        slaveName: slaveName.trim(),
        fanName: fanName.trim(),
        groupPeerId: groupPeerId.trim(),
        creatorIds: selectedCreatorIds,
        toys: toys.trim(),
        intensity,
        orgasmRule,
        themes: themes.trim(),
        goal,
        scenario: scenario.trim(),
        extraInstructions: extraInstructions.trim(),
        numberOfBlocks,
      });
      toast.success('Session generated');
      onCreated(result.session);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate session');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleGenerate(event)}
      className={compact ? 'space-y-4' : 'max-w-3xl mx-auto p-6 space-y-5'}
    >
      {!compact && (
        <div>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-sky-500" />
            Generate Sexting Session
          </h1>
          <p className="text-sm text-gray-500 dark:text-zinc-500 mt-1">
            Creates {numberOfBlocks} blocks once (max 30). One creator is a 1:1 DM script;
            several creators rotate in a group.
          </p>
        </div>
      )}

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Slave name</span>
        <input
          className={SEXTING_FORM_INPUT_CLASS}
          value={slaveName}
          onChange={(event) => setSlaveName(event.target.value)}
          placeholder="worthless cock"
          required
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Fan name</span>
        <input
          className={SEXTING_FORM_INPUT_CLASS}
          value={fanName}
          onChange={(event) => setFanName(event.target.value)}
          placeholder="Session label, e.g. Jake"
          required
        />
      </label>

      {lockGroupId ? (
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Chat</span>
          <p className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-zinc-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100">
            {groupLabel || groupPeerId}
          </p>
        </div>
      ) : (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
            Chat ID
          </span>
          <input
            className={SEXTING_FORM_INPUT_CLASS}
            value={groupPeerId}
            onChange={(event) => setGroupPeerId(event.target.value)}
            placeholder="Telegram chat peer ID"
            required
          />
        </label>
      )}

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
          Blocks
        </span>
        <input
          type="number"
          min={1}
          max={30}
          className={SEXTING_FORM_INPUT_CLASS}
          value={numberOfBlocks}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) {
              setNumberOfBlocks(20);
              return;
            }
            setNumberOfBlocks(Math.min(30, Math.max(1, Math.floor(next))));
          }}
        />
      </label>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
          Creator list (Domme list)
        </span>
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (lockCreators) return;
              setCreatorMenuOpen((open) => !open);
            }}
            className={`${SEXTING_FORM_INPUT_CLASS} text-left`}
          >
            {selectedCreators.length === 0
              ? 'Select Telegram creators'
              : selectedCreators.map((creator) => creator.displayName).join(', ')}
          </button>
          {creatorMenuOpen && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#111] shadow-lg max-h-64 overflow-y-auto">
              {telegramCreators.length === 0 && (
                <p className="px-3 py-2 text-sm text-gray-500">No Telegram creators</p>
              )}
              {telegramCreators.map((creator) => {
                const checked = selectedCreatorIds.includes(creator.id);
                return (
                  <label
                    key={creator.id}
                    className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-white/5 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCreator(creator.id)}
                    />
                    <CreatorAvatar
                      avatarUrl={creator.avatarUrl}
                      displayName={creator.displayName}
                      className="w-5 h-5 rounded-full object-cover"
                      initialsClassName="w-5 h-5 rounded-full bg-gray-200 dark:bg-white/10 flex items-center justify-center text-[9px]"
                    />
                    <span>{creator.displayName}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Toy list</span>
        <input
          className={SEXTING_FORM_INPUT_CLASS}
          value={toys}
          onChange={(event) => setToys(event.target.value)}
          placeholder="penis pump, anal plug, prostate vibrator, dildo, cock ring, and lube"
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Intensity</span>
          <select
            className={SEXTING_FORM_INPUT_CLASS}
            value={intensity}
            onChange={(event) =>
              setIntensity(event.target.value as TelegramSextingIntensity)
            }
          >
            {INTENSITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {formatLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
            Orgasm rule
          </span>
          <select
            className={SEXTING_FORM_INPUT_CLASS}
            value={orgasmRule}
            onChange={(event) =>
              setOrgasmRule(event.target.value as TelegramSextingOrgasmRule)
            }
          >
            {ORGASM_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {formatLabel(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Goal</span>
          <select
            className={SEXTING_FORM_INPUT_CLASS}
            value={goal}
            onChange={(event) => setGoal(event.target.value as TelegramSextingGoal)}
          >
            {GOAL_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {formatLabel(option)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">Theme</span>
        <input
          className={SEXTING_FORM_INPUT_CLASS}
          value={themes}
          onChange={(event) => setThemes(event.target.value)}
          placeholder="small dick, cuck, pathetic loser"
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
          Scenario <span className="text-gray-400">(optional)</span>
        </span>
        <input
          className={SEXTING_FORM_INPUT_CLASS}
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
          placeholder="slow prostate milking with heavy denial"
        />
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-zinc-400">
          Extra instructions / fan limits
        </span>
        <textarea
          className={`${SEXTING_FORM_INPUT_CLASS} min-h-[96px] resize-y`}
          value={extraInstructions}
          onChange={(event) => setExtraInstructions(event.target.value)}
          placeholder="Keep the slave edged. No blood. No public risk."
        />
      </label>

      <button
        type="submit"
        disabled={generating}
        className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60"
      >
        {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
        {generating ? 'Generating… this can take a minute' : 'Generate session'}
      </button>
    </form>
  );
}
