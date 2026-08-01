import AiBulkReplyPage from '@/components/bulkReply/AiBulkReplyPage';
import fourBasedIcon from '@/assets/4based_icon.ico';

export default function FourBasedAiBulkReply() {
  return (
    <AiBulkReplyPage
      platform="4based"
      platformLabel="4based"
      platformIcon={
        <img src={fourBasedIcon} alt="" className="w-5 h-5 rounded object-cover" />
      }
    />
  );
}
