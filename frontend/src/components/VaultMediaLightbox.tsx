import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

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
  useEffect(() => {
    setUseFallback(false);
  }, [url]);
  const pictureSrc =
    useFallback && fallbackUrl && fallbackUrl !== url ? fallbackUrl : url;

  return (
    <div
      className={`fixed inset-0 ${zClassName} flex items-center justify-center bg-black/20 dark:bg-black/70 p-6 animate-fade-in`}
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
          className="relative z-10 w-full max-w-3xl aspect-[9/16] max-h-full rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      ) : kind === 'video' ? (
        <video
          src={url}
          controls
          autoPlay
          playsInline
          poster={poster || undefined}
          className="relative z-10 max-w-full max-h-full rounded-lg bg-gray-900 dark:bg-black animate-slide-up"
        >
          <track kind="captions" />
        </video>
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
          className="relative z-10 max-w-full max-h-full rounded-lg object-contain animate-slide-up"
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
