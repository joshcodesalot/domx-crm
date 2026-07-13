import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserPlus, Users, X } from 'lucide-react';
import {
  assignCreatorStaff,
  getCreatorStaff,
  getStaff,
  unassignCreatorStaff,
  type Creator,
  type CreatorStaffMember,
  type User,
} from '@/lib/api';

interface AssignCreatorStaffModalProps {
  creator: Creator;
  onClose: () => void;
  onSaved: () => void;
}

export default function AssignCreatorStaffModal({
  creator,
  onClose,
  onSaved,
}: AssignCreatorStaffModalProps) {
  const [assigned, setAssigned] = useState<CreatorStaffMember[]>([]);
  const [allStaff, setAllStaff] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [staffResult, assignedResult] = await Promise.all([
        getStaff(),
        getCreatorStaff(creator.id),
      ]);
      setAllStaff(staffResult.staff.filter((member) => member.status === 'active'));
      setAssigned(assignedResult.staff);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load staff assignments');
    } finally {
      setLoading(false);
    }
  }, [creator.id]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const availableStaff = useMemo(() => {
    const assignedIds = new Set(assigned.map((member) => member.id));
    return allStaff.filter((member) => !assignedIds.has(member.id));
  }, [allStaff, assigned]);

  async function handleAssign() {
    if (!selectedUserId) return;

    setSaving(true);
    setError(null);
    try {
      await assignCreatorStaff(creator.id, selectedUserId);
      setSelectedUserId('');
      await loadData();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign staff');
    } finally {
      setSaving(false);
    }
  }

  async function handleUnassign(userId: string) {
    setSaving(true);
    setError(null);
    try {
      await unassignCreatorStaff(creator.id, userId);
      await loadData();
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unassign staff');
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
              <h3 className="text-lg font-semibold">Manage Staff</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Assign staff to{' '}
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {creator.displayName}
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

        <div className="mb-4">
          <label
            htmlFor="assign-staff-select"
            className="block text-xs font-medium uppercase tracking-wide text-gray-500 mb-2"
          >
            Add staff member
          </label>
          <div className="flex items-center gap-2">
            <select
              id="assign-staff-select"
              value={selectedUserId}
              onChange={(event) => setSelectedUserId(event.target.value)}
              disabled={loading || saving || availableStaff.length === 0}
              className="flex-1 px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100 dark:[color-scheme:dark] disabled:opacity-50"
            >
              <option
                value=""
                className="bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100"
              >
                {availableStaff.length === 0
                  ? 'No available staff to assign'
                  : 'Select staff member...'}
              </option>
              {availableStaff.map((member) => (
                <option
                  key={member.id}
                  value={member.id}
                  className="bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100"
                >
                  {member.name} ({member.roleName || member.role})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void handleAssign()}
              disabled={!selectedUserId || saving || loading}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors disabled:opacity-50"
            >
              <UserPlus className="w-4 h-4" />
              Add
            </button>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500 mb-2">
            Assigned staff ({assigned.length})
          </p>
          {loading ? (
            <p className="text-sm text-gray-400 py-4 text-center">Loading...</p>
          ) : assigned.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center border border-dashed border-gray-200 dark:border-white/10 rounded-lg">
              No staff assigned yet.
            </p>
          ) : (
            <ul className="border border-gray-200 dark:border-white/10 rounded-lg divide-y divide-gray-100 dark:divide-white/5 max-h-60 overflow-y-auto">
              {assigned.map((member) => (
                <li
                  key={member.id}
                  className="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{member.name}</p>
                    <p className="text-xs text-gray-400 truncate">
                      {member.roleName || member.role} · {member.email}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleUnassign(member.id)}
                    disabled={saving}
                    className="shrink-0 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-md transition-colors disabled:opacity-50"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
