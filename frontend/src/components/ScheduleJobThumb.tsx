import { useEffect, useRef, useState } from 'react';
import { ImageIcon } from 'lucide-react';
import {
  fetchScheduledContentAsset,
  type ScheduledContentJob,
} from '@/lib/api';

type CachedThumb = { url: string; refs: number; inflight?: Promise<string> };
const thumbCache = new Map<string, CachedThumb>();

function retainThumb(jobId: string, url: string) {
  const existing = thumbCache.get(jobId);
  if (existing) {
    existing.refs += 1;
    existing.url = url;
    return;
  }
  thumbCache.set(jobId, { url, refs: 1 });
}

function releaseThumb(jobId: string) {
  const existing = thumbCache.get(jobId);
  if (!existing) return;
  existing.refs -= 1;
  if (existing.refs > 0) return;
  URL.revokeObjectURL(existing.url);
  thumbCache.delete(jobId);
}

function loadThumb(jobId: string): Promise<string> {
  const existing = thumbCache.get(jobId);
  if (existing?.url) return Promise.resolve(existing.url);
  if (existing?.inflight) return existing.inflight;
  const inflight = fetchScheduledContentAsset(jobId).then((blob) => {
    const url = URL.createObjectURL(blob);
    const current = thumbCache.get(jobId);
    if (current) {
      current.url = url;
      current.inflight = undefined;
    } else {
      thumbCache.set(jobId, { url, refs: 0 });
    }
    return url;
  });
  thumbCache.set(jobId, { url: existing?.url || '', refs: existing?.refs || 0, inflight });
  return inflight;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') return null;
  return value[0] as Record<string, unknown>;
}

function jobHasVaultMedia(job: ScheduledContentJob): boolean {
  const payload = job.payload && typeof job.payload === 'object' ? job.payload : {};
  const vaultItem = firstRecord(payload.vaults);
  const mediaItem = firstRecord(payload.media);
  const vaultId = String(payload.vaultId || vaultItem?.id || '');
  const mediaId = String(payload.mediaId || mediaItem?.mediaId || '');
  return (
    (Array.isArray(payload.vaults) && payload.vaults.length > 0) ||
    (Array.isArray(payload.media) && payload.media.length > 0) ||
    Boolean(vaultId || mediaId)
  );
}

export default function ScheduleJobThumb({
  job,
  className = 'w-10 h-10',
}: {
  job: ScheduledContentJob;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(() => thumbCache.get(job.id)?.url || null);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const showVault = !job.hasImage && jobHasVaultMedia(job);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!job.hasImage || !visible) {
      if (!job.hasImage) setUrl(null);
      return;
    }
    const cached = thumbCache.get(job.id)?.url;
    if (cached) {
      retainThumb(job.id, cached);
      setUrl(cached);
      return () => releaseThumb(job.id);
    }
    let cancelled = false;
    void loadThumb(job.id)
      .then((next) => {
        if (cancelled) return;
        retainThumb(job.id, next);
        setUrl(next);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (thumbCache.get(job.id)?.url) releaseThumb(job.id);
    };
  }, [job.id, job.hasImage, visible]);

  if (!job.hasImage && !showVault) return null;

  return (
    <div ref={rootRef} className={`shrink-0 relative ${className}`}>
      {url ? (
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover rounded-md border border-gray-200 dark:border-zinc-700"
        />
      ) : (
        <div className="w-full h-full rounded-md border border-gray-200 dark:border-zinc-700 bg-gray-50 dark:bg-zinc-900 flex items-center justify-center">
          <ImageIcon className="w-4 h-4 text-gray-400" />
        </div>
      )}
      {url && (
        <ImageIcon className="absolute -bottom-1 -right-1 w-4 h-4 text-gray-400 bg-white dark:bg-zinc-900 rounded-full p-0.5" />
      )}
    </div>
  );
}
