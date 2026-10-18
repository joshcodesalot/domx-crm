import { fanslyMediaKind, type FanslyMediaKind } from '@/lib/api';

export default function FanslyKindBadge({
  kind,
  mediaType,
  className = 'bottom-1 left-1',
}: {
  kind?: string | null;
  mediaType?: number | null;
  className?: string;
}) {
  if ((kind == null || kind === '') && mediaType == null) return null;
  const resolved: FanslyMediaKind = fanslyMediaKind({ kind, mediaType });
  if (resolved === 'audio') return null;
  return (
    <span
      className={`pointer-events-none absolute z-10 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold text-white ${className}`}
    >
      {resolved === 'video' ? 'Video' : 'Image'}
    </span>
  );
}
