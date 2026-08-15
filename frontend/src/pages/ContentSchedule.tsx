import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  Check,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import Sidebar from '@/components/Sidebar';
import CreatorAvatar from '@/components/CreatorAvatar';
import ScheduleDateTimePicker, {
  type ScheduleJobKindFilter,
  type ScheduleJobPlatformFilter,
} from '@/components/ScheduleDateTimePicker';
import ScheduleJobThumb from '@/components/ScheduleJobThumb';
import ScheduleVaultPicker, {
  type ScheduleVaultPick,
} from '@/components/ScheduleVaultPicker';
import { useToast } from '@/context/ToastContext';
import {
  cancelScheduledContent,
  commitScheduledContentImport,
  getCreators,
  listFourBasedUserLists,
  listMaloumCategories,
  listMaloumChatLists,
  listScheduleSettings,
  listScheduledContent,
  previewScheduledContentImport,
  updateScheduleSettings,
  uploadScheduledContentAsset,
  type Creator,
  type CreatorScheduleSettings,
  type FourBasedUserList,
  type MaloumCategory,
  type MaloumChatListItem,
  type ScheduledContentJob,
  type ScheduledContentKind,
  type ScheduledImportAsset,
} from '@/lib/api';
import {
  berlinDateTimeLabel,
  berlinNowParts,
  berlinWallToIso,
  useStaffTimeZone,
} from '@/lib/berlinTime';
import {
  buildManagedListRanks,
  findDefaultIncludeList,
  friendlyCategoryName,
  friendlyListName,
  isManagedListCode,
} from '@/lib/maloumLabels';

const AUDIENCE_FILTERS = [
  { id: 'users_with_purchases', label: 'Buyers' },
  { id: 'users_with_subscription', label: 'Subscribers' },
  { id: 'users_without_purchases', label: 'Non-buyers' },
  { id: 'users_without_subscription', label: 'Non-subscribers' },
] as const;

const ALL_AUDIENCE = AUDIENCE_FILTERS.map((f) => f.id);

type ReviewRow = {
  key: string;
  included: boolean;
  kind: ScheduledContentKind | '';
  platform: 'maloum' | '4based' | '';
  model: string;
  creatorId: string;
  date: string;
  time: string;
  bodyText: string;
  imageSource: 'upload' | 'vault';
  assetId: string | null;
  imageFileName: string;
  vaultLabel: string;
  vaultThumb: string | null;
  payload: Record<string, unknown>;
};

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== 'object') return null;
  return value[0] as Record<string, unknown>;
}

function vaultIdsFromPayload(payload: Record<string, unknown>): {
  vaultId: string;
  vaultGuid: string;
  mediaId: string;
} {
  const vaultItem = firstRecord(payload.vaults);
  const mediaItem = firstRecord(payload.media);
  return {
    vaultId: String(payload.vaultId || vaultItem?.id || ''),
    vaultGuid: String(payload.vaultGuid || vaultItem?.guid || ''),
    mediaId: String(payload.mediaId || mediaItem?.mediaId || ''),
  };
}

function vaultPayloadForKind(
  kind: ReviewRow['kind'],
  platform: ReviewRow['platform'],
  source: Record<string, unknown>
): Record<string, unknown> {
  const { vaultId, vaultGuid, mediaId } = vaultIdsFromPayload(source);
  if (kind === 'mass_message') {
    if (platform === '4based' && vaultId) {
      return {
        vaults: [
          {
            id: vaultId,
            guid: vaultGuid || crypto.randomUUID(),
            position: 0,
            is_teaser: false,
          },
        ],
      };
    }
    if (platform === 'maloum' && mediaId) {
      return { media: [{ mediaId, type: 'picture' }] };
    }
    return {};
  }
  if (kind === 'feed_post') {
    if (platform === '4based' && vaultId) {
      return vaultGuid ? { vaultId, vaultGuid } : { vaultId };
    }
    if (platform === 'maloum' && mediaId) {
      return { mediaId };
    }
  }
  return {};
}

