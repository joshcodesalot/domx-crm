import { useCallback, useEffect, useMemo, useState } from 'react';
import AppLayout from '@/components/AppLayout';
import { useConfirm } from '@/context/ConfirmDialogContext';
import {
  approveAiRuleSuggestion,
  approveAiSopImport,
  createAiRule,
  createAiSop,
  deactivateAiRule,
  deactivateAiSop,
  deleteAiSop,
  getAiRuleSuggestions,
  getAiRules,
  getAiSops,
  getCreators,
  importAiSopGuide,
  patchAiRule,
  patchAiSop,
  rejectAiRuleSuggestion,
  rejectAiSopImport,
  type AiRule,
  type AiRuleScope,
  type AiRuleSuggestion,
  type AiSop,
  type AiSopDocumentType,
  type AiSopImportDraft,
  type AiSopOverlap,
  type AiSopOverlapSuggestion,
  type AiSopProposedJson,
  type AiSopScope,
  type Creator,
} from '@/lib/api';
import { formatCreatorOption } from '@/lib/formatCreator';

const SCOPES: AiRuleScope[] = ['CREATOR', 'PLATFORM', 'FAN', 'GLOBAL'];
const SOP_SCOPES: AiSopScope[] = ['GLOBAL', 'CREATOR'];
const PLATFORMS = ['maloum', '4based', 'telegram'] as const;
const MAX_RULE_TEXT = 500;
const RESOLUTIONS: AiSopOverlapSuggestion[] = [
  'keep_new',
  'keep_existing',
  'merge',
  'human_decide',
];

const selectClassName =
  'px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-white/5 focus:outline-none focus:ring-2 focus:ring-brand-500/40';

function emptyProposed(): AiSopProposedJson {
  return { documentType: 'sop', sops: [], profilePatch: null, shortRules: [] };
}

function overlapKey(item: AiSopOverlap): string {
  return `${item.existingId}::${item.newItem}`;
}

function claimsToText(values: string[] | undefined): string {
  return (values || []).join('\n');
}

