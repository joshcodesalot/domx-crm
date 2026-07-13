import { useEffect, useRef } from 'react';
import { useAuth } from '@/context/AuthContext';
import {
  createMessagingDashboardEntry,
  getCreators,
  upsertMaloumSentMessage,
  type Creator,
} from '@/lib/api';
import type { MaloumSentMessageRecord } from '@/types/electron';

function isLiveDashboardRecord(record: MaloumSentMessageRecord): boolean {
  return Boolean(
    record.contentType ||
    record.englishMessage ||
    record.actualSentText ||
    record.fanUsername ||
    record.responseTimeSeconds != null
  );
}

const persistedDashboardIds = new Set<string>();

async function persistTrackedMessage(
  record: MaloumSentMessageRecord,
  creators: Creator[],
  userEmail: string | undefined
) {
  if (!record.creatorId || record.sentByUserId === 'unknown') {
    return;
  }

  await upsertMaloumSentMessage({
    id: record.id,
    creatorId: record.creatorId,
    chatId: record.chatId,
    maloumMessageId: record.maloumMessageId,
    optimisticMessageId: record.optimisticMessageId,
    contentText: record.contentText,
    sentByUserId: record.sentByUserId,
    sentByUserName: record.sentByUserName,
    sentAt: record.sentAt,
    status: record.status,
    domMarked: record.domMarked,
  });

  if (record.status !== 'confirmed' || !record.maloumMessageId) {
    return;
  }

  if (!isLiveDashboardRecord(record)) {
    return;
  }

  if (persistedDashboardIds.has(record.maloumMessageId)) {
    return;
  }

  const creator = creators.find((item) => item.id === record.creatorId);

  try {
    await createMessagingDashboardEntry({
      id: record.id,
      creatorId: record.creatorId,
      creatorName: creator?.displayName,
      creatorUsername: creator?.username,
      creatorAvatarUrl: creator?.avatarUrl,
      chatterId: record.sentByUserId,
      chatterName: record.sentByUserName,
      chatterEmail: userEmail,
      chatId: record.chatId,
      fanId: record.fanId ?? null,
      fanUsername: record.fanUsername ?? null,
      maloumMessageId: record.maloumMessageId,
      optimisticMessageId: record.optimisticMessageId,
      contentType: record.contentType || 'text',
      englishMessage: record.englishMessage ?? record.originalEnglishText ?? record.contentText,
      germanTranslatedMessage:
        record.germanTranslatedMessage ?? record.translatedGermanText ?? record.contentText,
      actualSentText: record.actualSentText ?? record.contentText,
      priceNet: record.priceNet ?? null,
      currency: record.currency || 'EUR',
      purchased: record.purchased ?? false,
      mediaCount: record.mediaCount ?? 0,
      pictureCount: record.pictureCount ?? 0,
      videoCount: record.videoCount ?? 0,
      mediaJson: record.mediaJson ?? null,
      previousFanMessageAt: record.previousFanMessageAt ?? null,
      responseTimeSeconds: record.responseTimeSeconds ?? null,
      sentAt: record.sentAt,
    });

    persistedDashboardIds.add(record.maloumMessageId);
  } catch {
    // Persistence failures are non-blocking for the chatter UI.
  }
}

export function useMessagingTrackerPersistence() {
  const { user, isAuthenticated } = useAuth();
  const creatorsRef = useRef<Creator[]>([]);

  useEffect(() => {
    if (!isAuthenticated) {
      persistedDashboardIds.clear();
      return;
    }

    void getCreators()
      .then(({ creators }) => {
        creatorsRef.current = creators;
      })
      .catch(() => {
        creatorsRef.current = [];
      });
  }, [isAuthenticated]);

  useEffect(() => {
    if (!window.electronAPI?.isElectron || !window.electronAPI.onSentMessageTracked) {
      return;
    }

    const unsubscribe = window.electronAPI.onSentMessageTracked(({ record }) => {
      void persistTrackedMessage(record, creatorsRef.current, user?.email).catch(() => {});
    });

    return () => {
      unsubscribe();
    };
  }, [user?.id, user?.email]);
}
