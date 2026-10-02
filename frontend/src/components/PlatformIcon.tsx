import fourBasedIcon from '@/assets/4based_icon.ico';
import fanslyIcon from '@/assets/fansly.svg';
import maloumIcon from '@/assets/maloum_icon.png';
import telegramIcon from '@/assets/telegram_icon.svg';

export default function PlatformIcon({
  platform,
  className = 'w-3.5 h-3.5 shrink-0',
}: {
  platform?: string | null;
  className?: string;
}) {
  if (platform === '4based') {
    return <img src={fourBasedIcon} alt="" className={className} />;
  }
  if (platform === 'telegram') {
    return <img src={telegramIcon} alt="" className={`${className} rounded-full`} />;
  }
  if (platform === 'fansly') {
    return <img src={fanslyIcon} alt="" className={className} />;
  }
  if (platform === 'maloum') {
    return (
      <img src={maloumIcon} alt="" className={`${className} rounded-sm object-cover`} />
    );
  }
  return null;
}