function LocalThumb({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  return <img src={url} alt="" className="w-16 h-16 rounded-lg object-cover" />;
}

function jobStatusClass(status: ScheduledContentJob['status']): string {
  if (status === 'sent') return 'text-emerald-500';
  if (status === 'pending' || status === 'running') return 'text-amber-500';
  if (status === 'failed' || status === 'cancelled') return 'text-red-400';
  return 'text-gray-400';
}

function ScheduleJobCard({
  job,
  timeZone,
  onCancel,
}: {
  job: ScheduledContentJob;
  timeZone: string;
  onCancel?: () => void;
}) {
  return (
    <article className="p-3 bg-white dark:bg-zinc-900/40 border border-gray-200 dark:border-zinc-800 rounded-md flex justify-between items-center hover:border-gray-300 dark:hover:border-zinc-700 transition-colors gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <ScheduleJobThumb job={job} />
        <div className="min-w-0">
          <div className="font-medium text-gray-800 dark:text-zinc-200 truncate">
            {job.creatorName || 'Creator'} · {job.kind === 'feed_post' ? 'Feed' : 'Mass'} ·{' '}
            <span className="text-gray-400 font-normal">{job.platform}</span>
            {' · '}
            <span className={jobStatusClass(job.status)}>{job.status}</span>
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {berlinDateTimeLabel(job.runAt, timeZone)}
          </div>
          {job.bodyText && (
            <p className="text-xs text-gray-500 dark:text-zinc-400 mt-1 line-clamp-2">
              {job.bodyText}
            </p>
          )}
          {job.lastError && (
            <p className="text-xs text-red-400 mt-1">{job.lastError}</p>
          )}
        </div>
      </div>
      {onCancel && (
        <button
          type="button"
          onClick={() => void onCancel()}
          className="p-2 rounded-lg text-gray-400 hover:text-red-500 shrink-0"
          title="Cancel"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </article>
  );
}

function rowIssues(row: ReviewRow): string[] {
  const errors: string[] = [];
  if (!row.kind) errors.push('Choose mass message or feed');
  if (!row.platform) errors.push('Choose a platform');
  if (!row.creatorId) errors.push('Choose a creator');
  if (!row.date || !row.time) errors.push('Date and time are required');
  if (row.kind === 'feed_post') {
    const hasVault =
      (row.platform === '4based' && Boolean(row.payload.vaultId)) ||
      (row.platform === 'maloum' && Boolean(row.payload.mediaId));
    if (row.imageSource === 'upload' && !row.assetId) {
      errors.push('Pick an uploaded image or a vault item');
    }
    if (row.imageSource === 'vault' && !hasVault) {
      errors.push('Pick a vault item');
    }
  }
  return errors;
}

export default function ContentSchedule() {
  const { toast } = useToast();
  const timeZone = useStaffTimeZone();
  const now = berlinNowParts(timeZone);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [jobs, setJobs] = useState<ScheduledContentJob[]>([]);
  const [settings, setSettings] = useState<CreatorScheduleSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [lists, setLists] = useState<Array<FourBasedUserList | MaloumChatListItem>>(
    []
  );
  const [categories, setCategories] = useState<MaloumCategory[]>([]);
  const [pickerDate, setPickerDate] = useState(now.date);
  const [pickerTime, setPickerTime] = useState(now.time);
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([]);
  const [assets, setAssets] = useState<ScheduledImportAsset[]>([]);
  const [fileByAssetId, setFileByAssetId] = useState<Record<string, File>>({});
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [vaultRowKey, setVaultRowKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'import' | 'history'>('import');
  const [platformFilter, setPlatformFilter] =
    useState<ScheduleJobPlatformFilter>('all');
  const [kindFilter, setKindFilter] = useState<ScheduleJobKindFilter>('all');
  const [categorySearch, setCategorySearch] = useState('');
  const defaultedIncludeRef = useRef(new Set<string>());

  const selectedCreator = useMemo(
    () => creators.find((c) => c.id === selectedCreatorId) || null,
    [creators, selectedCreatorId]
  );
  const selectedSettings = useMemo(
    () => settings.find((s) => s.creatorId === selectedCreatorId),
    [settings, selectedCreatorId]
  );
  const selectedRow = reviewRows.find((row) => row.key === selectedRowKey) || null;
  const vaultRow = reviewRows.find((row) => row.key === vaultRowKey) || null;

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [creatorRes, jobRes, settingRes] = await Promise.all([
        getCreators(),
        listScheduledContent(),
        listScheduleSettings(),
      ]);
      setCreators(creatorRes.creators || []);
      setJobs(jobRes.jobs || []);
      setSettings(settingRes.settings || []);
      setSelectedCreatorId((prev) => {
        if (prev) return prev;
        return creatorRes.creators?.[0]?.id || null;
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load schedule');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!selectedCreator) {
      setLists([]);
      setCategories([]);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        if (selectedCreator.platform === '4based') {
          const result = await listFourBasedUserLists(selectedCreator.id, {
            limit: 80,
          });
          if (!cancelled) setLists(result.lists || []);
          setCategories([]);
        } else {
          const [listRes, catRes] = await Promise.all([
            listMaloumChatLists(selectedCreator.id, { limit: 80 }),
            listMaloumCategories(selectedCreator.id),
          ]);
          if (!cancelled) {
            setLists(listRes.lists || []);
            setCategories(catRes.categories || []);
          }
        }
      } catch {
        if (!cancelled) {
          setLists([]);
          setCategories([]);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedCreator]);

  const current = selectedSettings || {
    creatorId: selectedCreatorId || '',
    audienceFilters: ALL_AUDIENCE,
    includeListIds: [],
    excludeListIds: [],
    categoryIds: [],
  };

  const saveSettings = async (next: CreatorScheduleSettings) => {
    if (!selectedCreatorId) return;
    setSavingSettings(true);
    try {
      const result = await updateScheduleSettings(selectedCreatorId, next);
      setSettings((prev) => {
        const rest = prev.filter((s) => s.creatorId !== selectedCreatorId);
        return [
          ...rest,
          {
            ...result.settings,
            displayName: selectedCreator?.displayName,
            platform: selectedCreator?.platform,
          },
        ];
      });
      toast.success('Saved targeting for this creator');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    setCategorySearch('');
  }, [selectedCreatorId]);

  useEffect(() => {
    if (!selectedCreator || selectedCreator.platform !== 'maloum') return;
    if (lists.length === 0) return;
    if (defaultedIncludeRef.current.has(selectedCreator.id)) return;
    const existing = selectedSettings?.includeListIds ?? [];
    if (existing.length > 0) {
      defaultedIncludeRef.current.add(selectedCreator.id);
      return;
    }
    const defaultList = findDefaultIncludeList(lists as MaloumChatListItem[]);
    if (!defaultList?._id) return;
    defaultedIncludeRef.current.add(selectedCreator.id);
    void saveSettings({
      creatorId: selectedCreator.id,
      audienceFilters: selectedSettings?.audienceFilters ?? ALL_AUDIENCE,
      includeListIds: [String(defaultList._id)],
      excludeListIds: selectedSettings?.excludeListIds ?? [],
      categoryIds: selectedSettings?.categoryIds ?? [],
    });
  }, [selectedCreator, lists, selectedSettings]);

  const maloumLists = useMemo(
    () =>
      selectedCreator?.platform === 'maloum'
        ? (lists as MaloumChatListItem[])
        : [],
    [lists, selectedCreator]
  );
  const managedRanks = useMemo(
    () => buildManagedListRanks(maloumLists),
    [maloumLists]
  );
  const filteredCategories = useMemo(() => {
    const q = categorySearch.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((cat) =>
      friendlyCategoryName(cat.name || '').toLowerCase().includes(q)
    );
  }, [categories, categorySearch]);

  const updateRow = (key: string, patch: Partial<ReviewRow>) => {
    setReviewRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row))
    );
  };

  const handlePreview = async () => {
    setImporting(true);
    try {
      const uploadedAssets: ScheduledImportAsset[] = [];
      const nextFiles: Record<string, File> = {};
      const failedNames: string[] = [];
      for (const file of files) {
        try {
          const uploaded = await uploadScheduledContentAsset(file);
          uploadedAssets.push(uploaded.asset);
          nextFiles[uploaded.asset.id] = file;
        } catch {
          failedNames.push(file.name);
        }
      }
      const result = await previewScheduledContentImport(jsonText, []);
      const assetByName = new Map(
        uploadedAssets.map((asset) => [
          asset.originalFileName.trim().toLowerCase(),
          asset,
        ])
      );
      const usedNames = new Set<string>();
      const rows: ReviewRow[] = result.rows.map((row) => {
        const fileName = (row.imageFileName || '').trim().toLowerCase();
        const matched = fileName ? assetByName.get(fileName) : null;
        if (matched) usedNames.add(fileName);
        return {
          key: `row-${row.index}`,
          included: true,
          kind: row.kind || '',
          platform: row.platform || '',
          model: row.model,
          creatorId: row.creatorId || '',
          date: row.date,
          time: row.time,
          bodyText: row.bodyText,
          imageSource: 'upload',
          assetId: row.assetId || matched?.id || null,
          imageFileName: row.imageFileName || matched?.originalFileName || '',
          vaultLabel: '',
          vaultThumb: null,
          payload: {},
        };
      });
      const unusedFiles = uploadedAssets
        .filter(
          (asset) =>
            !usedNames.has(asset.originalFileName.trim().toLowerCase())
        )
        .map((asset) => asset.originalFileName);
      setAssets(uploadedAssets);
      setFileByAssetId(nextFiles);
      setReviewRows(rows);
      setSelectedRowKey(rows[0]?.key || null);
      if (failedNames.length > 0) {
        toast.error(`Could not upload: ${failedNames.join(', ')}`);
      }
      if (unusedFiles.length > 0) {
        toast.success(`Unused images available to assign: ${unusedFiles.join(', ')}`);
      }
      toast.success(`Review ${rows.length} row${rows.length === 1 ? '' : 's'} before scheduling`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleCommit = async () => {
    const checked = reviewRows.filter((row) => row.included);
    const invalid = checked.filter((row) => rowIssues(row).length > 0);
    if (checked.length === 0) {
      toast.error('Check at least one row to schedule');
      return;
    }
    if (invalid.length > 0) {
      toast.error('Fix highlighted rows before confirming');
      return;
    }
    setCommitting(true);
    try {
      const result = await commitScheduledContentImport(
        checked.map((row) => ({
          included: true,
          kind: row.kind as ScheduledContentKind,
          platform: row.platform as 'maloum' | '4based',
          creatorId: row.creatorId,
          runAt: berlinWallToIso(row.date, row.time, timeZone),
          bodyText: row.bodyText,
          assetId: row.imageSource === 'upload' ? row.assetId : null,
          payload: row.imageSource === 'vault' ? row.payload : {},
        }))
      );
      toast.success(
        `Scheduled ${result.jobs.length} job${result.jobs.length === 1 ? '' : 's'}`
      );
      if (result.errors[0]) toast.error(result.errors[0].error);
      setReviewRows([]);
      setAssets([]);
      setFileByAssetId({});
      setFiles([]);
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Confirm failed');
    } finally {
      setCommitting(false);
    }
  };

  const upcoming = useMemo(() => {
    return jobs
      .filter((job) => job.status === 'pending' || job.status === 'running')
      .filter((job) => {
        if (platformFilter !== 'all' && job.platform !== platformFilter) return false;
        if (kindFilter !== 'all' && job.kind !== kindFilter) return false;
        return true;
      })
      .slice()
      .sort((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());
  }, [jobs, platformFilter, kindFilter]);
  const history = useMemo(() => {
    return jobs
      .filter((job) => job.status !== 'pending' && job.status !== 'running')
      .filter((job) => {
        if (platformFilter !== 'all' && job.platform !== platformFilter) return false;
        if (kindFilter !== 'all' && job.kind !== kindFilter) return false;
        return true;
      })
      .slice()
      .sort((a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime())
      .slice(0, 80);
  }, [jobs, platformFilter, kindFilter]);

  return (
    <div className="h-screen flex bg-white dark:bg-zinc-950 text-gray-700 dark:text-zinc-300 antialiased overflow-hidden">
      <Sidebar activePage="schedule" />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="h-16 px-5 border-b border-gray-200 dark:border-zinc-800/60 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="w-5 h-5 text-domx-500" />
            <h1 className="text-sm font-semibold text-gray-900 dark:text-white">
              Content schedule
            </h1>
            <span className="text-[11px] text-gray-500">{timeZone}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-zinc-800"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div className="min-h-0 overflow-y-auto p-5 space-y-6 border-r border-gray-200 dark:border-zinc-800/60">
            <div className="flex gap-4 border-b border-gray-200 dark:border-zinc-800">
              {([
                ['import', 'Import'],
                ['history', 'History'],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={`pb-2 text-sm font-medium transition-colors ${
                    activeTab === id
                      ? 'text-domx-600 border-b-2 border-domx-600 -mb-px'
                      : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === 'import' && (
            <>
            <section className="space-y-3">
              <h2 className="text-xs font-semibold text-gray-500 tracking-wider">
                IMPORT JSON + IMAGES
              </h2>
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                rows={8}
                placeholder='[{"model":"Luna","platform":"4based","datetime":"2026-08-15 18:00","mass_message":"hey"},{"model":"Luna","platform":"maloum","datetime":"2026-08-15 12:00","caption":"new set","image_file":"luna-01.jpg"}]'
                className="w-full h-32 rounded-md border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-sm font-mono text-gray-800 dark:text-zinc-200 focus:outline-none focus:border-domx-500 resize-none"
              />
              <label className="flex items-center gap-3 cursor-pointer w-fit">
                <span className="flex items-center gap-2 px-4 py-2 bg-gray-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-zinc-700 text-sm rounded-md transition-colors text-gray-900 dark:text-white">
                  <Upload className="w-4 h-4" />
                  Choose Files
                </span>
                <span className="text-sm text-gray-500">
                  {files.length === 0
                    ? 'No file chosen'
                    : `${files.length} image${files.length === 1 ? '' : 's'} selected`}
                </span>
                <input
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={(e) => setFiles(Array.from(e.target.files || []))}
                  className="sr-only"
                />
              </label>
              <button
                type="button"
                onClick={() => void handlePreview()}
                disabled={importing || !jsonText.trim()}
                className="inline-flex items-center gap-2 self-start px-6 py-2 rounded-md bg-domx-600 hover:bg-domx-500 text-white text-sm font-medium disabled:opacity-40 transition-colors"
              >
                {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Review import
              </button>
            </section>

            {reviewRows.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Review before scheduling
                  </h2>
                  <button
                    type="button"
                    onClick={() => void handleCommit()}
                    disabled={committing}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-domx-600 text-white text-sm font-semibold disabled:opacity-40"
                  >
                    {committing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    Confirm schedule
                  </button>
                </div>
                <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-zinc-800">
                  <table className="w-full text-xs min-w-[860px]">
                    <thead className="bg-gray-50 dark:bg-zinc-900 text-left text-[10px] uppercase tracking-wider text-gray-500">
                      <tr>
                        <th className="p-2">Include</th>
                        <th className="p-2">Creator</th>
                        <th className="p-2">Kind</th>
                        <th className="p-2">When</th>
                        <th className="p-2">Text</th>
                        <th className="p-2">Image</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reviewRows.map((row) => {
                        const issues = row.included ? rowIssues(row) : [];
                        const platformCreators = creators.filter(
                          (c) => !row.platform || c.platform === row.platform
                        );
                        const assetFile = row.assetId ? fileByAssetId[row.assetId] : null;
                        return (
                          <tr
                            key={row.key}
                            className={`border-t border-gray-100 dark:border-zinc-800 align-top ${
                              selectedRowKey === row.key ? 'bg-domx-600/5' : ''
                            }`}
                            onClick={() => {
                              setSelectedRowKey(row.key);
                              if (row.date) setPickerDate(row.date);
                              if (row.time) setPickerTime(row.time);
                            }}
                          >
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={row.included}
                                onChange={(e) =>
                                  updateRow(row.key, { included: e.target.checked })
                                }
                              />
                            </td>
                            <td className="p-2 space-y-1">
                              <select
                                value={row.platform}
                                onChange={(e) => {
                                  const platform = e.target.value as ReviewRow['platform'];
                                  updateRow(row.key, {
                                    platform,
                                    creatorId: '',
                                    payload: {},
                                    vaultLabel: '',
                                    vaultThumb: null,
                                  });
                                }}
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              >
                                <option value="">Platform</option>
                                <option value="4based">4based</option>
                                <option value="maloum">maloum</option>
                              </select>
                              <select
                                value={row.creatorId}
                                onChange={(e) =>
                                  updateRow(row.key, { creatorId: e.target.value })
                                }
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              >
                                <option value="">
                                  {row.model ? `Unresolved: ${row.model}` : 'Creator'}
                                </option>
                                {platformCreators.map((creator) => (
                                  <option key={creator.id} value={creator.id}>
                                    {creator.displayName}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="p-2">
                              <select
                                value={row.kind}
                                onChange={(e) => {
                                  const kind = e.target.value as ReviewRow['kind'];
                                  updateRow(row.key, {
                                    kind,
                                    payload:
                                      row.imageSource === 'vault'
                                        ? vaultPayloadForKind(
                                            kind,
                                            row.platform,
                                            row.payload
                                          )
                                        : row.payload,
                                  });
                                }}
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              >
                                <option value="">Kind</option>
                                <option value="mass_message">Mass</option>
                                <option value="feed_post">Feed</option>
                              </select>
                            </td>
                            <td className="p-2 space-y-1">
                              <input
                                type="date"
                                value={row.date}
                                onChange={(e) =>
                                  updateRow(row.key, { date: e.target.value })
                                }
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              />
                              <input
                                type="time"
                                value={row.time}
                                onChange={(e) =>
                                  updateRow(row.key, { time: e.target.value })
                                }
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              />
                            </td>
                            <td className="p-2">
                              <textarea
                                value={row.bodyText}
                                onChange={(e) =>
                                  updateRow(row.key, { bodyText: e.target.value })
                                }
                                rows={3}
                                className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                              />
                              {issues.map((issue) => (
                                <p key={issue} className="text-[11px] text-red-500 mt-1">
                                  {issue}
                                </p>
                              ))}
                            </td>
                            <td className="p-2 space-y-1">
                              {row.kind === 'feed_post' ? (
                                <>
                                  <div className="flex gap-1">
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        updateRow(row.key, {
                                          imageSource: 'upload',
                                          payload: {},
                                          vaultLabel: '',
                                          vaultThumb: null,
                                        });
                                      }}
                                      className={`px-2 py-1 rounded-lg ${
                                        row.imageSource === 'upload'
                                          ? 'bg-domx-600 text-white'
                                          : 'bg-gray-100 dark:bg-zinc-800'
                                      }`}
                                    >
                                      Upload
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (!row.creatorId) {
                                          toast.error('Choose a creator first');
                                          return;
                                        }
                                        updateRow(row.key, { imageSource: 'vault' });
                                        setVaultRowKey(row.key);
                                      }}
                                      className={`px-2 py-1 rounded-lg ${
                                        row.imageSource === 'vault'
                                          ? 'bg-domx-600 text-white'
                                          : 'bg-gray-100 dark:bg-zinc-800'
                                      }`}
                                    >
                                      Vault
                                    </button>
                                  </div>
                                  {row.imageSource === 'upload' && (
                                    <>
                                      <select
                                        value={row.assetId || ''}
                                        onChange={(e) => {
                                          const asset = assets.find(
                                            (item) => item.id === e.target.value
                                          );
                                          updateRow(row.key, {
                                            assetId: e.target.value || null,
                                            imageFileName: asset?.originalFileName || '',
                                          });
                                        }}
                                        className="w-full rounded-lg border border-gray-200 dark:border-zinc-700 bg-transparent px-1 py-1"
                                      >
                                        <option value="">Batch file</option>
                                        {assets.map((asset) => (
                                          <option key={asset.id} value={asset.id}>
                                            {asset.originalFileName}
                                          </option>
                                        ))}
                                      </select>
                                      <input
                                        type="file"
                                        accept="image/jpeg,image/png,image/webp,image/gif"
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={async (e) => {
                                          const file = e.target.files?.[0];
                                          e.target.value = '';
                                          if (!file) return;
                                          try {
                                            const uploaded =
                                              await uploadScheduledContentAsset(file);
                                            setAssets((prev) => [
                                              ...prev,
                                              uploaded.asset,
                                            ]);
                                            setFileByAssetId((prev) => ({
                                              ...prev,
                                              [uploaded.asset.id]: file,
                                            }));
                                            updateRow(row.key, {
                                              assetId: uploaded.asset.id,
                                              imageFileName: uploaded.asset.originalFileName,
                                              imageSource: 'upload',
                                            });
                                          } catch (err) {
                                            toast.error(
                                              err instanceof Error
                                                ? err.message
                                                : 'Upload failed'
                                            );
                                          }
                                        }}
                                      />
                                      {assetFile && <LocalThumb file={assetFile} />}
                                    </>
                                  )}
                                  {row.imageSource === 'vault' && (
                                    <>
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          if (!row.creatorId) {
                                            toast.error('Choose a creator first');
                                            return;
                                          }
                                          setVaultRowKey(row.key);
                                        }}
                                        className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-zinc-800"
                                      >
                                        {row.vaultLabel || 'Choose vault item'}
                                      </button>
                                      {row.vaultThumb && (
                                        <img
                                          src={row.vaultThumb}
                                          alt=""
                                          className="w-16 h-16 rounded-lg object-cover"
                                        />
                                      )}
                                    </>
                                  )}
                                </>
                              ) : row.kind === 'mass_message' ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!row.creatorId) {
                                        toast.error('Choose a creator first');
                                        return;
                                      }
                                      updateRow(row.key, { imageSource: 'vault' });
                                      setVaultRowKey(row.key);
                                    }}
                                    className={`px-2 py-1 rounded-lg ${
                                      row.vaultLabel
                                        ? 'bg-domx-600 text-white'
                                        : 'bg-gray-100 dark:bg-zinc-800'
                                    }`}
                                  >
                                    {row.vaultLabel || 'Optional vault item'}
                                  </button>
                                  {row.vaultThumb && (
                                    <img
                                      src={row.vaultThumb}
                                      alt=""
                                      className="w-16 h-16 rounded-lg object-cover"
                                    />
                                  )}
                                  {row.vaultLabel && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        updateRow(row.key, {
                                          payload: {},
                                          vaultLabel: '',
                                          vaultThumb: null,
                                        });
                                      }}
                                      className="block text-[11px] text-gray-400 hover:text-gray-600"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </>
                              ) : (
                                <p className="text-gray-400">Text only</p>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            </>
            )}

            {activeTab === 'history' && (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                <div className="flex gap-1 p-1 rounded-lg bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 w-fit">
                  {([
                    ['all', 'All'],
                    ['maloum', 'Maloum'],
                    ['4based', '4based'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPlatformFilter(id)}
                      className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                        platformFilter === id
                          ? 'bg-domx-600 text-white shadow-sm'
                          : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-1 p-1 rounded-lg bg-gray-100 dark:bg-zinc-900 border border-gray-200 dark:border-zinc-800 w-fit">
                  {([
                    ['all', 'All types'],
                    ['feed_post', 'Feed'],
                    ['mass_message', 'Mass'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setKindFilter(id)}
                      className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                        kindFilter === id
                          ? 'bg-domx-600 text-white shadow-sm'
                          : 'text-gray-500 hover:text-gray-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <section className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-500 tracking-wider">
                  UPCOMING
                </h2>
                {upcoming.length === 0 && (
                  <p className="text-sm text-gray-500 italic rounded-md border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/40 p-4">
                    No pending jobs.
                  </p>
                )}
                {upcoming.map((job) => (
                  <ScheduleJobCard
                    key={job.id}
                    job={job}
                    timeZone={timeZone}
                    onCancel={
                      job.status === 'pending'
                        ? async () => {
                            try {
                              await cancelScheduledContent(job.id);
                              await loadAll();
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : 'Cancel failed'
                              );
                            }
                          }
                        : undefined
                    }
                  />
                ))}
              </section>

              <section className="space-y-3">
                <h2 className="text-xs font-semibold text-gray-500 tracking-wider">
                  RECENT
                </h2>
                {history.length === 0 && (
                  <p className="text-sm text-gray-500 italic rounded-md border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-900/40 p-4">
                    No recent jobs.
                  </p>
                )}
                {history.map((job) => (
                  <ScheduleJobCard key={job.id} job={job} timeZone={timeZone} />
                ))}
              </section>
            </div>
            )}
          </div>

          <div className="min-h-0 overflow-y-auto p-5 space-y-5">
            <ScheduleDateTimePicker
              date={selectedRow?.date || pickerDate}
              time={selectedRow?.time || pickerTime}
              platformFilter={platformFilter}
              kindFilter={kindFilter}
              onDateChange={(date) => {
                setPickerDate(date);
                if (selectedRow) updateRow(selectedRow.key, { date });
              }}
              onTimeChange={(time) => {
                setPickerTime(time);
                if (selectedRow) updateRow(selectedRow.key, { time });
              }}
            />
            <p className="text-[11px] text-gray-500">
              Calendar uses {timeZone}
              {selectedRow
                ? ` · editing row ${selectedRow.key.replace('row-', '')}`
                : ''}
            </p>

            <section className="rounded-lg border border-gray-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/40 p-5 flex flex-col gap-6">
              <div>
                <label className="block text-xs font-semibold text-gray-500 tracking-wider mb-3">
                  PER-CREATOR TARGETING
                </label>
                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                  {creators.map((creator) => {
                    const active = creator.id === selectedCreatorId;
                    return (
                      <button
                        key={creator.id}
                        type="button"
                        onClick={() => setSelectedCreatorId(creator.id)}
                        className={`w-full flex items-center gap-3 p-2 rounded-md text-left transition-colors ${
                          active
                            ? 'bg-gray-100 dark:bg-zinc-800'
                            : 'hover:bg-gray-50 dark:hover:bg-zinc-800/50'
                        }`}
                      >
                        <CreatorAvatar
                          avatarUrl={creator.avatarUrl}
                          displayName={creator.displayName}
                          className="w-8 h-8 rounded-full object-cover border border-gray-200 dark:border-zinc-700"
                          initialsClassName="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white bg-gradient-to-br from-orange-400 to-rose-500"
                        />
                        <span className="font-medium text-gray-800 dark:text-zinc-200 truncate">
                          {creator.displayName}
                        </span>
                        <span className="text-xs text-gray-500 bg-gray-50 dark:bg-zinc-950 px-2 py-0.5 rounded-full">
                          {creator.platform}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedCreator?.platform === '4based' && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold">Audience</p>
                  <div className="flex flex-wrap gap-1.5">
                    {AUDIENCE_FILTERS.map((chip) => {
                      const on = current.audienceFilters.includes(chip.id);
                      return (
                        <button
                          key={chip.id}
                          type="button"
                          onClick={() => {
                            const next = on
                              ? current.audienceFilters.filter((id) => id !== chip.id)
                              : [...current.audienceFilters, chip.id];
                            void saveSettings({ ...current, audienceFilters: next });
                          }}
                          className={`px-2.5 py-1 rounded-full text-xs border ${
                            on
                              ? 'bg-4based-500/15 text-4based-500 border-4based-500/40'
                              : 'border-gray-200 dark:border-zinc-700 text-gray-500'
                          }`}
                        >
                          {chip.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-4 border-t border-gray-200 dark:border-zinc-800">
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-zinc-200">
                    Audience Lists
                  </h3>
                  <div className="grid grid-cols-2 gap-4 text-xs font-semibold text-gray-500">
                    <div>INCLUDE</div>
                    <div>EXCLUDE</div>
                  </div>
                  <div className="flex flex-col gap-2 h-64 overflow-y-auto pr-2">
                    {lists.map((list) => {
                      const id = String(list._id || '');
                      const included = current.includeListIds.includes(id);
                      const excluded = current.excludeListIds.includes(id);
                      const rawName = String(list.name || id);
                      const name =
                        selectedCreator?.platform === 'maloum' ||
                        isManagedListCode(rawName)
                          ? friendlyListName(list as MaloumChatListItem, managedRanks)
                          : rawName;
                      const count =
                        selectedCreator?.platform === 'maloum' &&
                        typeof (list as MaloumChatListItem).totalMemberCount ===
                          'number'
                          ? (list as MaloumChatListItem).totalMemberCount
                          : null;
                      return (
                        <div key={id} className="grid grid-cols-2 gap-4 items-center">
                          <button
                            type="button"
                            onClick={() => {
                              const includeListIds = included
                                ? current.includeListIds.filter((x) => x !== id)
                                : [...current.includeListIds, id];
                              void saveSettings({
                                ...current,
                                includeListIds,
                                excludeListIds: current.excludeListIds.filter(
                                  (x) => x !== id
                                ),
                              });
                            }}
                            className={`flex items-center justify-between p-2 rounded text-left transition-all text-sm border ${
                              included
                                ? 'bg-domx-600/15 border-domx-500/50 text-domx-600 dark:text-domx-300'
                                : 'bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 text-gray-500 hover:border-gray-400'
                            }`}
                          >
                            <span className="truncate mr-2">{name}</span>
                            {count != null && (
                              <span className="text-xs opacity-70 bg-black/10 dark:bg-black/30 px-1.5 rounded">
                                {count}
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const excludeListIds = excluded
                                ? current.excludeListIds.filter((x) => x !== id)
                                : [...current.excludeListIds, id];
                              void saveSettings({
                                ...current,
                                excludeListIds,
                                includeListIds: current.includeListIds.filter(
                                  (x) => x !== id
                                ),
                              });
                            }}
                            className={`flex items-center justify-between p-2 rounded text-left transition-all text-sm border ${
                              excluded
                                ? 'bg-red-500/10 border-red-500/50 text-red-500'
                                : 'bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-zinc-800 text-gray-500 hover:border-gray-400'
                            }`}
                          >
                            <span className="truncate mr-2">{name}</span>
                            {count != null && (
                              <span className="text-xs opacity-70 bg-black/10 dark:bg-black/30 px-1.5 rounded">
                                {count}
                              </span>
                            )}
                          </button>
                        </div>
                      );
                    })}
                    {lists.length === 0 && (
                      <p className="text-xs text-gray-500 italic col-span-2">
                        No lists loaded.
                      </p>
                    )}
                  </div>
                </div>

                {selectedCreator?.platform === 'maloum' && (
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-gray-800 dark:text-zinc-200">
                      Feed categories{' '}
                      <span className="text-gray-500 font-normal">
                        ({current.categoryIds.length}/3)
                      </span>
                    </h3>
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 w-4 h-4 text-gray-400" />
                      <input
                        type="text"
                        placeholder="Search categories..."
                        value={categorySearch}
                        onChange={(e) => setCategorySearch(e.target.value)}
                        className="w-full rounded-md border border-gray-200 dark:border-zinc-800 bg-gray-50 dark:bg-zinc-950 py-2 pl-9 pr-3 text-sm text-gray-800 dark:text-zinc-200 focus:outline-none focus:border-domx-500"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2 h-52 overflow-y-auto content-start">
                      {filteredCategories.length > 0 ? (
                        filteredCategories.map((cat) => {
                          const id = String(cat._id || '');
                          const on = current.categoryIds.includes(id);
                          const atCap = !on && current.categoryIds.length >= 3;
                          return (
                            <button
                              key={id}
                              type="button"
                              disabled={atCap}
                              onClick={() => {
                                let categoryIds = on
                                  ? current.categoryIds.filter((x) => x !== id)
                                  : [...current.categoryIds, id];
                                if (categoryIds.length > 3) {
                                  categoryIds = categoryIds.slice(0, 3);
                                }
                                void saveSettings({ ...current, categoryIds });
                              }}
                              className={`px-3 py-1.5 rounded-full text-sm border transition-all ${
                                on
                                  ? 'bg-domx-600 border-domx-500 text-white'
                                  : 'bg-gray-50 dark:bg-zinc-950 border-gray-200 dark:border-zinc-700 text-gray-500 hover:border-gray-400 disabled:opacity-50 disabled:cursor-not-allowed'
                              }`}
                            >
                              {friendlyCategoryName(cat.name || id)}
                              {on && (
                                <Check className="w-3 h-3 inline-block ml-1.5" />
                              )}
                            </button>
                          );
                        })
                      ) : (
                        <p className="text-sm text-gray-500 w-full text-center py-4 italic">
                          No categories found.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {savingSettings && (
                <p className="text-[11px] text-gray-500">Saving…</p>
              )}
            </section>
          </div>
        </div>
      </main>
      {vaultRow?.creatorId && vaultRow.platform && (
        <ScheduleVaultPicker
          open={Boolean(vaultRowKey)}
          creatorId={vaultRow.creatorId}
          platform={vaultRow.platform}
          onClose={() => setVaultRowKey(null)}
          onSelect={(pick: ScheduleVaultPick) => {
            updateRow(vaultRow.key, {
              imageSource: 'vault',
              assetId: null,
              payload: vaultPayloadForKind(
                vaultRow.kind,
                vaultRow.platform,
                pick.payload
              ),
              vaultLabel: pick.label,
              vaultThumb: pick.thumbUrl,
            });
            setVaultRowKey(null);
          }}
        />
      )}
    </div>
  );
}
