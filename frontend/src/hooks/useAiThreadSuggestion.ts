import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  ApiError,
  approveAiSuggestion,
  editSendAiSuggestion,
  getAiSuggestionByChat,
  patchAiCreatorSettings,
  regenerateAiSuggestion,
  rejectAiSuggestion,
  takeoverAiConversation,
  type AiIngestPlatform,
  type AiSuggestion,
} from '@/lib/api';
import {
  useAiSuggestionEvents,
  type AiSuggestionEvent,
} from '@/hooks/useAiSuggestionEvents';

function suggestionFromEvent(event: AiSuggestionEvent): AiSuggestion {
  return {
    id: event.suggestionId || '',
    runId: event.runId,
    conversationId: event.conversationId,
    creatorId: event.creatorId,
    platform: event.platform,
    platformChatId: event.platformChatId,
    revision: event.revision,
    anchorInboundMessageId: event.anchorInboundMessageId,
    status: event.status,
    reply: event.reply,
    replyEnglish: event.replyEnglish,
    intent: event.intent,
    action: event.action ?? null,
    route: event.route,
    output: {
      action: event.action ?? null,
      mediaId: event.mediaId ?? null,
      price: event.price ?? null,
    },
    createdAt: null,
    updatedAt: null,
  };
}

function isClearingError(err: unknown) {
  if (!(err instanceof ApiError)) return false;
  return (
    err.status === 409 ||
    err.code === 'stale' ||
    err.code === 'not_pending' ||
    err.code === 'send_failed'
  );
}

export function useAiThreadSuggestion(opts: {
  creatorId: string;
  platform: AiIngestPlatform;
  platformChatId: string;
  latestInboundId?: string | null;
}) {
  const { hasPermission } = useAuth();
  const canView = hasPermission('ai.suggest.use');
  const canPause = hasPermission('ai.settings.manage');
  const canTakeover =
    hasPermission('ai.moderate') || hasPermission('ai.settings.manage');
  const canSend = opts.platform === 'maloum';
  const [suggestion, setSuggestion] = useState<AiSuggestion | null>(null);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!canView || !opts.creatorId || !opts.platformChatId) return;
    try {
      const result = await getAiSuggestionByChat({
        creatorId: opts.creatorId,
        platform: opts.platform,
        platformChatId: opts.platformChatId,
      });
      setSuggestion(result.suggestion);
    } catch {
      // Chat UX must stay unchanged if lookup fails.
    }
  }, [canView, opts.creatorId, opts.platform, opts.platformChatId]);

  useEffect(() => {
    setSuggestion(null);
    setDismissedId(null);
    setActionError(null);
    void refetch();
  }, [refetch]);

  useAiSuggestionEvents({
    creatorId: opts.creatorId,
    platformChatId: opts.platformChatId,
    onSuggestion: (event) => {
      if (!canView) return;
      setDismissedId(null);
      setSuggestion(suggestionFromEvent(event));
    },
  });

  const visible =
    suggestion &&
    suggestion.status === 'pending' &&
    suggestion.id !== dismissedId
      ? suggestion
      : null;

  const stale = useMemo(() => {
    if (!visible?.anchorInboundMessageId || !opts.latestInboundId) return false;
    return visible.anchorInboundMessageId !== opts.latestInboundId;
  }, [visible, opts.latestInboundId]);

  const dismiss = useCallback(() => {
    if (suggestion?.id) setDismissedId(suggestion.id);
  }, [suggestion?.id]);

  const clearCard = useCallback(() => {
    setSuggestion(null);
    setActionError(null);
  }, []);

  const runAction = useCallback(
    async (fn: () => Promise<void>, { clearOnSuccess = true } = {}) => {
      if (!visible?.id || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        await fn();
        if (clearOnSuccess) clearCard();
      } catch (err) {
        if (isClearingError(err)) {
          clearCard();
          return;
        }
        setActionError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [visible?.id, busy, clearCard]
  );

  const approve = useCallback(() => {
    if (!canSend || !visible?.id) return Promise.resolve();
    return runAction(async () => {
      await approveAiSuggestion(visible.id);
    });
  }, [canSend, visible?.id, runAction]);

  const editSend = useCallback(
    (text: string) => {
      if (!canSend || !visible?.id) return Promise.resolve();
      return runAction(async () => {
        await editSendAiSuggestion(visible.id, {
          text,
          englishText: visible.replyEnglish || undefined,
        });
      });
    },
    [canSend, visible, runAction]
  );

  const reject = useCallback(() => {
    if (!visible?.id) return Promise.resolve();
    return runAction(async () => {
      await rejectAiSuggestion(visible.id);
    });
  }, [visible?.id, runAction]);

  const regenerate = useCallback(() => {
    if (!visible?.id) return Promise.resolve();
    return runAction(
      async () => {
        const result = await regenerateAiSuggestion(visible.id);
        if (result.status === 'skipped' || result.status === 'failed') {
          throw new Error(result.skipReason || 'Could not regenerate');
        }
        await refetch();
      },
      { clearOnSuccess: false }
    );
  }, [visible?.id, runAction, refetch]);

  const takeover = useCallback(() => {
    if (!canTakeover || !visible?.conversationId) return Promise.resolve();
    return runAction(
      async () => {
        await takeoverAiConversation(visible.conversationId as string);
      },
      { clearOnSuccess: false }
    );
  }, [canTakeover, visible?.conversationId, runAction]);

  const pause = useCallback(() => {
    if (!canPause || !opts.creatorId) return Promise.resolve();
    return runAction(
      async () => {
        await patchAiCreatorSettings(opts.creatorId, { paused: true });
      },
      { clearOnSuccess: false }
    );
  }, [canPause, opts.creatorId, runAction]);

  return {
    suggestion: canView ? visible : null,
    stale,
    dismiss,
    busy,
    actionError,
    canSend,
    canPause,
    canTakeover,
    approve,
    editSend,
    reject,
    regenerate,
    takeover,
    pause,
  };
}
