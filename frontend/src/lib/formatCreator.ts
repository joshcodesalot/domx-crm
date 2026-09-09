export function formatPlatformLabel(
  platform?: string | null
): string | null {
  if (platform === 'maloum') return 'Maloum';
  if (platform === '4based') return '4based';
  if (platform === 'telegram') return 'Telegram';
  return null;
}

export function formatCreatorOption(creator: {
  displayName?: string | null;
  platform?: string | null;
}): string {
  const name = (creator.displayName || '').trim() || 'Creator';
  const platform = formatPlatformLabel(creator.platform);
  return platform ? `${name} (${platform})` : name;
}
