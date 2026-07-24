import { useCallback, useEffect, useState } from 'react';
import {
  Plus,
  ImageIcon,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import AddCreatorModal from '@/components/AddCreatorModal';
import AssignCreatorStaffModal from '@/components/AssignCreatorStaffModal';
import CreatorAvatar from '@/components/CreatorAvatar';
import RemoveCreatorModal from '@/components/RemoveCreatorModal';
import RenameCreatorModal from '@/components/RenameCreatorModal';
import VerifySessionModal from '@/components/VerifySessionModal';
import { useAuth } from '@/context/AuthContext';
import { deleteCreator, getCreatorSession, getCreators, saveCreatorAvatarFromMaloum, type Creator } from '@/lib/api';
import type { PlaywrightCookie } from '@/types/electron';
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

function getCurrentDomXTheme(): 'dark' | 'light' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
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
  const [verifyTarget, setVerifyTarget] = useState<Creator | null>(null);
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
    if (!window.electronAPI?.isElectron) {
      setError('Refresh Icon from Maloum requires the DomX desktop app.');
      return;
    }

    if (!creator.accountId) {
      setError('No saved session for this creator.');
      return;
    }

    setRefreshingIconId(creator.id);
    setError(null);

    try {
      const session = await getCreatorSession(creator.id);

      await window.electronAPI.loadCreatorSession({
        accountId: session.accountId,
        cookies: session.cookies as PlaywrightCookie[],
        origins: session.origins,
      });

      const verification = await window.electronAPI.verifyMaloumSession({
        accountId: session.accountId,
        theme: getCurrentDomXTheme(),
        reuseVisibleView: false,
      });

      if (!verification.verified) {
        throw new Error(
          verification.reason || 'Could not verify Maloum session for icon refresh.'
        );
      }

      if (!verification.profileImageUrl) {
        throw new Error('No profile image found on Maloum.');
      }

      await saveCreatorAvatarFromMaloum(
        creator.id,
        verification.profileImageUrl,
        { overwrite: true, accountId: session.accountId }
      );

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
      const result = await deleteCreator(removeTarget.id);

      if (window.electronAPI?.isElectron && result.accountId) {
        await window.electronAPI.clearSession(result.accountId);
      }

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

        <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-white/5 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Creator</th>
                <th className="px-4 py-3 font-medium">Account Info</th>
                <th className="px-4 py-3 font-medium">Connection Status</th>
                <th className="px-4 py-3 font-medium">Staff</th>
                {canManage && <th className="px-4 py-3 font-medium w-20" />}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={canManage ? 5 : 4}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    Loading creators...
                  </td>
                </tr>
              ) : creators.length === 0 ? (
                <tr>
                  <td
                    colSpan={canManage ? 5 : 4}
                    className="px-4 py-8 text-center text-gray-400"
                  >
                    No creators yet.
                    {canManage && ' Click Add Creator to connect one.'}
                  </td>
                </tr>
              ) : (
                creators.map((creator) => (
                  <tr
                    key={creator.id}
                    className="border-t border-gray-100 dark:border-white/5 hover:bg-gray-50/50 dark:hover:bg-white/[0.02]"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <CreatorAvatar
                          avatarUrl={creator.avatarUrl}
                          displayName={creator.displayName}
                          className="w-8 h-8 rounded-full object-cover shrink-0"
                          initialsClassName="w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 text-xs font-bold shrink-0"
                        />
                        <div>
                          <p className="font-medium">{creator.displayName}</p>
                          <p className="text-xs text-gray-400 inline-flex items-center gap-1.5">
                            {creator.platform === '4based' && (
                              <img
                                src={fourBasedIcon}
                                alt=""
                                className="w-3.5 h-3.5 rounded"
                              />
                            )}
                            {platformLabel(creator.platform)}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {creator.username || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={`inline-flex w-fit px-2 py-0.5 text-xs font-medium rounded-full ${connectionBadgeClass(creator.connectionStatus)}`}
                        >
                          {connectionLabel(creator.connectionStatus)}
                        </span>
                        {formatValidatedAt(creator.lastValidatedAt) && (
                          <span className="text-xs text-gray-400">
                            Verified {formatValidatedAt(creator.lastValidatedAt)}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {canManage ? (
                        <button
                          type="button"
                          onClick={() => setStaffTarget(creator)}
                          className="inline-flex items-center gap-1 px-2 py-0.5 -mx-2 rounded-md hover:bg-gray-100 dark:hover:bg-white/5 hover:text-brand-600 dark:hover:text-brand-400 transition-colors"
                          title="Manage assigned staff"
                        >
                          {creator.staffCount}
                        </button>
                      ) : (
                        creator.staffCount
                      )}
                    </td>
                    {canManage && (
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          {(creator.connectionStatus === 'error' ||
                            creator.platform === '4based') && (
                            <button
                              type="button"
                              className="p-1.5 text-gray-400 hover:text-brand-600 dark:hover:text-brand-400 rounded-md hover:bg-brand-50 dark:hover:bg-brand-900/20 transition-colors"
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
                              !creator.accountId ||
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
                            className="p-1.5 text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 rounded-md hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Verify session"
                            disabled={!creator.accountId || creator.platform !== 'maloum'}
                            onClick={() => setVerifyTarget(creator)}
                          >
                            <ShieldCheck className="w-4 h-4" />
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

      {verifyTarget && (
        <VerifySessionModal
          creator={verifyTarget}
          onClose={() => setVerifyTarget(null)}
          onValidated={loadCreators}
          onReconnect={() => {
            setReconnectCreator(verifyTarget);
            setVerifyTarget(null);
            setShowAddModal(true);
          }}
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
