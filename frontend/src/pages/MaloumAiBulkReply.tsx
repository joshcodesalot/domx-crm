import AiBulkReplyPage from '@/components/bulkReply/AiBulkReplyPage';
import maloumIcon from '@/assets/maloum_icon.png';

export default function MaloumAiBulkReply() {
  return (
    <AiBulkReplyPage
      platform="maloum"
      platformLabel="Maloum"
      platformIcon={
        <img src={maloumIcon} alt="" className="w-5 h-5 rounded" />
      }
    />
  );
}
