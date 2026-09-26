import { useCallback, useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import EditBrowserProxyModal from '@/components/EditBrowserProxyModal';
import { useAuth } from '@/context/AuthContext';
import {
  getToken,
  listBrowserProfiles,
  openBrowserProfile,
  type BrowserProfileLock,
} from '@/lib/api';
import fourBasedIcon from '@/assets/4based_icon.ico';
import maloumIcon from '@/assets/maloum_icon.png';
import telegramIcon from '@/assets/telegram_icon.svg';

function platformLabel(platform: string): string {
  if (platform === 'maloum') return 'Maloum';
  if (platform === 'telegram') return 'Telegram';
  return '4based';
}

export default function Marketing() {
  const { hasPermission } = useAuth();
  const [profiles, setProfiles] = useState<BrowserProfileLock[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [browserProxyTarget, setBrowserProxyTarget] = useState<BrowserProfileLock | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [downloadingBrowser, setDownloadingBrowser] = useState(false);

  const canManage = hasPermission('creators.manage');
  const columnCount = 3;

  const loadProfiles = useCallback(async () => {
    const { profiles: list } = await listBrowserProfiles();
    setProfiles(list);
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await loadProfiles();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load creators');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [loadProfiles]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadProfiles().catch(() => {});
    }, 15000);
    return () => window.clearInterval(timer);
  }, [loadProfiles]);

  useEffect(() => {
    return window.electronAPI?.onClearcoteInstallProgress?.(() => {
      setDownloadingBrowser(true);
    });
  }, []);

  async function handleOpenBrowser(profile: BrowserProfileLock) {
    const desktop = window.electronAPI;
    if (!desktop?.isElectron || !desktop.launchClearcote || !desktop.openClearcoteView) {
      setError('Open the browser from the DomX desktop app.');
      return;
    }
    if (desktop.platform !== 'win32' && desktop.platform !== 'darwin' && desktop.platform !== 'linux') {
      setError('Open the browser from the DomX app on Windows or Mac.');
      return;
    }
    const token = getToken();
    if (!token) {
      setError('Sign in again to open the browser.');
      return;
    }

    setOpeningId(profile.creatorId);
    setDownloadingBrowser(false);
    setError(null);
    try {
      const opened = await openBrowserProfile(profile.creatorId, desktop.platform);
      const launch =
        desktop.platform === 'darwin'
          ? await desktop.openClearcoteView({ token, profile: opened })
          : await desktop.launchClearcote({ token, profile: opened });
      if (!launch?.ok) {
        setError(launch?.error || 'Could not open the browser.');
      }
      await loadProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the browser.');
      await loadProfiles().catch(() => {});
    } finally {
      setOpeningId(null);
      setDownloadingBrowser(false);
    }
  }

  return (
    <AppLayout title="Marketing" activePage="marketing">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-2xl font-semibold mb-6">Marketing</h2>
        {error && (
          <div className="mb-4 p-3 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 rounded-lg">
            {error}
          </div>
        )}

        <div className="border border-gray-200 dark:border-white/10 rounded-xl overflow-x-auto">
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
                  Browser
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-8 text-center text-gray-400">
                    Loading creators…
                  </td>
                </tr>
              ) : profiles.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} className="px-4 py-8 text-center text-gray-400">
                    No creators yet.
                  </td>
                </tr>
              ) : (
                profiles.map((profile) => {
                  const heldByOther = Boolean(profile.locked && !profile.lockedBySelf);
                  return (
                    <tr
                      key={profile.creatorId}
                      className="border-b border-gray-100 dark:border-white/5 last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <CreatorAvatar
                            avatarUrl={profile.avatarUrl}
                            displayName={profile.displayName}
                          />
                          <span className="font-medium">{profile.displayName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 text-gray-600 dark:text-gray-300">
                          {profile.platform === '4based' ? (
                            <img src={fourBasedIcon} alt="" className="w-3.5 h-3.5" />
                          ) : profile.platform === 'telegram' ? (
                            <img src={telegramIcon} alt="" className="w-3.5 h-3.5 rounded-full" />
                          ) : (
                            <img
                              src={maloumIcon}
                              alt=""
                              className="w-3.5 h-3.5 rounded-sm object-cover"
                            />
                          )}
                          {platformLabel(profile.platform)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-gray-200 dark:border-white/10 hover:bg-gray-50 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
                            disabled={openingId === profile.creatorId || heldByOther}
                            title={
                              heldByOther
                                ? `In use by ${profile.lockedByName || 'another chatter'}`
                                : 'Open browser'
                            }
                            onClick={() => void handleOpenBrowser(profile)}
                          >
                            <Monitor className="w-3.5 h-3.5" />
                            {openingId === profile.creatorId
                              ? downloadingBrowser
                                ? 'Downloading browser…'
                                : 'Opening…'
                              : 'Open browser'}
                          </button>
                          {profile.locked && (
                            <p className="text-xs text-gray-400">
                              {profile.lockedBySelf
                                ? 'Open on this account'
                                : `In use by ${profile.lockedByName || 'another chatter'}`}
                            </p>
                          )}
                          {canManage && (
                            <button
                              type="button"
                              className="text-xs text-gray-400 hover:text-sky-600 dark:hover:text-sky-400"
                              onClick={() => setBrowserProxyTarget(profile)}
                            >
                              Browser proxy
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {browserProxyTarget && (
        <EditBrowserProxyModal
          creator={{
            id: browserProxyTarget.creatorId,
            displayName: browserProxyTarget.displayName,
          }}
          onClose={() => setBrowserProxyTarget(null)}
          onSaved={() => {
            void loadProfiles();
          }}
        />
      )}
    </AppLayout>
  );
}
