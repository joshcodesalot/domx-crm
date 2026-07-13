import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

interface StaffCredentialsModalProps {
  email: string;
  tempPassword: string;
  title: string;
  onClose: () => void;
}

function formatCredentials(email: string, tempPassword: string): string {
  return `Email: ${email}\nPassword: ${tempPassword}`;
}

export default function StaffCredentialsModal({
  email,
  tempPassword,
  title,
  onClose,
}: StaffCredentialsModalProps) {
  const [copied, setCopied] = useState(false);
  const credentialsText = formatCredentials(email, tempPassword);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(credentialsText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md bg-white dark:bg-[#1a1a1a] rounded-xl border border-gray-200 dark:border-white/10 shadow-xl">
        <div className="p-6">
          <h3 className="text-lg font-semibold mb-2">{title}</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Share these credentials with the staff member. The temporary password is shown only once.
          </p>

          <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5 p-4 font-mono text-sm whitespace-pre-wrap text-gray-900 dark:text-gray-100">
            {credentialsText}
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={handleCopy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5"
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  Copy
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