function textToClaims(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function terminologyToText(value: Record<string, string> | undefined): string {
  return Object.entries(value || {})
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

function formatStamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function creatorLabel(creators: Creator[], id: string | null): string {
  if (!id) return '—';
  const creator = creators.find((item) => item.id === id);
  return creator ? formatCreatorOption(creator) : id;
}

type RuleEdit = {
  id: string;
  text: string;
  scope: AiRuleScope;
  creatorId: string;
  platform: string;
};

type SopEdit = {
  id: string;
  title: string;
  body: string;
  scope: AiSopScope;
  creatorId: string;
};

function emptyRuleDraft(): {
  text: string;
  scope: AiRuleScope;
  creatorId: string;
  platform: string;
  platformFanId: string;
} {
  return {
    text: '',
    scope: 'GLOBAL',
    creatorId: '',
    platform: '',
    platformFanId: '',
  };
}

function emptySopDraft(): {
  title: string;
  body: string;
  scope: AiSopScope;
  creatorId: string;
} {
  return { title: '', body: '', scope: 'GLOBAL', creatorId: '' };
}

export default function AiRules() {
  const confirm = useConfirm();
  const [items, setItems] = useState<AiRuleSuggestion[]>([]);
  const [scopes, setScopes] = useState<Record<string, AiRuleScope>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [creators, setCreators] = useState<Creator[]>([]);
  const [liveRules, setLiveRules] = useState<AiRule[]>([]);
  const [liveSops, setLiveSops] = useState<AiSop[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<AiRuleScope | ''>('');
  const [creatorFilter, setCreatorFilter] = useState('');
  const [editing, setEditing] = useState<RuleEdit | null>(null);
  const [sopModal, setSopModal] = useState<SopEdit | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const [addingSop, setAddingSop] = useState(false);
  const [newRule, setNewRule] = useState(emptyRuleDraft);
  const [newSop, setNewSop] = useState(emptySopDraft);
  const [rawText, setRawText] = useState('');
  const [importCreatorId, setImportCreatorId] = useState('');
  const [documentType, setDocumentType] = useState<'auto' | AiSopDocumentType>(
    'auto'
  );
  const [structuring, setStructuring] = useState(false);
  const [draft, setDraft] = useState<AiSopImportDraft | null>(null);
  const [proposed, setProposed] = useState<AiSopProposedJson>(emptyProposed());
  const [resolutions, setResolutions] = useState<
    Record<string, AiSopOverlapSuggestion>
  >({});
  const [reviewBusy, setReviewBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAiRuleSuggestions('pending');
      setItems(result.suggestions || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadLive = useCallback(async () => {
    setLiveLoading(true);
    try {
      const [rulesResult, sopsResult] = await Promise.all([
        getAiRules({
          scope: scopeFilter || undefined,
          creatorId: creatorFilter || undefined,
        }),
        getAiSops(),
      ]);
      setLiveRules(rulesResult.rules || []);
      setLiveSops(sopsResult.sops || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load live rules');
    } finally {
      setLiveLoading(false);
    }
  }, [scopeFilter, creatorFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadLive();
  }, [loadLive]);

  useEffect(() => {
    void getCreators()
      .then((result) => setCreators(result.creators || []))
      .catch(() => setCreators([]));
  }, []);

  const overlaps = draft?.overlapJson?.overlaps || [];
  const unresolvedConflicts = useMemo(
    () =>
      overlaps.filter((item) => {
        if (item.severity !== 'conflict') return false;
        const suggestion = resolutions[overlapKey(item)] || item.suggestion;
        return suggestion === 'human_decide';
      }),
    [overlaps, resolutions]
  );

  const scopeFor = (item: AiRuleSuggestion): AiRuleScope =>
    scopes[item.id] || item.proposedScope || 'CREATOR';

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
      setItems((current) => current.filter((item) => item.id !== id));
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setBusyId(null);
    }
  };

  function applyDraft(next: AiSopImportDraft) {
    setDraft(next);
    setProposed(next.proposedJson || emptyProposed());
    const initial: Record<string, AiSopOverlapSuggestion> = {};
    for (const item of next.overlapJson?.overlaps || []) {
      initial[overlapKey(item)] = item.suggestion || 'human_decide';
    }
    setResolutions(initial);
  }

  async function handleStructure() {
    if (documentType === 'infosheet' && !importCreatorId) {
      setError('Select a creator for an infosheet import');
      return;
    }
    setStructuring(true);
    setError(null);
    try {
      const result = await importAiSopGuide({
        rawText,
        creatorId: importCreatorId || null,
        documentType,
      });
      applyDraft(result.draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to structure guide');
    } finally {
      setStructuring(false);
    }
  }

  async function handleApproveImport() {
    if (!draft || unresolvedConflicts.length > 0) return;
    setReviewBusy(true);
    setError(null);
    try {
      await approveAiSopImport(draft.id, {
        proposedJson: proposed,
        overlapResolutions: overlaps.map((item) => ({
          existingId: item.existingId,
          newItem: item.newItem,
          suggestion: resolutions[overlapKey(item)] || item.suggestion,
        })),
      });
      setDraft(null);
      setProposed(emptyProposed());
      setResolutions({});
      setRawText('');
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve import');
    } finally {
      setReviewBusy(false);
    }
  }

  async function handleRejectImport() {
    if (!draft) return;
    setReviewBusy(true);
    setError(null);
    try {
      await rejectAiSopImport(draft.id);
      setDraft(null);
      setProposed(emptyProposed());
      setResolutions({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject import');
    } finally {
      setReviewBusy(false);
    }
  }

  function startEdit(rule: AiRule) {
    setEditing({
      id: rule.id,
      text: rule.text,
      scope: rule.scope,
      creatorId: rule.creatorId || '',
      platform: rule.platform || '',
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setBusyId(editing.id);
    setError(null);
    try {
      await patchAiRule(editing.id, {
        text: editing.text,
        scope: editing.scope,
        creatorId: editing.creatorId || null,
        platform: editing.platform || null,
      });
      setEditing(null);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rule');
    } finally {
      setBusyId(null);
    }
  }

  async function removeRule(rule: AiRule) {
    const ok = await confirm({
      title: 'Remove this rule?',
      message: `Deactivate “${rule.text.slice(0, 80)}${rule.text.length > 80 ? '…' : ''}”? It will drop out of generate context.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(rule.id);
    setError(null);
    try {
      await deactivateAiRule(rule.id);
      if (editing?.id === rule.id) setEditing(null);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove rule');
    } finally {
      setBusyId(null);
    }
  }

  async function submitNewRule() {
    setBusyId('new-rule');
    setError(null);
    try {
      await createAiRule({
        text: newRule.text,
        scope: newRule.scope,
        creatorId: newRule.creatorId || null,
        platform: newRule.platform || null,
        platformFanId: newRule.platformFanId || null,
      });
      setNewRule(emptyRuleDraft());
      setAddingRule(false);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add rule');
    } finally {
      setBusyId(null);
    }
  }

  async function submitNewSop() {
    setBusyId('new-sop');
    setError(null);
    try {
      const result = await createAiSop({
        title: newSop.title,
        body: newSop.body,
        scope: newSop.scope,
        creatorId: newSop.creatorId || null,
      });
      setNewSop(emptySopDraft());
      setAddingSop(false);
      await loadLive();
      if (result.sop) openSopModal(result.sop);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add SOP');
    } finally {
      setBusyId(null);
    }
  }

  function openSopModal(sop: AiSop) {
    setSopModal({
      id: sop.id,
      title: sop.title,
      body: sop.body || '',
      scope: sop.scope,
      creatorId: sop.creatorId || '',
    });
  }

  async function saveSop() {
    if (!sopModal) return;
    setBusyId(sopModal.id);
    setError(null);
    try {
      await patchAiSop(sopModal.id, {
        title: sopModal.title,
        body: sopModal.body,
        scope: sopModal.scope,
        creatorId: sopModal.creatorId || null,
      });
      setSopModal(null);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save SOP');
    } finally {
      setBusyId(null);
    }
  }

  async function removeSop(sop: { id: string; title: string }) {
    const ok = await confirm({
      title: 'Remove this SOP?',
      message: `Remove “${sop.title}”? It will drop out of AI context.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(sop.id);
    setError(null);
    try {
      await deactivateAiSop(sop.id);
      if (sopModal?.id === sop.id) setSopModal(null);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove SOP');
    } finally {
      setBusyId(null);
    }
  }

  async function deleteSopPermanently(sop: { id: string; title: string }) {
    const ok = await confirm({
      title: 'Delete this SOP permanently?',
      message: `Delete “${sop.title}” from the database? This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      variant: 'danger',
    });
    if (!ok) return;
    setBusyId(sop.id);
    setError(null);
    try {
      await deleteAiSop(sop.id);
      if (sopModal?.id === sop.id) setSopModal(null);
      await loadLive();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete SOP');
    } finally {
      setBusyId(null);
    }
  }

  const patch = proposed.profilePatch;
  const structureDisabled =
    structuring ||
    !rawText.trim() ||
    (documentType === 'infosheet' && !importCreatorId);

  return (
    <AppLayout title="AI Rules" activePage="aiRules">
      <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4 mb-6">
        <h3 className="text-sm font-medium mb-1">Import SOP / infosheet</h3>
        <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">
          Paste a Notion-style guide or model infosheet. Structure proposes a
          draft and overlap report. Nothing is written until you approve.
        </p>
        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          rows={8}
          placeholder="Paste chatting SOP or creator infosheet (do not paste a Notion URL)"
          className={`${inputClassName} mb-3`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={documentType}
            onChange={(event) =>
              setDocumentType(event.target.value as 'auto' | AiSopDocumentType)
            }
            className={selectClassName}
            aria-label="Document type"
          >
            <option value="auto">Auto</option>
            <option value="sop">SOP (process)</option>
            <option value="infosheet">Infosheet (creator)</option>
          </select>
          <select
            value={importCreatorId}
            onChange={(event) => setImportCreatorId(event.target.value)}
            className={selectClassName}
            aria-label="Import creator"
          >
            <option value="">Global (no creator)</option>
            {creators.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {formatCreatorOption(creator)}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={structureDisabled}
            onClick={() => void handleStructure()}
            className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
          >
            {structuring ? 'Structuring…' : 'Structure'}
          </button>
        </div>

        {draft ? (
          <div className="mt-4 space-y-4">
            <p className="text-xs text-gray-400">
              Draft {draft.id} · {draft.documentType || proposed.documentType} ·{' '}
              {draft.status}. Edit below before approve.
            </p>
            {draft.overlapJson?.error ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Overlap check failed ({draft.overlapJson.error}). Review the
                draft manually; nothing was auto-approved.
              </p>
            ) : null}

            {overlaps.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs uppercase tracking-wide text-gray-400">
                  Overlaps
                </p>
                {overlaps.map((item) => (
                  <div
                    key={overlapKey(item)}
                    className="rounded-lg border border-gray-200 dark:border-white/10 p-3 space-y-1"
                  >
                    <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                      {item.severity}
                    </p>
                    <p className="text-sm">
                      {item.newItem} vs {item.existingItem}
                    </p>
                    <p className="text-xs text-gray-500">{item.summary}</p>
                    <select
                      value={resolutions[overlapKey(item)] || item.suggestion}
                      onChange={(event) =>
                        setResolutions((current) => ({
                          ...current,
                          [overlapKey(item)]: event.target
                            .value as AiSopOverlapSuggestion,
                        }))
                      }
                      className={selectClassName}
                      aria-label="Overlap resolution"
                    >
                      {RESOLUTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value.replace('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {unresolvedConflicts.length > 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    Resolve each conflict before approve.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-3">
              <p className="text-xs uppercase tracking-wide text-gray-400">SOPs</p>
              {proposed.sops.map((sop, index) => (
                <div
                  key={`sop-${index}`}
                  className="rounded-lg border border-gray-200 dark:border-white/10 p-3 space-y-2"
                >
                  <div className="flex flex-wrap gap-2">
                    <input
                      value={sop.title}
                      onChange={(event) =>
                        setProposed((current) => {
                          const sops = current.sops.slice();
                          sops[index] = { ...sops[index], title: event.target.value };
                          return { ...current, sops };
                        })
                      }
                      className={inputClassName}
                      aria-label="SOP title"
                    />
                    <select
                      value={sop.scope}
                      onChange={(event) =>
                        setProposed((current) => {
                          const sops = current.sops.slice();
                          sops[index] = {
                            ...sops[index],
                            scope: event.target.value as AiSopScope,
                          };
                          return { ...current, sops };
                        })
                      }
                      className={selectClassName}
                      aria-label="SOP scope"
                    >
                      {SOP_SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {scope}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="text-xs text-gray-500 hover:text-red-500"
                      onClick={() =>
                        setProposed((current) => ({
                          ...current,
                          sops: current.sops.filter((_, i) => i !== index),
                        }))
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <textarea
                    value={sop.body}
                    onChange={(event) =>
                      setProposed((current) => {
                        const sops = current.sops.slice();
                        sops[index] = { ...sops[index], body: event.target.value };
                        return { ...current, sops };
                      })
                    }
                    rows={5}
                    className={inputClassName}
                    aria-label="SOP body"
                  />
                </div>
              ))}
            </div>

            <div>
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">
                Profile patch
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs text-gray-500">
                  Persona
                  <input
                    value={patch?.persona || ''}
                    onChange={(event) =>
                      setProposed((current) => ({
                        ...current,
                        profilePatch: {
                          ...(current.profilePatch || {}),
                          persona: event.target.value,
                        },
                      }))
                    }
                    className={`${inputClassName} mt-1`}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Tone
                  <input
                    value={patch?.tone || ''}
                    onChange={(event) =>
                      setProposed((current) => ({
                        ...current,
                        profilePatch: {
                          ...(current.profilePatch || {}),
                          tone: event.target.value,
                        },
                      }))
                    }
                    className={`${inputClassName} mt-1`}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Languages
                  <input
                    value={(patch?.languages || []).join(', ')}
                    onChange={(event) =>
                      setProposed((current) => ({
                        ...current,
                        profilePatch: {
                          ...(current.profilePatch || {}),
                          languages: textToClaims(event.target.value),
                        },
                      }))
                    }
                    className={`${inputClassName} mt-1`}
                  />
                </label>
                <label className="text-xs text-gray-500">
                  Sales style
                  <input
                    value={patch?.salesStyle || ''}
                    onChange={(event) =>
                      setProposed((current) => ({
                        ...current,
                        profilePatch: {
                          ...(current.profilePatch || {}),
                          salesStyle: event.target.value,
                        },
                      }))
                    }
                    className={`${inputClassName} mt-1`}
                  />
                </label>
              </div>
              <label className="block text-xs text-gray-500 mt-2">
                Biography
                <textarea
                  value={patch?.biography || ''}
                  onChange={(event) =>
                    setProposed((current) => ({
                      ...current,
                      profilePatch: {
                        ...(current.profilePatch || {}),
                        biography: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  className={`${inputClassName} mt-1`}
                />
              </label>
              <label className="block text-xs text-gray-500 mt-2">
                Instructions
                <textarea
                  value={patch?.instructions || ''}
                  onChange={(event) =>
                    setProposed((current) => ({
                      ...current,
                      profilePatch: {
                        ...(current.profilePatch || {}),
                        instructions: event.target.value,
                      },
                    }))
                  }
                  rows={3}
                  className={`${inputClassName} mt-1`}
                />
              </label>
              <label className="block text-xs text-gray-500 mt-2">
                Preferred terminology (term: replacement)
                <textarea
                  value={terminologyToText(patch?.preferredTerminology)}
                  onChange={(event) =>
                    setProposed((current) => ({
                      ...current,
                      profilePatch: {
                        ...(current.profilePatch || {}),
                        preferredTerminology: textToTerminology(event.target.value),
                      },
                    }))
                  }
                  rows={2}
                  className={`${inputClassName} mt-1`}
                />
              </label>
              <label className="block text-xs text-gray-500 mt-2">
                Prohibited claims (one per line)
                <textarea
                  value={claimsToText(patch?.prohibitedClaims)}
                  onChange={(event) =>
                    setProposed((current) => ({
                      ...current,
                      profilePatch: {
                        ...(current.profilePatch || {}),
                        prohibitedClaims: textToClaims(event.target.value),
                      },
                    }))
                  }
                  rows={2}
                  className={`${inputClassName} mt-1`}
                />
              </label>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase tracking-wide text-gray-400">
                Short rules
              </p>
              {proposed.shortRules.map((rule, index) => (
                <div key={`rule-${index}`} className="flex flex-wrap gap-2">
                  <input
                    value={rule.text}
                    onChange={(event) =>
                      setProposed((current) => {
                        const shortRules = current.shortRules.slice();
                        shortRules[index] = {
                          ...shortRules[index],
                          text: event.target.value,
                        };
                        return { ...current, shortRules };
                      })
                    }
                    className={`${inputClassName} flex-1 min-w-[12rem]`}
                    aria-label="Short rule text"
                  />
                  <select
                    value={rule.scope}
                    onChange={(event) =>
                      setProposed((current) => {
                        const shortRules = current.shortRules.slice();
                        shortRules[index] = {
                          ...shortRules[index],
                          scope: event.target.value as AiSopScope,
                        };
                        return { ...current, shortRules };
                      })
                    }
                    className={selectClassName}
                    aria-label="Short rule scope"
                  >
                    {SOP_SCOPES.map((scope) => (
                      <option key={scope} value={scope}>
                        {scope}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="text-xs text-gray-500 hover:text-red-500"
                    onClick={() =>
                      setProposed((current) => ({
                        ...current,
                        shortRules: current.shortRules.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={reviewBusy || unresolvedConflicts.length > 0}
                onClick={() => void handleApproveImport()}
                className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={reviewBusy}
                onClick={() => void handleRejectImport()}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4 mb-6">
        <h3 className="text-sm font-medium mb-1">Active rules</h3>
        <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">
          Live rules used in generate context. Edit text or scope, or remove to
          deactivate.
        </p>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select
            value={scopeFilter}
            onChange={(event) =>
              setScopeFilter(event.target.value as AiRuleScope | '')
            }
            className={selectClassName}
            aria-label="Filter by scope"
          >
            <option value="">All scopes</option>
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </select>
          <select
            value={creatorFilter}
            onChange={(event) => setCreatorFilter(event.target.value)}
            className={selectClassName}
            aria-label="Filter by creator"
          >
            <option value="">All creators</option>
            {creators.map((creator) => (
              <option key={creator.id} value={creator.id}>
                {formatCreatorOption(creator)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              setAddingRule((open) => !open);
              setNewRule(emptyRuleDraft());
            }}
            className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40"
          >
            {addingRule ? 'Cancel' : 'Add rule'}
          </button>
        </div>
        {addingRule ? (
          <div className="rounded-lg border border-gray-200 dark:border-white/10 p-3 mb-3 space-y-2">
            <textarea
              value={newRule.text}
              onChange={(event) =>
                setNewRule((current) => ({
                  ...current,
                  text: event.target.value.slice(0, MAX_RULE_TEXT),
                }))
              }
              rows={3}
              maxLength={MAX_RULE_TEXT}
              placeholder="Short hard constraint"
              className={inputClassName}
              aria-label="New rule text"
            />
            <p className="text-[11px] text-gray-400">
              {newRule.text.length}/{MAX_RULE_TEXT}
            </p>
            <div className="flex flex-wrap gap-2">
              <select
                value={newRule.scope}
                onChange={(event) =>
                  setNewRule((current) => ({
                    ...current,
                    scope: event.target.value as AiRuleScope,
                  }))
                }
                className={selectClassName}
                aria-label="New rule scope"
              >
                {SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {scope}
                  </option>
                ))}
              </select>
              {newRule.scope === 'CREATOR' || newRule.scope === 'FAN' ? (
                <select
                  value={newRule.creatorId}
                  onChange={(event) => {
                    const nextId = event.target.value;
                    const creator = creators.find((item) => item.id === nextId);
                    setNewRule((current) => ({
                      ...current,
                      creatorId: nextId,
                      platform: creator?.platform || current.platform,
                    }));
                  }}
                  className={selectClassName}
                  aria-label="New rule creator"
                >
                  <option value="">Select creator</option>
                  {creators.map((creator) => (
                    <option key={creator.id} value={creator.id}>
                      {formatCreatorOption(creator)}
                    </option>
                  ))}
                </select>
              ) : null}
              {newRule.scope === 'PLATFORM' ||
              newRule.scope === 'CREATOR' ||
              newRule.scope === 'FAN' ? (
                <select
                  value={newRule.platform}
                  onChange={(event) =>
                    setNewRule((current) => ({
                      ...current,
                      platform: event.target.value,
                    }))
                  }
                  className={selectClassName}
                  aria-label="New rule platform"
                >
                  <option value="">Select platform</option>
                  {PLATFORMS.map((platform) => (
                    <option key={platform} value={platform}>
                      {platform}
                    </option>
                  ))}
                </select>
              ) : null}
              {newRule.scope === 'FAN' ? (
                <input
                  value={newRule.platformFanId}
                  onChange={(event) =>
                    setNewRule((current) => ({
                      ...current,
                      platformFanId: event.target.value,
                    }))
                  }
                  placeholder="Fan id"
                  className={`${inputClassName} max-w-[14rem]`}
                  aria-label="New rule fan id"
                />
              ) : null}
              <button
                type="button"
                disabled={busyId === 'new-rule' || !newRule.text.trim()}
                onClick={() => void submitNewRule()}
                className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        ) : null}
        {liveLoading && liveRules.length === 0 ? (
          <p className="text-sm text-gray-500">Loading rules…</p>
        ) : liveRules.length === 0 ? (
          <p className="text-sm text-gray-500">No active rules.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-3 font-medium">Text</th>
                  <th className="pb-2 pr-3 font-medium">Scope</th>
                  <th className="pb-2 pr-3 font-medium">Creator / platform</th>
                  <th className="pb-2 pr-3 font-medium">Approved</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {liveRules.map((rule) => {
                  const isEditing = editing?.id === rule.id;
                  return (
                    <tr
                      key={rule.id}
                      className="border-t border-gray-100 dark:border-white/5 align-top"
                    >
                      <td className="py-3 pr-3 min-w-[14rem]">
                        {isEditing ? (
                          <textarea
                            value={editing.text}
                            onChange={(event) =>
                              setEditing((current) =>
                                current
                                  ? { ...current, text: event.target.value }
                                  : current
                              )
                            }
                            rows={3}
                            className={inputClassName}
                            aria-label="Rule text"
                          />
                        ) : (
                          <p className="whitespace-pre-wrap">{rule.text}</p>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        {isEditing ? (
                          <select
                            value={editing.scope}
                            onChange={(event) =>
                              setEditing((current) =>
                                current
                                  ? {
                                      ...current,
                                      scope: event.target.value as AiRuleScope,
                                    }
                                  : current
                              )
                            }
                            className={selectClassName}
                            aria-label="Rule scope"
                          >
                            {SCOPES.map((scope) => (
                              <option key={scope} value={scope}>
                                {scope}
                              </option>
                            ))}
                          </select>
                        ) : (
                          rule.scope
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        {isEditing && editing.scope === 'CREATOR' ? (
                          <select
                            value={editing.creatorId}
                            onChange={(event) => {
                              const nextId = event.target.value;
                              const creator = creators.find(
                                (item) => item.id === nextId
                              );
                              setEditing((current) =>
                                current
                                  ? {
                                      ...current,
                                      creatorId: nextId,
                                      platform:
                                        creator?.platform || current.platform,
                                    }
                                  : current
                              );
                            }}
                            className={selectClassName}
                            aria-label="Rule creator"
                          >
                            <option value="">Select creator</option>
                            {creators.map((creator) => (
                              <option key={creator.id} value={creator.id}>
                                {formatCreatorOption(creator)}
                              </option>
                            ))}
                          </select>
                        ) : isEditing && editing.scope === 'PLATFORM' ? (
                          <select
                            value={editing.platform}
                            onChange={(event) =>
                              setEditing((current) =>
                                current
                                  ? { ...current, platform: event.target.value }
                                  : current
                              )
                            }
                            className={selectClassName}
                            aria-label="Rule platform"
                          >
                            <option value="">Select platform</option>
                            {PLATFORMS.map((platform) => (
                              <option key={platform} value={platform}>
                                {platform}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span>
                            {creatorLabel(creators, rule.creatorId)}
                            {rule.platform ? ` · ${rule.platform}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="py-3 pr-3 whitespace-nowrap text-xs text-gray-500">
                        {formatStamp(rule.approvedAt)}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-2 justify-end">
                          {isEditing ? (
                            <>
                              <button
                                type="button"
                                disabled={busyId === rule.id}
                                onClick={() => void saveEdit()}
                                className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                disabled={busyId === rule.id}
                                onClick={() => setEditing(null)}
                                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === rule.id}
                              onClick={() => startEdit(rule)}
                              className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                            >
                              Edit
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyId === rule.id}
                            onClick={() => void removeRule(rule)}
                            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-white/10 p-4 mb-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <h3 className="text-sm font-medium">Active SOPs</h3>
          <button
            type="button"
            onClick={() => {
              setAddingSop((open) => !open);
              setNewSop(emptySopDraft());
            }}
            className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40"
          >
            {addingSop ? 'Cancel' : 'Add SOP'}
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-zinc-400 mb-3">
          View or edit a guide, or remove it from generate context. Import still
          writes new SOPs only after approve.
        </p>
        {addingSop ? (
          <div className="rounded-lg border border-gray-200 dark:border-white/10 p-3 mb-3 space-y-2">
            <input
              value={newSop.title}
              onChange={(event) =>
                setNewSop((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="SOP title"
              className={inputClassName}
              aria-label="New SOP title"
            />
            <div className="flex flex-wrap gap-2">
              <select
                value={newSop.scope}
                onChange={(event) =>
                  setNewSop((current) => ({
                    ...current,
                    scope: event.target.value as AiSopScope,
                  }))
                }
                className={selectClassName}
                aria-label="New SOP scope"
              >
                {SOP_SCOPES.map((scope) => (
                  <option key={scope} value={scope}>
                    {scope}
                  </option>
                ))}
              </select>
              {newSop.scope === 'CREATOR' ? (
                <select
                  value={newSop.creatorId}
                  onChange={(event) =>
                    setNewSop((current) => ({
                      ...current,
                      creatorId: event.target.value,
                    }))
                  }
                  className={selectClassName}
                  aria-label="New SOP creator"
                >
                  <option value="">Select creator</option>
                  {creators.map((creator) => (
                    <option key={creator.id} value={creator.id}>
                      {formatCreatorOption(creator)}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <textarea
              value={newSop.body}
              onChange={(event) =>
                setNewSop((current) => ({
                  ...current,
                  body: event.target.value,
                }))
              }
              rows={10}
              placeholder="Playbook body"
              className={`${inputClassName} font-mono text-xs`}
              aria-label="New SOP body"
            />
            <button
              type="button"
              disabled={
                busyId === 'new-sop' ||
                !newSop.title.trim() ||
                !newSop.body.trim()
              }
              onClick={() => void submitNewSop()}
              className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
            >
              Save
            </button>
          </div>
        ) : null}
        {liveLoading && liveSops.length === 0 ? (
          <p className="text-sm text-gray-500">Loading SOPs…</p>
        ) : liveSops.length === 0 ? (
          <p className="text-sm text-gray-500">No active SOPs.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-400">
                  <th className="pb-2 pr-3 font-medium">Title</th>
                  <th className="pb-2 pr-3 font-medium">Scope</th>
                  <th className="pb-2 pr-3 font-medium">Creator</th>
                  <th className="pb-2 pr-3 font-medium">Updated</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {liveSops.map((sop) => (
                  <tr
                    key={sop.id}
                    className="border-t border-gray-100 dark:border-white/5 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5"
                    onClick={() => openSopModal(sop)}
                  >
                    <td className="py-3 pr-3">{sop.title}</td>
                    <td className="py-3 pr-3">{sop.scope}</td>
                    <td className="py-3 pr-3">
                      {creatorLabel(creators, sop.creatorId)}
                    </td>
                    <td className="py-3 pr-3 whitespace-nowrap text-xs text-gray-500">
                      {formatStamp(sop.updatedAt)}
                    </td>
                    <td
                      className="py-3 text-right"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="flex flex-wrap gap-2 justify-end">
                        <button
                          type="button"
                          disabled={busyId === sop.id}
                          onClick={() => openSopModal(sop)}
                          className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                        >
                          View
                        </button>
                        <button
                          type="button"
                          disabled={busyId === sop.id}
                          onClick={() => void removeSop(sop)}
                          className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-sm text-gray-500 dark:text-zinc-400 mb-4">
        Edit-send diffs wait here. Approving writes a scoped rule. Nothing is
        auto-promoted.
      </p>

      {error ? <p className="text-sm text-red-500 mb-4">{error}</p> : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-gray-500">Loading suggestions…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-gray-500">No pending rule suggestions.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-gray-200 dark:border-white/10 p-4"
            >
              <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">
                {item.platform || '—'} · {item.creatorId || 'creator'}
              </p>
              <p className="text-[11px] text-gray-500 mb-1">Before</p>
              <p className="text-sm text-gray-600 dark:text-zinc-400 mb-2 whitespace-pre-wrap">
                {item.beforeText || '—'}
              </p>
              <p className="text-[11px] text-gray-500 mb-1">After</p>
              <p className="text-sm text-gray-900 dark:text-zinc-100 mb-3 whitespace-pre-wrap">
                {item.afterText || '—'}
              </p>
              <p className="text-xs text-gray-500 mb-3">{item.proposedRule}</p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={scopeFor(item)}
                  onChange={(event) =>
                    setScopes((current) => ({
                      ...current,
                      [item.id]: event.target.value as AiRuleScope,
                    }))
                  }
                  disabled={busyId === item.id}
                  className={selectClassName}
                >
                  {SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() =>
                    run(item.id, async () => {
                      await approveAiRuleSuggestion(item.id, {
                        scope: scopeFor(item),
                      });
                    })
                  }
                  className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busyId === item.id}
                  onClick={() =>
                    run(item.id, async () => {
                      await rejectAiRuleSuggestion(item.id);
                    })
                  }
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {sopModal ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 text-gray-900 dark:text-gray-100">
          <button
            type="button"
            aria-label="Close SOP modal"
            className="absolute inset-0 bg-black/40 dark:bg-black/70"
            onClick={() => setSopModal(null)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="sop-modal-title"
            className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col border border-gray-200 dark:border-white/10 p-6"
          >
            <h3 id="sop-modal-title" className="text-lg font-semibold mb-4">
              SOP
            </h3>
            <div className="space-y-3 overflow-y-auto min-h-0 flex-1 pr-1">
              <label className="block text-xs text-gray-500">
                Title
                <input
                  value={sopModal.title}
                  onChange={(event) =>
                    setSopModal((current) =>
                      current
                        ? { ...current, title: event.target.value }
                        : current
                    )
                  }
                  className={`${inputClassName} mt-1`}
                  aria-label="SOP title"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <select
                  value={sopModal.scope}
                  onChange={(event) =>
                    setSopModal((current) =>
                      current
                        ? {
                            ...current,
                            scope: event.target.value as AiSopScope,
                          }
                        : current
                    )
                  }
                  className={selectClassName}
                  aria-label="SOP scope"
                >
                  {SOP_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {scope}
                    </option>
                  ))}
                </select>
                {sopModal.scope === 'CREATOR' ? (
                  <select
                    value={sopModal.creatorId}
                    onChange={(event) =>
                      setSopModal((current) =>
                        current
                          ? { ...current, creatorId: event.target.value }
                          : current
                      )
                    }
                    className={selectClassName}
                    aria-label="SOP creator"
                  >
                    <option value="">Select creator</option>
                    {creators.map((creator) => (
                      <option key={creator.id} value={creator.id}>
                        {formatCreatorOption(creator)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="self-center text-xs text-gray-500">
                    Global
                  </span>
                )}
              </div>
              <label className="block text-xs text-gray-500">
                Body
                <textarea
                  value={sopModal.body}
                  onChange={(event) =>
                    setSopModal((current) =>
                      current
                        ? { ...current, body: event.target.value }
                        : current
                    )
                  }
                  rows={14}
                  className={`${inputClassName} mt-1 min-h-[16rem] font-mono text-xs`}
                  aria-label="SOP body"
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 mt-4 pt-3 border-t border-gray-100 dark:border-white/10">
              <button
                type="button"
                disabled={busyId === sopModal.id}
                onClick={() => void deleteSopPermanently(sopModal)}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
              >
                Delete permanently
              </button>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busyId === sopModal.id}
                  onClick={() => void removeSop(sopModal)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                >
                  Remove
                </button>
                <button
                  type="button"
                  disabled={busyId === sopModal.id}
                  onClick={() => setSopModal(null)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-white/10 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busyId === sopModal.id}
                  onClick={() => void saveSop()}
                  className="px-3 py-1.5 text-sm rounded-lg border border-domx-600/40 text-domx-700 dark:text-domx-300 hover:bg-domx-50 dark:hover:bg-domx-950/40 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </AppLayout>
  );
}
