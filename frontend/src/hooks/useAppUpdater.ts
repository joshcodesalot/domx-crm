import { useCallback, useEffect, useState } from 'react';
import type { UpdaterState } from '@/types/electron';

const INITIAL_STATE: UpdaterState = {
  status: 'idle',
  currentVersion: '0.0.0',
  availableVersion: null,
  progress: 0,
  error: null,
  macDownloadUrl: null,
  blocked: false,
  platform: 'unknown',
  updaterEnabled: false,
};

export function useAppUpdater() {
  const [state, setState] = useState<UpdaterState>(INITIAL_STATE);
  const [isCheckingOnStartup, setIsCheckingOnStartup] = useState(false);

  const refreshState = useCallback(async () => {
    if (!window.electronAPI?.getUpdaterState) {
      setIsCheckingOnStartup(false);
      return;
    }

    const nextState = await window.electronAPI.getUpdaterState();
    setState(nextState);
    setIsCheckingOnStartup(
      nextState.updaterEnabled && nextState.status === 'checking'
    );
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.isElectron) {
      return undefined;
    }

    void refreshState();

    const unsubscribers = [
      window.electronAPI.onUpdaterChecking?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(true);
      }),
      window.electronAPI.onUpdaterBlocked?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
      window.electronAPI.onUpdaterAvailable?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
      window.electronAPI.onUpdaterDownloadProgress?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
      window.electronAPI.onUpdaterReady?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
      window.electronAPI.onUpdaterError?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
      window.electronAPI.onUpdaterNotAvailable?.((nextState) => {
        setState(nextState);
        setIsCheckingOnStartup(false);
      }),
    ].filter(Boolean) as Array<() => void>;

    return () => {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
    };
  }, [refreshState]);

  const installUpdate = useCallback(async () => {
    if (!window.electronAPI?.installUpdateNow) {
      return;
    }

    await window.electronAPI.installUpdateNow();
  }, []);

  const openMacDownload = useCallback(async () => {
    if (!window.electronAPI?.openMacDownload) {
      return;
    }

    await window.electronAPI.openMacDownload();
  }, []);

  const showOverlay =
    state.updaterEnabled && (isCheckingOnStartup || state.blocked);

  return {
    state,
    showOverlay,
    installUpdate,
    openMacDownload,
  };
}
