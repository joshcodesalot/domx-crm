export default function BootLoadingScreen() {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-white dark:bg-[#0a0a0a]">
      <div className="w-10 h-10 rounded-full border-2 border-brand-600 border-t-transparent animate-spin" />
    </div>
  );
}
