import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  getAiConversationByChat,
  ignoreAiConversation,
  ignoreAiConversationByChat,
  unignoreAiConversation,
  type AiIngestPlatform,
} from '@/lib/api';

export function useAiThreadControls(opts: {
  creatorId: string;
  platform: AiIngestPlatform;
  platformChatId: string;
}) {
  const { hasPermission } = useAuth();
  const canIgnore =
    (hasPermission('ai.moderate') || hasPermission('ai.settings.manage')) &&
    Boolean(opts.creatorId && opts.platformChatId);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [aiIgnored, setAiIgnored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!canIgnore || !opts.creatorId || !opts.platformChatId) return;
    try {
      const result = await getAiConversationByChat({
        creatorId: opts.creatorId,
        platform: opts.platform,
        platformChatId: opts.platformChatId,
      });
      setConversationId(result.conversation?.conversationId || null);
      setAiIgnored(Boolean(result.conversation?.aiIgnored));
    } catch {
      // Composer UX must stay unchanged if lookup fails.
    }
  }, [canIgnore, opts.creatorId, opts.platform, opts.platformChatId]);

  useEffect(() => {
    setConversationId(null);
    setAiIgnored(false);
    setError(null);
    void refetch();
  }, [refetch]);

  const ignore = useCallback(async () => {
    if (!canIgnore || busy || !opts.creatorId || !opts.platformChatId) return false;
    setBusy(true);
    setError(null);
    try {
      const result = conversationId
        ? await ignoreAiConversation(conversationId)
        : await ignoreAiConversationByChat({
            creatorId: opts.creatorId,
            platform: opts.platform,
            platformChatId: opts.platformChatId,
          });
      const row = result.conversation;
      const id =
        typeof row?.id === 'string'
          ? row.id
          : typeof row?.conversationId === 'string'
            ? row.conversationId
            : conversationId;
      setConversationId(id);
      setAiIgnored(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not ignore AI');
      return false;
    } finally {
      setBusy(false);
    }
  }, [
    canIgnore,
    busy,
    conversationId,
    opts.creatorId,
    opts.platform,
    opts.platformChatId,
  ]);

  const unignore = useCallback(async () => {
    if (!canIgnore || busy || !conversationId) return;
    setBusy(true);
    setError(null);
    try {
      await unignoreAiConversation(conversationId);
      setAiIgnored(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not un-ignore AI');
    } finally {
      setBusy(false);
    }
  }, [canIgnore, busy, conversationId]);

  return {
    canIgnore,
    aiIgnored,
    busy,
    error,
    ignore,
    unignore,
  };
}
