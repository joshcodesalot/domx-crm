import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useAppUpdater } from '@/hooks/useAppUpdater';

export default function ForcedUpdateOverlay() {
  const { state, showOverlay, installUpdate, openMacDownload } = useAppUpdater();

  if (!showOverlay) {
    return null;
  }

  const isMac = state.platform === 'darwin';
  const isWindows = state.platform === 'win32';
  const isChecking = state.status === 'checking';
  const isDownloading = state.status === 'downloading';
  const isReady = state.status === 'ready';
  const title = isChecking
    ? 'Checking for updates'
    : isReady
      ? 'Update ready'
      : 'Update required';

  const description = (() => {
    if (isChecking) {
      return 'Please wait while DomX CRM checks for the latest version.';
    }

    if (isMac) {
      return 'A newer version is required. Download the update, install it, then relaunch DomX CRM.';
    }

    if (isDownloading) {
      return `Downloading version ${state.availableVersion || ''}`.trim();
    }

    if (isReady) {
      return 'The update has been downloaded. Install now to continue using DomX CRM.';
    }

    return 'A newer version is required before you can continue.';
  })();

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-white/10 bg-[#111111] p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-white/5">
          {isChecking || isDownloading ? (
            <Loader2 className="h-7 w-7 animate-spin text-white" />
          ) : (
            <RefreshCw className="h-7 w-7 text-white" />
          )}
        </div>

        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <p className="mt-3 text-sm leading-6 text-gray-300">{description}</p>

        {state.availableVersion ? (
          <p className="mt-4 text-xs text-gray-400">
            Current: v{state.currentVersion} · Required: v{state.availableVersion}
          </p>
        ) : null}

        {isDownloading ? (
          <div className="mt-6">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-white transition-all duration-300"
                style={{ width: `${Math.max(state.progress, 4)}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-gray-400">{state.progress}% downloaded</p>
          </div>
        ) : null}

        {state.error ? (
          <p className="mt-4 text-xs text-red-300">{state.error}</p>
        ) : null}

        <div className="mt-6">
          {isMac && state.blocked ? (
            <button
              type="button"
              onClick={() => void openMacDownload()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-black transition hover:bg-gray-100"
            >
              <Download className="h-4 w-4" />
              Download update
            </button>
          ) : null}

          {isWindows && isReady ? (
            <button
              type="button"
              onClick={() => void installUpdate()}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-sm font-medium text-black transition hover:bg-gray-100"
            >
              <RefreshCw className="h-4 w-4" />
              Update now
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
