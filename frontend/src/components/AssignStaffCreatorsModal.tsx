import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Users, X } from 'lucide-react';
import {
  getCreators,
  getStaffCreators,
  resolveCreatorAvatarUrl,
  setStaffCreators,
  type Creator,
  type User,
} from '@/lib/api';

interface AssignStaffCreatorsModalProps {
  staffMember: User;
  onClose: () => void;
  onSaved: () => void;
}

export default function AssignStaffCreatorsModal({
  staffMember,
  onClose,
  onSaved,
}: AssignStaffCreatorsModalProps) {
  const [allCreators, setAllCreators] = useState<Creator[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [initialIds, setInitialIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [creatorsResult, assignedResult] = await Promise.all([
        getCreators(),
        getStaffCreators(staffMember.id),
      ]);
      setAllCreators(creatorsResult.creators);
      const assigned = new Set(assignedResult.creators.map((creator) => creator.id));
      setSelectedIds(assigned);
      setInitialIds(assigned);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load creator assignments');
    } finally {
      setLoading(false);
    }
  }, [staffMember.id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const filteredCreators = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allCreators;
    return allCreators.filter((creator) => {
      const haystack = `${creator.displayName} ${creator.username || ''} ${creator.platform}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [allCreators, search]);

  const dirty = useMemo(() => {
    if (selectedIds.size !== initialIds.size) return true;
    for (const id of selectedIds) {
      if (!initialIds.has(id)) return true;
    }
    return false;
  }, [selectedIds, initialIds]);

  function toggleCreator(creatorId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(creatorId)) {
        next.delete(creatorId);
      } else {
        next.add(creatorId);
      }
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await setStaffCreators(staffMember.id, [...selectedIds]);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save creator assignments');
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

      <div className="relative bg-white dark:bg-[#111] rounded-xl shadow-xl w-full max-w-lg border border-gray-200 dark:border-white/10 p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-brand-100 dark:bg-brand-900/30 flex items-center justify-center shrink-0">
              <Users className="w-5 h-5 text-brand-600 dark:text-brand-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">Assign Creators</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Choose creators for{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {staffMember.name}
                </span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="p-1.5 text-gray-400 hover:text-gray-900 dark:hover:text-white rounded-md hover:bg-gray-100 dark:hover:bg-white/5 disabled:opacity-50"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg">
            {error}
          </div>
        )}

        <div className="relative mb-3">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search creators..."
            disabled={loading || saving}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 disabled:opacity-50"
          />
        </div>

        <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">
          Creators ({selectedIds.size} selected)
        </p>

        {loading ? (
          <p className="text-sm text-gray-400 py-8 text-center">Loading...</p>
        ) : filteredCreators.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-8 text-center border border-dashed border-gray-200 dark:border-white/10 rounded-lg">
            {allCreators.length === 0 ? 'No creators available.' : 'No creators match your search.'}
          </p>
        ) : (
          <ul className="border border-gray-200 dark:border-white/10 rounded-lg divide-y divide-gray-100 dark:divide-white/5 max-h-72 overflow-y-auto">
            {filteredCreators.map((creator) => {
              const checked = selectedIds.has(creator.id);
              const avatarUrl = resolveCreatorAvatarUrl(creator.avatarUrl);

              return (
                <li key={creator.id}>
                  <label className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={() => toggleCreator(creator.id)}
                      className="w-4 h-4 rounded border-gray-300 dark:border-white/20"
                    />
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="w-8 h-8 rounded-full object-cover shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-white/10 flex items-center justify-center text-xs font-medium text-gray-500 shrink-0">
                        {creator.displayName.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{creator.displayName}</p>
                      <p className="text-xs text-gray-400 truncate">
                        {creator.platform}
                        {creator.username ? ` · @${creator.username}` : ''}
                      </p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex items-center justify-end gap-2 mt-6">
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
            disabled={saving || loading || !dirty}
            className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
