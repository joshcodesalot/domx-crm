import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  getAiCreatorProfile,
  putAiCreatorProfile,
  type AiCreatorProfile,
} from '@/lib/api';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 focus:outline-none focus:ring-2 focus:ring-brand-500/40';

const labelClassName = 'block text-sm font-medium mb-1.5';

function listToText(values: string[]): string {
  return values.join(', ');
}

function terminologyToText(value: Record<string, string>): string {
  return Object.entries(value)
    .map(([term, replacement]) => `${term}: ${replacement}`)
    .join('\n');
}

function textToTerminology(value: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const term = trimmed.slice(0, sep).trim();
    const replacement = trimmed.slice(sep + 1).trim();
    if (term) next[term] = replacement;
  }
  return next;
}

interface AiCreatorProfileModalProps {
  creatorId: string;
  displayName: string;
  onClose: () => void;
}

export default function AiCreatorProfileModal({
  creatorId,
  displayName,
  onClose,
}: AiCreatorProfileModalProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [persona, setPersona] = useState('');
  const [tone, setTone] = useState('');
  const [languages, setLanguages] = useState('');
  const [biography, setBiography] = useState('');
  const [preferredTerminology, setPreferredTerminology] = useState('');
  const [prohibitedClaims, setProhibitedClaims] = useState('');
  const [salesStyle, setSalesStyle] = useState('');
  const [platformRules, setPlatformRules] = useState('{}');
  const [instructions, setInstructions] = useState('');

  function applyProfile(profile: AiCreatorProfile) {
    setVersion(profile.version || 0);
    setPersona(profile.persona || '');
    setTone(profile.tone || '');
    setLanguages(listToText(profile.languages || []));
    setBiography(profile.biography || '');
    setPreferredTerminology(
      terminologyToText(profile.preferredTerminology || {})
    );
    setProhibitedClaims(listToText(profile.prohibitedClaims || []));
    setSalesStyle(profile.salesStyle || '');
    setPlatformRules(
      JSON.stringify(profile.platformRules || {}, null, 2)
    );
    setInstructions(profile.instructions || '');
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const profile = await getAiCreatorProfile(creatorId);
        if (!cancelled) applyProfile(profile);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load AI profile'
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [creatorId]);

  async function handleSave() {
    let rules: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(platformRules.trim() || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Platform rules must be a JSON object');
        return;
      }
      rules = parsed as Record<string, unknown>;
    } catch {
      setError('Platform rules must be valid JSON');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const saved = await putAiCreatorProfile(creatorId, {
        persona,
        tone,
        languages: languages.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean),
        biography,
        preferredTerminology: textToTerminology(preferredTerminology),
        prohibitedClaims: prohibitedClaims
          .split(/[\n,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
        salesStyle,
        platformRules: rules,
        instructions,
      });
      applyProfile(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save AI profile');
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

      <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto border border-gray-200 dark:border-white/10 p-6">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold">AI profile</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Persona and instructions for {displayName}. This is not used for
              drafts yet. Version {version}.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-400 py-6">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor="ai-profile-persona" className={labelClassName}>
                Persona
              </label>
              <input
                id="ai-profile-persona"
                className={inputClassName}
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-tone" className={labelClassName}>
                Tone
              </label>
              <input
                id="ai-profile-tone"
                className={inputClassName}
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-languages" className={labelClassName}>
                Languages
              </label>
              <input
                id="ai-profile-languages"
                className={inputClassName}
                value={languages}
                onChange={(e) => setLanguages(e.target.value)}
                placeholder="de, en"
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-biography" className={labelClassName}>
                Biography
              </label>
              <textarea
                id="ai-profile-biography"
                className={inputClassName}
                rows={3}
                value={biography}
                onChange={(e) => setBiography(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-terms" className={labelClassName}>
                Preferred terminology
              </label>
              <textarea
                id="ai-profile-terms"
                className={inputClassName}
                rows={3}
                value={preferredTerminology}
                onChange={(e) => setPreferredTerminology(e.target.value)}
                placeholder={'cage: Käfig\nunlock: freischalten'}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-claims" className={labelClassName}>
                Prohibited claims
              </label>
              <textarea
                id="ai-profile-claims"
                className={inputClassName}
                rows={2}
                value={prohibitedClaims}
                onChange={(e) => setProhibitedClaims(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-sales" className={labelClassName}>
                Sales style
              </label>
              <input
                id="ai-profile-sales"
                className={inputClassName}
                value={salesStyle}
                onChange={(e) => setSalesStyle(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-rules" className={labelClassName}>
                Platform rules (JSON)
              </label>
              <textarea
                id="ai-profile-rules"
                className={`${inputClassName} font-mono text-xs`}
                rows={3}
                value={platformRules}
                onChange={(e) => setPlatformRules(e.target.value)}
                disabled={saving}
              />
            </div>
            <div>
              <label htmlFor="ai-profile-instructions" className={labelClassName}>
                Instructions
              </label>
              <textarea
                id="ai-profile-instructions"
                className={inputClassName}
                rows={4}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={saving}
              />
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400 mt-4">{error}</p>
        )}

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={loading || saving}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
