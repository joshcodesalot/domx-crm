import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Loader2, X } from 'lucide-react';

function isHlsUrl(value: string): boolean {
  const path = value.split('?')[0].toLowerCase();
  if (path.endsWith('.m3u8')) return true;
  try {
    const inner = new URL(value, 'http://localhost').searchParams.get('url') || '';
    return inner.split('?')[0].toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

export type VaultMediaLightboxKind = 'picture' | 'video' | 'embed';

export type VaultMediaLightboxProps = {
  url: string;
  kind: VaultMediaLightboxKind;
  onClose: () => void;
  poster?: string | null;
  /** Used when the primary picture URL fails to load. */
  fallbackUrl?: string | null;
  /** Raised when open above other modals (e.g. vault picker). */
  zClassName?: string;
};

export default function VaultMediaLightbox({
  url,
  kind,
  onClose,
  poster,
  fallbackUrl,
  zClassName = 'z-[60]',
}: VaultMediaLightboxProps) {
  const [useFallback, setUseFallback] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsPlayback = kind === 'video' && isHlsUrl(url);
  useEffect(() => {
    setUseFallback(false);
    setVideoReady(false);
  }, [url]);
  useEffect(() => {
    const video = videoRef.current;
    if (!hlsPlayback || !video) return;
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls();
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) setVideoReady(true);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
    }
    return () => {
      hls?.destroy();
    };
  }, [hlsPlayback, url]);
  const pictureSrc =
    useFallback && fallbackUrl && fallbackUrl !== url ? fallbackUrl : url;

  return (
    <div
      className={`fixed inset-0 ${zClassName} flex min-h-0 min-w-0 items-center justify-center overflow-hidden bg-black/20 dark:bg-black/70 p-6 animate-fade-in`}
    >
      <button
        type="button"
        className="absolute inset-0"
        aria-label="Close preview"
        onClick={onClose}
      />
      {kind === 'embed' ? (
        <iframe
          src={url}
          title="Video"
          className="relative z-10 min-h-0 min-w-0 h-[calc(100dvh-3rem)] w-[calc(100dvw-3rem)] max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-3rem)] rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : kind === 'video' ? (
        <div
          className={`relative z-10 flex min-h-0 min-w-0 items-center justify-center max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-3rem)] ${
            videoReady ? '' : 'min-w-[240px] min-h-[160px]'
          }`}
        >
          {!videoReady && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/40 pointer-events-none">
              <Loader2 className="w-8 h-8 animate-spin text-white" />
            </div>
          )}
          <video
            ref={videoRef}
            src={hlsPlayback ? undefined : url}
            controls
            autoPlay
            playsInline
            poster={poster || undefined}
            onCanPlay={() => setVideoReady(true)}
            onPlaying={() => setVideoReady(true)}
            onError={() => setVideoReady(true)}
            className="h-auto w-auto max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-3rem)] object-contain rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
          >
            <track kind="captions" />
          </video>
        </div>
      ) : (
        <img
          src={pictureSrc}
          alt=""
          onError={() => {
            if (
              !useFallback &&
              fallbackUrl &&
              fallbackUrl !== url
            ) {
              setUseFallback(true);
            }
          }}
          className="relative z-10 min-h-0 min-w-0 h-auto w-auto max-h-[calc(100dvh-3rem)] max-w-[calc(100dvw-3rem)] object-contain rounded-lg animate-slide-up"
        />
      )}
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/30 dark:bg-black/50 text-white"
        aria-label="Close"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
}
