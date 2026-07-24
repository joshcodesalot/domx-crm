import { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  ImageIcon,
  Pencil,
  RefreshCw,
  Trash2,
  Users,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import AddCreatorModal from '@/components/AddCreatorModal';
import AssignCreatorStaffModal from '@/components/AssignCreatorStaffModal';
import CreatorAvatar from '@/components/CreatorAvatar';
import RemoveCreatorModal from '@/components/RemoveCreatorModal';
import RenameCreatorModal from '@/components/RenameCreatorModal';
import { useAuth } from '@/context/AuthContext';
import { deleteCreator, getCreators, refreshMaloumAvatar, type Creator } from '@/lib/api';
import fourBasedIcon from '@/assets/4based_icon.ico';

function platformLabel(platform: Creator['platform']): string {
  return platform === 'maloum' ? 'Maloum' : '4based';
}

function connectionBadgeClass(status: Creator['connectionStatus']): string {
  if (status === 'connected') {
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  }
  if (status === 'error') {
    return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  }
  return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
}

function connectionLabel(status: Creator['connectionStatus']): string {
  if (status === 'connected') return 'Connected';
  if (status === 'error') return 'Error';
  return 'Pending';
}

function formatValidatedAt(value: string | null): string | null {
  if (!value) return null;
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return null;
  }
}

export default function ManageCreators() {
  const { hasPermission } = useAuth();
  const [creators, setCreators] = useState<Creator[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [reconnectCreator, setReconnectCreator] = useState<Creator | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Creator | null>(null);
  const [staffTarget, setStaffTarget] = useState<Creator | null>(null);
  const [renameTarget, setRenameTarget] = useState<Creator | null>(null);
  const [refreshingIconId, setRefreshingIconId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const canManage = hasPermission('creators.manage');

  const loadCreators = useCallback(async () => {
    const { creators: list } = await getCreators();
    setCreators(list);
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await loadCreators();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load creators');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [loadCreators]);

  async function handleRefresh() {
    setRefreshing(true);
    setError(null);
    try {
      await loadCreators();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh creators');
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRefreshIconFromMaloum(creator: Creator) {
    setRefreshingIconId(creator.id);
    setError(null);

    try {
      await refreshMaloumAvatar(creator.id);
      await loadCreators();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to refresh icon from Maloum'
      );
    } finally {
      setRefreshingIconId(null);
    }
  }

  async function handleRemoveConfirm() {
    if (!removeTarget) return;

    setRemoving(true);
    setError(null);
    try {
      await deleteCreator(removeTarget.id);
      setRemoveTarget(null);
      await loadCreators();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove creator');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <AppLayout title="Creators" activePage="creators">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Manage Creators</h2>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing || loading}
              className="p-2 border border-gray-200 dark:border-white/10 rounded-lg text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-50 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw
                className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
              />
            </button>
            {canManage && (
              <button
                type="button"
                onClick={() => {
                  setReconnectCreator(null);
                  setShowAddModal(true);
                }}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition-colors"
              >
                <Plus className="w-4 h-4" />
                Add Creator
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg">
            {error}
          </div>
        )}

        <div className="border border-gray-200 dark:border-white/10 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02]">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Creator
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Platform
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Status
                </th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                  Validated
                </th>
                {canManage && (
                  <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={canManage ? 5 : 4}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    Loading…
                  </td>
                </tr>
              ) : creators.length === 0 ? (
                <tr>
                  <td
                    colSpan={canManage ? 5 : 4}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    No creators yet.
                  </td>
                </tr>
              ) : (
                creators.map((creator) => (
                  <tr
                    key={creator.id}
                    className="border-b border-gray-100 dark:border-white/5 last:border-0"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <CreatorAvatar
                          displayName={creator.displayName}
                          avatarUrl={creator.avatarUrl}
                          className="w-9 h-9 rounded-full object-cover shrink-0"
                          initialsClassName="w-9 h-9 rounded-full bg-orange-100 flex items-center justify-center shrink-0 text-orange-600 font-bold text-sm"
                        />
                        <div className="min-w-0">
                          <p className="font-medium truncate">{creator.displayName}</p>
                          {creator.username && (
                            <p className="text-xs text-gray-400 truncate">
                              @{creator.username}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        {creator.platform === '4based' && (
                          <img src={fourBasedIcon} alt="" className="w-3.5 h-3.5" />
                        )}
                        {platformLabel(creator.platform)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex px-2 py-0.5 text-xs font-medium rounded-full ${connectionBadgeClass(
                          creator.connectionStatus
                        )}`}
                      >
                        {connectionLabel(creator.connectionStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                      {formatValidatedAt(creator.lastValidatedAt) || '—'}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-0.5">
                          {creator.accountId && (
                            <button
                              type="button"
                              className="p-1.5 text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors"
                              title={
                                creator.platform === '4based'
                                  ? 'Reconnect 4based account'
                                  : 'Reconnect Maloum account'
                              }
                              onClick={() => {
                                setReconnectCreator(creator);
                                setShowAddModal(true);
                              }}
                            >
                              <RefreshCw className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            className="p-1.5 text-gray-400 hover:text-purple-500 dark:hover:text-purple-400 rounded-md hover:bg-purple-50 dark:hover:bg-purple-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Refresh Icon from Maloum"
                            disabled={
                              creator.platform !== 'maloum' ||
                              refreshingIconId === creator.id
                            }
                            onClick={() => void handleRefreshIconFromMaloum(creator)}
                          >
                            <ImageIcon
                              className={`w-4 h-4 ${refreshingIconId === creator.id ? 'animate-pulse' : ''}`}
                            />
                          </button>
                          <button
                            type="button"
                            className="p-1.5 text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 rounded-md hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
                            title="Rename creator"
                            onClick={() => setRenameTarget(creator)}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            className="p-1.5 text-gray-400 hover:text-emerald-500 dark:hover:text-emerald-400 rounded-md hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors"
                            title="Manage staff"
                            onClick={() => setStaffTarget(creator)}
                          >
                            <Users className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            className="p-1.5 text-gray-400 hover:text-red-500 dark:hover:text-red-400 rounded-md hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                            title="Remove creator"
                            onClick={() => setRemoveTarget(creator)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showAddModal && (
        <AddCreatorModal
          reconnectCreator={reconnectCreator}
          onClose={() => {
            setShowAddModal(false);
            setReconnectCreator(null);
          }}
          onSaved={loadCreators}
        />
      )}

      {staffTarget && (
        <AssignCreatorStaffModal
          creator={staffTarget}
          onClose={() => setStaffTarget(null)}
          onSaved={loadCreators}
        />
      )}

      {renameTarget && (
        <RenameCreatorModal
          creatorId={renameTarget.id}
          currentDisplayName={renameTarget.displayName}
          onClose={() => setRenameTarget(null)}
          onSaved={loadCreators}
        />
      )}

      {removeTarget && (
        <RemoveCreatorModal
          creatorName={removeTarget.displayName}
          removing={removing}
          onClose={() => !removing && setRemoveTarget(null)}
          onConfirm={handleRemoveConfirm}
        />
      )}
    </AppLayout>
  );
}
