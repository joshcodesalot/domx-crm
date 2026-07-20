import { useState } from 'react';
import { resolveCreatorAvatarUrl } from '@/lib/api';

function displayInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

interface CreatorAvatarProps {
  avatarUrl: string | null | undefined;
  displayName: string;
  className?: string;
  initialsClassName?: string;
}

export default function CreatorAvatar({
  avatarUrl,
  displayName,
  className = 'w-10 h-10 rounded-full object-cover shrink-0',
  initialsClassName = 'w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center shrink-0 text-orange-600 font-bold text-sm',
}: CreatorAvatarProps) {
  const [failed, setFailed] = useState(false);
  const src = resolveCreatorAvatarUrl(avatarUrl);

  if (!src || failed) {
    return <div className={initialsClassName}>{displayInitial(displayName)}</div>;
  }

  return (
    <img
      src={src}
      alt={displayName}
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
