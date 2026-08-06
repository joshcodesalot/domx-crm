import { getApiUrl } from '@/lib/apiConfig';

export interface User {
  id: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  status: string;
  permissions: string[];
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  ipAddressLast: string | null;
  creatorCount?: number;
}

export interface Role {
  id: string;
  slug: string;
  name: string;
  rank: number;
  permissions?: string[];
}

export interface Permission {
  id: string;
  slug: string;
  name: string;
  category: string;
  description: string | null;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export interface MeResponse {
  user: User;
}

export interface SetupStatusResponse {
  needsOwnerSetup: boolean;
}

export interface StaffResponse {
  staff: User[];
}

export interface RolesResponse {
  roles: Role[];
}

export interface PermissionsResponse {
  permissions: Permission[];
}

export interface CreateStaffInput {
  name: string;
  email: string;
  role: string;
}

export interface StaffCredentialsResponse {
  user: User;
  tempPassword: string;
}

export interface UpdateStaffInput {
  name?: string;
  status?: string;
}

export interface Creator {
  id: string;
  displayName: string;
  username: string | null;
  platform: 'maloum' | '4based';
  connectionStatus: 'connected' | 'error' | 'pending';
  postLoginUrl: string | null;
  avatarUrl: string | null;
  avatarSource: 'maloum' | 'manual' | null;
  staffCount: number;
  accountId: string | null;
  partitionId: string | null;
  loginEmail: string | null;
  hasSavedCredentials?: boolean;
  lastValidatedAt: string | null;
  authRefreshState?: 'active' | 'needs_reauth' | 'disabled';
  accessTokenExpiresAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorStaffMember {
  id: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  assignedAt: string;
}

export interface CreatorStaffResponse {
  staff: CreatorStaffMember[];
}

export interface CreatorsResponse {
  creators: Creator[];
}

export interface CreateCreatorInput {
  displayName: string;
  username?: string;
  platform: 'maloum' | '4based';
  postLoginUrl?: string;
  connectionStatus?: 'connected' | 'error' | 'pending';
  accountId?: string;
}

export interface ConnectCreatorInput {
  accountId: string;
  platform: 'maloum' | '4based';
  email: string;
  cookies: ConnectCreatorResponse['cookies'];
  origins?: ConnectCreatorResponse['origins'];
  displayName: string;
  username?: string | null;
  postLoginUrl: string;
  avatarUrl?: string | null;
  password?: string;
}

export interface ConnectCreatorResponse {
  accountToken: string;
  accountId: string;
  partitionId: string;
  displayName: string;
  username: string | null;
  postLoginUrl: string;
  avatarUrl: string | null;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: string;
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface ReconnectCreatorSessionInput {
  email: string;
  cookies: ConnectCreatorResponse['cookies'];
  origins?: ConnectCreatorResponse['origins'];
  displayName: string;
  username?: string | null;
  postLoginUrl: string;
  avatarUrl?: string | null;
  password?: string;
  savePassword?: boolean;
}

export interface CreatorCredentialsResponse {
  loginEmail: string | null;
  loginPassword: string;
}

export interface DeleteCreatorResponse {
  message: string;
  accountId: string | null;
  partitionId: string | null;
}

export interface CreatorSessionResponse {
  accountId: string;
  partitionId: string;
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
  /** Cloudflare-bypass User-Agent that earned cf_clearance (Electron must reuse). */
  userAgent?: string | null;
  /** Creator residential proxy — required with cf_clearance (same exit IP). */
  proxyUrl?: string | null;
  sessionUpdatedAt: string | null;
}

export interface MaloumSentMessageRecord {
  id: string;
  creatorId: string;
  chatId: string;
  maloumMessageId: string | null;
  optimisticMessageId: string | null;
  contentText: string;
  sentByUserId: string;
  sentByUserName: string;
  sentAt: string;
  status: 'pending' | 'confirmed' | 'failed';
  domMarked?: boolean;
}

export interface MaloumSentMessagesResponse {
  records: MaloumSentMessageRecord[];
}

export interface UpsertMaloumSentMessageResponse {
  record: MaloumSentMessageRecord;
}

export interface MessagingDashboardEntry {
  id: string;
  creatorId: string;
  creatorName: string;
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  platform: 'maloum' | '4based' | null;
  chatterId: string;
  chatterName: string;
  chatterEmail: string | null;
  chatId: string;
  fanId: string | null;
  fanUsername: string | null;
  maloumMessageId: string;
  optimisticMessageId: string | null;
  contentType: string;
  englishMessage: string | null;
  germanTranslatedMessage: string | null;
  actualSentText: string | null;
  priceNet: number | null;
  currency: string;
  purchased: boolean;
  chatterSalesTotal: number;
  mediaCount: number;
  pictureCount: number;
  videoCount: number;
  mediaJson: Array<{
    mediaId?: string;
    type?: string;
    width?: number;
    height?: number;
  }> | null;
  previousFanMessageAt: string | null;
  responseTimeSeconds: number | null;
  sentAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingDashboardPagination {
  page: number;
  limit: number;
  total: number;
  from: number;
  to: number;
}

export interface MessagingDashboardResponse {
  data: MessagingDashboardEntry[];
  pagination: MessagingDashboardPagination;
  lastUpdated: string;
}

export interface CreateMessagingDashboardEntryInput {
  id: string;
  creatorId: string;
  creatorName?: string;
  creatorUsername?: string | null;
  creatorAvatarUrl?: string | null;
  chatterId: string;
  chatterName: string;
  chatterEmail?: string | null;
  chatId: string;
  fanId?: string | null;
  fanUsername?: string | null;
  maloumMessageId: string;
  optimisticMessageId?: string | null;
  contentType: string;
  englishMessage?: string | null;
  germanTranslatedMessage?: string | null;
  actualSentText?: string | null;
  priceNet?: number | null;
  currency?: string;
  purchased?: boolean;
  mediaCount?: number;
  pictureCount?: number;
  videoCount?: number;
  mediaJson?: Array<{
    mediaId?: string;
    type?: string;
    width?: number;
    height?: number;
  }> | null;
  previousFanMessageAt?: string | null;
  responseTimeSeconds?: number | null;
  sentAt: string;
}

export interface CreateMessagingDashboardEntryResponse {
  entry: MessagingDashboardEntry;
}

const API_URL = getApiUrl();

export function resolveCreatorAvatarUrl(
  avatarUrl: string | null | undefined
): string | null {
  if (!avatarUrl) return null;
  if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
    return avatarUrl;
  }
  if (avatarUrl.startsWith('/')) {
    return `${API_URL}${avatarUrl}`;
  }
  return avatarUrl;
}

export function isBackendStoredAvatarUrl(
  avatarUrl: string | null | undefined
): boolean {
  return Boolean(avatarUrl?.startsWith('/uploads/avatars/'));
}

export function shouldFetchMaloumIcon(options: {
  profileImageUrl: string | null;
  overwriteIcon?: boolean;
  currentAvatarUrl?: string | null;
  avatarSource?: Creator['avatarSource'];
}): boolean {
  const {
    profileImageUrl,
    overwriteIcon = false,
    currentAvatarUrl = null,
    avatarSource = null,
  } = options;

  if (!profileImageUrl) {
    return false;
  }

  if (overwriteIcon) {
    return true;
  }

  if (avatarSource === 'manual') {
    return false;
  }

  return !currentAvatarUrl || !isBackendStoredAvatarUrl(currentAvatarUrl);
}

export function getToken(): string | null {
  return localStorage.getItem('domx_token');
}

export function setToken(token: string): void {
  localStorage.setItem('domx_token', token);
}

export function clearToken(): void {
  localStorage.removeItem('domx_token');
}

/** DomX JWT auth failures only — not Maloum/4based "Unauthorized". */
function isDomxAuthFailure(status: number, error: unknown): boolean {
  if (status !== 401) return false;
  const message = typeof error === 'string' ? error : '';
  return (
    message === 'Authentication required' ||
    message === 'Invalid or expired token'
  );
}

export class ApiError extends Error {
  status: number;
  code?: string;
  matchedKeyword?: string;
  matchedStage?: string;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      matchedKeyword?: string;
      matchedStage?: string;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code;
    this.matchedKeyword = options.matchedKeyword;
    this.matchedStage = options.matchedStage;
  }
}

export function isContentBlockedError(
  err: unknown
): err is ApiError & { code: 'CONTENT_BLOCKED' } {
  return err instanceof ApiError && err.code === 'CONTENT_BLOCKED';
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (isDomxAuthFailure(response.status, (data as { error?: string }).error) && token) {
    clearToken();
    window.dispatchEvent(new CustomEvent('domx:session-expired'));
  }

  if (!response.ok) {
    const payload = data as {
      error?: string;
      code?: string;
      matchedKeyword?: string;
      matchedStage?: string;
    };
    throw new ApiError(payload.error || 'Request failed', {
      status: response.status,
      code: payload.code,
      matchedKeyword: payload.matchedKeyword,
      matchedStage: payload.matchedStage,
    });
  }

  return data as T;
}

export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return request<SetupStatusResponse>('/api/auth/setup-status');
}

export async function registerOwner(
  name: string,
  email: string,
  password: string
): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/register-owner', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
}

export async function getHealth(): Promise<{ status: string; database: string }> {
  return request<{ status: string; database: string }>('/api/health');
}

export async function getMe(): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me');
}

export async function logout(): Promise<void> {
  try {
    await request('/api/auth/logout', { method: 'POST' });
  } catch {
    // Client-side logout still proceeds if server call fails
  }
}

export async function getStaff(): Promise<StaffResponse> {
  return request<StaffResponse>('/api/staff');
}

export async function getAssignableRoles(): Promise<RolesResponse> {
  return request<RolesResponse>('/api/staff/roles');
}

export async function createStaff(input: CreateStaffInput): Promise<StaffCredentialsResponse> {
  return request<StaffCredentialsResponse>('/api/staff', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateStaff(
  id: string,
  input: UpdateStaffInput
): Promise<{ user: User }> {
  return request<{ user: User }>(`/api/staff/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function assignStaffRole(
  id: string,
  role: string
): Promise<{ user: User }> {
  return request<{ user: User }>(`/api/staff/${id}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function deactivateStaff(id: string): Promise<{ user: User }> {
  return request<{ user: User }>(`/api/staff/${id}/deactivate`, {
    method: 'PATCH',
  });
}

export async function activateStaff(id: string): Promise<{ user: User }> {
  return request<{ user: User }>(`/api/staff/${id}/activate`, {
    method: 'PATCH',
  });
}

export async function deleteStaff(id: string): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/staff/${id}`, {
    method: 'DELETE',
  });
}

export async function resetStaffPassword(id: string): Promise<StaffCredentialsResponse> {
  return request<StaffCredentialsResponse>(`/api/staff/${id}/reset-password`, {
    method: 'POST',
  });
}

export interface StaffScheduleDay {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  overnight?: boolean;
}

export interface StaffScheduleResponse {
  userId: string;
  timeZone: string;
  days: StaffScheduleDay[];
}

export async function getStaffSchedule(id: string): Promise<StaffScheduleResponse> {
  return request<StaffScheduleResponse>(`/api/staff/${id}/schedule`);
}

export async function updateStaffSchedule(
  id: string,
  days: Array<{ dayOfWeek: number; startTime: string; endTime: string }>
): Promise<StaffScheduleResponse> {
  return request<StaffScheduleResponse>(`/api/staff/${id}/schedule`, {
    method: 'PUT',
    body: JSON.stringify({ days }),
  });
}

export interface StaffAssignedCreator {
  id: string;
  displayName: string;
  username: string | null;
  platform: 'maloum' | '4based';
  connectionStatus: 'connected' | 'error' | 'pending';
  avatarUrl: string | null;
  avatarSource: 'maloum' | 'manual' | null;
  assignedAt: string;
}

export async function getStaffCreators(
  staffId: string
): Promise<{ creators: StaffAssignedCreator[] }> {
  return request<{ creators: StaffAssignedCreator[] }>(
    `/api/staff/${staffId}/creators`
  );
}

export async function setStaffCreators(
  staffId: string,
  creatorIds: string[]
): Promise<{ creators: StaffAssignedCreator[] }> {
  return request<{ creators: StaffAssignedCreator[] }>(
    `/api/staff/${staffId}/creators`,
    {
      method: 'PUT',
      body: JSON.stringify({ creatorIds }),
    }
  );
}

export async function changePassword(
  newPassword: string,
  confirmPassword: string
): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword, confirmPassword }),
  });
}

export async function getRoles(): Promise<RolesResponse> {
  return request<RolesResponse>('/api/roles');
}

export async function getPermissions(): Promise<PermissionsResponse> {
  return request<PermissionsResponse>('/api/roles/permissions');
}

export async function updateRolePermissions(
  slug: string,
  permissionSlugs: string[]
): Promise<{ slug: string; permissions: string[] }> {
  return request<{ slug: string; permissions: string[] }>(
    `/api/roles/${slug}/permissions`,
    {
      method: 'PUT',
      body: JSON.stringify({ permissionSlugs }),
    }
  );
}

export async function getCreators(): Promise<CreatorsResponse> {
  return request<CreatorsResponse>('/api/creators');
}

export async function getCreatorStaff(
  creatorId: string
): Promise<CreatorStaffResponse> {
  return request<CreatorStaffResponse>(`/api/creators/${creatorId}/staff`);
}

export async function assignCreatorStaff(
  creatorId: string,
  userId: string
): Promise<{ message: string }> {
  return request<{ message: string }>(`/api/creators/${creatorId}/staff`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export async function unassignCreatorStaff(
  creatorId: string,
  userId: string
): Promise<{ message: string }> {
  return request<{ message: string }>(
    `/api/creators/${creatorId}/staff/${userId}`,
    { method: 'DELETE' }
  );
}

export async function connectCreatorAccount(
  input: ConnectCreatorInput
): Promise<ConnectCreatorResponse> {
  return request<ConnectCreatorResponse>('/api/creators/connect', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function reconnectCreatorSession(
  creatorId: string,
  input: ReconnectCreatorSessionInput
): Promise<{
  creator: Creator;
  accountId: string;
  partitionId: string;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
  sessionUpdatedAt: string | null;
}> {
  return request(`/api/creators/${creatorId}/session`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function discardCreatorConnect(
  accountId: string
): Promise<{ message: string; partitionId: string; accountId: string }> {
  return request(`/api/creators/connect/${accountId}`, {
    method: 'DELETE',
  });
}

export async function createCreator(
  input: CreateCreatorInput
): Promise<{ creator: Creator }> {
  return request<{ creator: Creator }>('/api/creators', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteCreator(id: string): Promise<DeleteCreatorResponse> {
  return request<DeleteCreatorResponse>(`/api/creators/${id}`, {
    method: 'DELETE',
  });
}

export async function renameCreator(
  creatorId: string,
  displayName: string
): Promise<{ creator: Creator }> {
  return request<{ creator: Creator }>(`/api/creators/${creatorId}`, {
    method: 'PATCH',
    body: JSON.stringify({ displayName }),
  });
}

export async function getCreatorSession(
  creatorId: string
): Promise<CreatorSessionResponse> {
  return request<CreatorSessionResponse>(`/api/creators/${creatorId}/session`);
}

export async function refreshCreatorSession(
  creatorId: string,
  input: {
    cookies: ConnectCreatorResponse['cookies'];
    origins?: ConnectCreatorResponse['origins'];
  }
): Promise<{
  creator: Creator;
  accountId: string;
  sessionUpdatedAt: string | null;
}> {
  return request(`/api/creators/${creatorId}/session/refresh`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function getCreatorCredentials(
  creatorId: string
): Promise<CreatorCredentialsResponse> {
  return request<CreatorCredentialsResponse>(`/api/creators/${creatorId}/credentials`);
}

export async function updateCreatorSessionValidation(
  creatorId: string,
  valid: boolean
): Promise<{ creator: Creator }> {
  return request<{ creator: Creator }>(`/api/creators/${creatorId}/session-validation`, {
    method: 'PATCH',
    body: JSON.stringify({ valid }),
  });
}

export async function refreshMaloumAvatar(
  creatorId: string
): Promise<{ creator: Creator; skipped?: boolean; reason?: string }> {
  return request<{ creator: Creator; skipped?: boolean; reason?: string }>(
    `/api/creators/${creatorId}/maloum/refresh-avatar`,
    { method: 'POST' }
  );
}

/** Validate Maloum Bearer session via CF bypass; updates lastValidatedAt. */
export async function verifyMaloumSession(
  creatorId: string
): Promise<{ ok: boolean; creator: Creator }> {
  return request<{ ok: boolean; creator: Creator }>(
    `/api/creators/${creatorId}/maloum/verify-session`,
    { method: 'POST' }
  );
}

export async function upsertMaloumSentMessage(
  record: MaloumSentMessageRecord
): Promise<UpsertMaloumSentMessageResponse> {
  return request<UpsertMaloumSentMessageResponse>('/api/maloum-sent-messages', {
    method: 'POST',
    body: JSON.stringify(record),
  });
}

export async function getMaloumSentMessages(filters: {
  creatorId?: string;
  chatId?: string;
  limit?: number;
} = {}): Promise<MaloumSentMessagesResponse> {
  const params = new URLSearchParams();

  if (filters.creatorId) {
    params.set('creatorId', filters.creatorId);
  }

  if (filters.chatId) {
    params.set('chatId', filters.chatId);
  }

  if (filters.limit) {
    params.set('limit', String(filters.limit));
  }

  const query = params.toString();
  const path = query ? `/api/maloum-sent-messages?${query}` : '/api/maloum-sent-messages';

  return request<MaloumSentMessagesResponse>(path);
}

export interface CurrencyAmount {
  currency: 'EUR' | 'USD';
  amount: number;
}

export interface OverviewChatterStats {
  chatterId: string;
  chatterName: string;
  avgResponseTimeSeconds: number | null;
  dailySales: CurrencyAmount[];
  totalSales: CurrencyAmount[];
  monthlyRevenue?: CurrencyAmount[];
  messagesSent?: number;
  ppvsSent?: number;
  ppvsUnlocked?: number;
  goldenRatio?: number;
  ppvConversionRate?: number;
  activeSecondsTotal?: number;
  idleSecondsTotal?: number;
  idlePercent?: number;
  revenuePerHour?: CurrencyAmount[];
  messagesPerHour?: number;
  tipSales?: CurrencyAmount[];
  ppvSales?: CurrencyAmount[];
  periodSales?: CurrencyAmount[];
  salesPerMessage?: CurrencyAmount[];
  uniqueFansMessaged?: number;
  fansWhoUnlocked?: number;
  pendingPpvs?: number;
  p50ResponseSeconds?: number | null;
  p90ResponseSeconds?: number | null;
  avgPpvPrice?: number | null;
  medianPpvPrice?: number | null;
  scheduleApplied?: boolean;
  shiftLabel?: string | null;
}

export interface OverviewPriceBand {
  band: string;
  label: string;
  sent: number;
  unlocked: number;
  unlockRate: number;
}

export interface OverviewHourOfDay {
  hour: number;
  messagesSent: number;
  salesCount: number;
  salesAmount: number;
}

export interface OverviewCreatorStats {
  creatorId: string;
  creatorName: string;
  creatorUsername?: string | null;
  creatorAvatarUrl?: string | null;
  platform?: 'maloum' | '4based' | null;
  messagesSent: number;
  ppvsSent: number;
  ppvsUnlocked: number;
  pendingPpvs?: number;
  uniqueFansMessaged?: number;
  fansWhoUnlocked?: number;
  goldenRatio?: number;
  ppvConversionRate?: number;
  totalSales: CurrencyAmount[];
  tipSales?: CurrencyAmount[];
  ppvSales?: CurrencyAmount[];
  revenuePerFan?: CurrencyAmount[];
  salesPerMessage?: CurrencyAmount[];
  avgPpvPrice?: number | null;
  medianPpvPrice?: number | null;
}

export interface OverviewDailySalesDay {
  date: string;
  amounts: CurrencyAmount[];
}

export interface OverviewAnalyticsResponse {
  scope?: 'team' | 'self';
  chartDays?: number;
  period?: { startDate: string; endDate: string };
  dailySales: CurrencyAmount[];
  totalSales: CurrencyAmount[];
  totalRevenue?: CurrencyAmount[];
  monthlyRevenue?: CurrencyAmount[];
  tipSales?: CurrencyAmount[];
  ppvSales?: CurrencyAmount[];
  totalMessagesSent?: number;
  ppvsSent?: number;
  ppvsUnlocked?: number;
  pendingPpvs?: number;
  freeMediaSent?: number;
  photoPpvs?: number;
  videoPpvs?: number;
  uniqueFansMessaged?: number;
  fansWhoUnlocked?: number;
  goldenRatio?: number;
  ppvConversionRate?: number;
  avgPpvPrice?: number | null;
  medianPpvPrice?: number | null;
  revenuePerFan?: CurrencyAmount[];
  salesPerMessage?: CurrencyAmount[];
  p50ResponseSeconds?: number | null;
  p90ResponseSeconds?: number | null;
  keystrokesTotal?: number;
  activeSecondsTotal?: number;
  idleSecondsTotal?: number;
  idlePercent?: number;
  revenuePerHour?: CurrencyAmount[];
  messagesPerHour?: number;
  unlockRateByPriceBand?: OverviewPriceBand[];
  hourOfDay?: OverviewHourOfDay[];
  salesByPlatform?: { platform: string; amounts: CurrencyAmount[] }[];
  creators?: OverviewCreatorStats[];
  activityMetricsCutover?: string;
  avgResponseTimeSeconds: number | null;
  dailySalesByDay: OverviewDailySalesDay[];
  chatters: OverviewChatterStats[];
  responseWindow: { startDate: string; endDate: string };
  lastUpdated: string;
}

export type PresenceStatus = 'online' | 'idle' | 'away';

export interface PresenceChatter {
  userId: string;
  userName: string;
  role?: string;
  status: PresenceStatus;
  lastInputAt: string | null;
  lastHeartbeatAt: string | null;
  activeSecondsToday: number;
  idleSecondsToday?: number;
  keystrokesToday?: number;
}

export interface ActivityPresenceResponse {
  scope?: 'team' | 'self';
  chatters: PresenceChatter[];
  onlineCount: number;
  idleCount: number;
  awayCount: number;
  lastUpdated: string;
}

export interface ActivityHeartbeatResponse {
  ok: boolean;
  status: PresenceStatus;
  lastInputAt: string | null;
  lastHeartbeatAt: string;
  activeSecondsToday: number;
  idleSecondsToday?: number;
  keystrokesToday?: number;
}

export async function getOverviewAnalytics(filters: {
  startDate?: string;
  endDate?: string;
  days?: number;
} = {}): Promise<OverviewAnalyticsResponse> {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.days != null) params.set('days', String(filters.days));
  const query = params.toString();
  const path = query
    ? `/api/messaging-dashboard/overview?${query}`
    : '/api/messaging-dashboard/overview';
  return request<OverviewAnalyticsResponse>(path);
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  userName: string;
  maskedValue: string;
}

export interface LeaderboardViewerRank {
  rank: number;
  maskedValue: string;
}

export interface LeaderboardResponse {
  topResponseTime: LeaderboardEntry[];
  topSales: LeaderboardEntry[];
  topPpvsUnlocked: LeaderboardEntry[];
  topGoldenRatio: LeaderboardEntry[];
  viewerRank: {
    responseTime: LeaderboardViewerRank | null;
    sales: LeaderboardViewerRank | null;
    ppvsUnlocked: LeaderboardViewerRank | null;
    goldenRatio: LeaderboardViewerRank | null;
  };
  period?: {
    startDate: string;
    endDate: string;
    timeZone: string;
    usesScheduledHours?: boolean;
  };
  responseWindow?: { startDate: string; endDate: string };
  lastUpdated: string;
}

export async function getLeaderboard(): Promise<LeaderboardResponse> {
  return request<LeaderboardResponse>('/api/messaging-dashboard/leaderboard');
}

export async function postActivityHeartbeat(body: {
  lastInputAt: string | null;
  keystrokeDelta?: number;
}): Promise<ActivityHeartbeatResponse> {
  return request<ActivityHeartbeatResponse>('/api/activity/heartbeat', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getActivityPresence(): Promise<ActivityPresenceResponse> {
  return request<ActivityPresenceResponse>('/api/activity/presence');
}

export interface ActivityHistoryDay {
  date: string;
  activeSeconds: number;
  idleSeconds?: number;
  keystrokes?: number;
}

export interface ActivityHistoryChatter {
  userId: string;
  userName: string;
  days: ActivityHistoryDay[];
  activeSecondsPeriod: number;
  idleSecondsPeriod?: number;
  keystrokesPeriod?: number;
}

export interface ActivityHistoryResponse {
  days: number;
  startDate: string;
  endDate: string;
  scope?: 'team' | 'self';
  teamByDay: ActivityHistoryDay[];
  chatters: ActivityHistoryChatter[];
  lastUpdated: string;
}

export async function getActivityHistory(
  daysOrOptions: number | { days?: number; startDate?: string; endDate?: string } = 14
): Promise<ActivityHistoryResponse> {
  const params = new URLSearchParams();
  if (typeof daysOrOptions === 'number') {
    params.set('days', String(daysOrOptions));
  } else {
    if (daysOrOptions.startDate) params.set('startDate', daysOrOptions.startDate);
    if (daysOrOptions.endDate) params.set('endDate', daysOrOptions.endDate);
    if (daysOrOptions.days != null && !daysOrOptions.startDate) {
      params.set('days', String(daysOrOptions.days));
    }
  }
  return request<ActivityHistoryResponse>(`/api/activity/history?${params.toString()}`);
}

export interface AnalyticsSeriesDay {
  date: string;
  messagesSent: number;
  ppvsSent: number;
  ppvsUnlocked: number;
  pendingPpvs?: number;
  freeMediaSent?: number;
  uniqueFansMessaged?: number;
  goldenRatio: number;
  ppvConversionRate: number;
  revenue: CurrencyAmount[];
  tipRevenue?: CurrencyAmount[];
  ppvRevenue?: CurrencyAmount[];
  salesPerMessage?: CurrencyAmount[];
  salesPerMessageValue?: number;
  activeSeconds: number;
  idleSeconds: number;
  idlePercent?: number;
  keystrokes: number;
}

export interface AnalyticsSeriesStaff {
  chatterId: string;
  chatterName: string;
  series: AnalyticsSeriesDay[];
}

export interface AnalyticsSeriesResponse {
  scope: 'team' | 'self';
  days: number;
  startDate: string;
  endDate: string;
  series: AnalyticsSeriesDay[];
  byStaff?: AnalyticsSeriesStaff[];
  lastUpdated: string;
}

export async function getAnalyticsSeries(
  daysOrOptions: number | { days?: number; startDate?: string; endDate?: string } = 7
): Promise<AnalyticsSeriesResponse> {
  const params = new URLSearchParams();
  if (typeof daysOrOptions === 'number') {
    params.set('days', String(daysOrOptions));
  } else {
    if (daysOrOptions.startDate) params.set('startDate', daysOrOptions.startDate);
    if (daysOrOptions.endDate) params.set('endDate', daysOrOptions.endDate);
    if (daysOrOptions.days != null && !daysOrOptions.startDate) {
      params.set('days', String(daysOrOptions.days));
    }
  }
  return request<AnalyticsSeriesResponse>(
    `/api/messaging-dashboard/series?${params.toString()}`
  );
}

export interface CreatorSalesByChatter {
  chatterId: string;
  chatterName: string;
  amounts: CurrencyAmount[];
}

export interface CreatorOverviewSummary {
  messagesSent: number;
  ppvsSent: number;
  ppvsUnlocked: number;
  pendingPpvs: number;
  freeMediaSent: number;
  photoPpvs: number;
  videoPpvs: number;
  uniqueFansMessaged: number;
  fansWhoUnlocked: number;
  goldenRatio: number;
  ppvConversionRate: number;
  avgPpvPrice: number | null;
  medianPpvPrice: number | null;
  p50ResponseSeconds: number | null;
  p90ResponseSeconds: number | null;
  totalSales: CurrencyAmount[];
  tipSales: CurrencyAmount[];
  ppvSales: CurrencyAmount[];
  revenuePerFan: CurrencyAmount[];
  salesPerMessage: CurrencyAmount[];
  unlockRateByPriceBand: OverviewPriceBand[];
  hourOfDay: OverviewHourOfDay[];
  dailySalesByDay: OverviewDailySalesDay[];
  topFans: { fanId: string; fanUsername: string | null; amounts: CurrencyAmount[] }[];
  salesByChatter: CreatorSalesByChatter[];
  salesByPlatform: { platform: string; amounts: CurrencyAmount[] }[];
}

export interface CreatorOverviewCreator extends OverviewCreatorStats {
  salesByChatter?: CreatorSalesByChatter[];
  salesByPlatform?: { platform: string; amounts: CurrencyAmount[] }[];
}

export interface CreatorOverviewResponse {
  scope: 'team' | 'self';
  period: { startDate: string; endDate: string };
  chartDays: number;
  creatorId: string | null;
  summary: CreatorOverviewSummary;
  creators: CreatorOverviewCreator[];
  selected: CreatorOverviewCreator | null;
  lastUpdated: string;
}

export async function getCreatorOverview(filters: {
  startDate?: string;
  endDate?: string;
  days?: number;
  creatorId?: string;
} = {}): Promise<CreatorOverviewResponse> {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.days != null) params.set('days', String(filters.days));
  if (filters.creatorId) params.set('creatorId', filters.creatorId);
  const query = params.toString();
  return request<CreatorOverviewResponse>(
    query
      ? `/api/messaging-dashboard/creator-overview?${query}`
      : '/api/messaging-dashboard/creator-overview'
  );
}

export interface CreatorSeriesDay {
  date: string;
  messagesSent: number;
  ppvsSent: number;
  ppvsUnlocked: number;
  pendingPpvs: number;
  freeMediaSent: number;
  uniqueFansMessaged: number;
  goldenRatio: number;
  ppvConversionRate: number;
  revenue: CurrencyAmount[];
  tipRevenue: CurrencyAmount[];
  ppvRevenue: CurrencyAmount[];
}

export interface CreatorSeriesResponse {
  scope: 'team' | 'self';
  days: number;
  startDate: string;
  endDate: string;
  creatorId: string | null;
  series: CreatorSeriesDay[];
  lastUpdated: string;
}

export async function getCreatorSeries(filters: {
  startDate?: string;
  endDate?: string;
  days?: number;
  creatorId?: string;
} = {}): Promise<CreatorSeriesResponse> {
  const params = new URLSearchParams();
  if (filters.startDate) params.set('startDate', filters.startDate);
  if (filters.endDate) params.set('endDate', filters.endDate);
  if (filters.days != null && !filters.startDate) {
    params.set('days', String(filters.days));
  }
  if (filters.creatorId) params.set('creatorId', filters.creatorId);
  return request<CreatorSeriesResponse>(
    `/api/messaging-dashboard/creator-series?${params.toString()}`
  );
}

export async function getMessagingDashboard(filters: {
  startDate?: string;
  endDate?: string;
  chatterId?: string;
  creatorId?: string;
  platform?: 'maloum' | '4based';
  purchased?: boolean;
  contentType?: 'chat_product' | 'tip';
  page?: number;
  limit?: number;
} = {}): Promise<MessagingDashboardResponse> {
  const params = new URLSearchParams();

  if (filters.startDate) {
    params.set('startDate', filters.startDate);
  }

  if (filters.endDate) {
    params.set('endDate', filters.endDate);
  }

  if (filters.chatterId) {
    params.set('chatterId', filters.chatterId);
  }

  if (filters.creatorId) {
    params.set('creatorId', filters.creatorId);
  }

  if (filters.platform) {
    params.set('platform', filters.platform);
  }

  if (typeof filters.purchased === 'boolean') {
    params.set('purchased', String(filters.purchased));
  }

  if (filters.contentType) {
    params.set('contentType', filters.contentType);
  }

  if (filters.page) {
    params.set('page', String(filters.page));
  }

  if (filters.limit) {
    params.set('limit', String(filters.limit));
  }

  const query = params.toString();
  const path = query ? `/api/messaging-dashboard?${query}` : '/api/messaging-dashboard';

  return request<MessagingDashboardResponse>(path);
}

export async function createMessagingDashboardEntry(
  entry: CreateMessagingDashboardEntryInput
): Promise<CreateMessagingDashboardEntryResponse> {
  return request<CreateMessagingDashboardEntryResponse>('/api/messaging-dashboard', {
    method: 'POST',
    body: JSON.stringify(entry),
  });
}

export async function getMessagingDashboardSenders(filters: {
  creatorId: string;
  chatId: string;
  limit?: number;
}): Promise<{ senders: Record<string, string> }> {
  const params = new URLSearchParams();
  params.set('creatorId', filters.creatorId);
  params.set('chatId', filters.chatId);
  if (filters.limit != null) {
    params.set('limit', String(filters.limit));
  }
  return request<{ senders: Record<string, string> }>(
    `/api/messaging-dashboard/senders?${params.toString()}`
  );
}

export interface MaloumFanPpvEntry {
  id: string;
  maloumMessageId: string | null;
  priceNet: number | null;
  currency: string;
  purchased: boolean;
  mediaCount: number;
  pictureCount: number;
  videoCount: number;
  mediaJson: unknown;
  sentAt: string;
}

export interface MaloumFanTipEntry {
  id: string;
  maloumMessageId: string | null;
  priceNet: number | null;
  currency: string;
  sentAt: string;
  fanId: string | null;
  fanUsername: string | null;
}

export interface MaloumFanStats {
  ppv: {
    sent: number;
    unlocked: number;
    ratePercent: number;
    highestPrice: number | null;
    lowestPrice: number | null;
  };
  ppvEntries: MaloumFanPpvEntry[];
  tips: MaloumFanTipEntry[];
}

export async function getMaloumFanStats(filters: {
  creatorId: string;
  chatId?: string;
  fanId?: string;
}): Promise<MaloumFanStats> {
  const params = new URLSearchParams();
  params.set('creatorId', filters.creatorId);
  if (filters.chatId) params.set('chatId', filters.chatId);
  if (filters.fanId) params.set('fanId', filters.fanId);
  return request<MaloumFanStats>(
    `/api/messaging-dashboard/fan-stats?${params.toString()}`
  );
}

export async function updateMessagingDashboardPurchased(
  maloumMessageId: string,
  purchased: boolean,
  priceNet?: number | null
): Promise<CreateMessagingDashboardEntryResponse> {
  return request<CreateMessagingDashboardEntryResponse>(
    `/api/messaging-dashboard/${encodeURIComponent(maloumMessageId)}/purchased`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        purchased,
        ...(priceNet != null ? { priceNet } : {}),
      }),
    }
  );
}

// --- Maloum API connect ---

export interface ConnectMaloumInput {
  accountId: string;
  email: string;
  password: string;
  /** Optional override; backend uses MALOUM_PROXY_URL when omitted. */
  proxyUrl?: string;
  displayName?: string;
  username?: string;
}

export interface ConnectMaloumResponse {
  accountToken: string;
  accountId: string;
  partitionId: string;
  displayName: string;
  username: string | null;
  postLoginUrl: string;
  avatarUrl: string | null;
  providerUserId: string | null;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
}

export async function connectMaloumAccount(
  input: ConnectMaloumInput
): Promise<ConnectMaloumResponse> {
  return request<ConnectMaloumResponse>('/api/creators/connect', {
    method: 'POST',
    body: JSON.stringify({
      accountId: input.accountId,
      platform: 'maloum',
      email: input.email,
      password: input.password,
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.username ? { username: input.username } : {}),
    }),
  });
}

export async function reconnectMaloumAccount(
  creatorId: string,
  input: { email: string; password: string; proxyUrl?: string }
): Promise<{
  creator: Creator;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
  sessionUpdatedAt: string | null;
}> {
  return request(`/api/creators/${creatorId}/maloum/reconnect`, {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
    }),
  });
}

export async function reconnectMaloumAccountSaved(creatorId: string): Promise<{
  creator: Creator;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
  sessionUpdatedAt: string | null;
}> {
  return request(`/api/creators/${creatorId}/maloum/reconnect-saved`, {
    method: 'POST',
  });
}

// --- 4based ---

export interface ConnectFourBasedInput {
  accountId: string;
  email: string;
  password: string;
  /** Optional override; backend uses FOURBASED_PROXY_URL when omitted. */
  proxyUrl?: string;
  displayName?: string;
  username?: string;
}

export interface ConnectFourBasedResponse {
  accountToken: string;
  accountId: string;
  partitionId: string;
  displayName: string;
  username: string | null;
  postLoginUrl: string;
  avatarUrl: string | null;
  providerUserId: string;
  cookies: ConnectCreatorResponse['cookies'];
  origins: ConnectCreatorResponse['origins'];
}

export interface FourBasedChatUser {
  _id: string;
  name?: string;
  avatar?: {
    preview?: Record<string, string>;
  };
  is_online?: boolean;
  verified?: boolean;
  trusted_user?: boolean;
  creator?: boolean;
  [key: string]: unknown;
}

export interface FourBasedLastMessage {
  _id?: string;
  message?: string;
  user_id?: string;
  created_at?: string;
  file_stack?: FourBasedFileStack | null;
  deleted_user_ids?: string[];
  [key: string]: unknown;
}

export interface FourBasedChat {
  _id: string;
  user_ids?: string[];
  users?: FourBasedChatUser[];
  last_message?: FourBasedLastMessage | null;
  last_real_message_updated_at?: string;
  unread_message_count?: number;
  updated_at?: string;
  sales_volume?: number;
  is_pinned?: boolean;
  [key: string]: unknown;
}

export interface FourBasedFileStack {
  _id: string;
  type?: string;
  fileStackType?: string;
  extension?: string;
  duration?: number;
  price?: number;
  description?: string;
  destination?: string;
  video_thumbnail_source?: string;
  vault_file_stack_id?: string;
  width?: number;
  height?: number;
  preview?: Record<string, string>;
  /** Playback URLs, e.g. .../video/{code}.mp4 (often media-public). */
  source?: string[];
  /** Fan user ids who purchased this PPV stack. */
  user_paid?: string[];
  [key: string]: unknown;
}

export interface FourBasedMessage {
  _id: string;
  chat_id?: string;
  user_id?: string;
  receiver_user_id?: string;
  message?: string;
  local_id?: string;
  sender_status?: string;
  created_at?: string;
  updated_at?: string;
  file_stack_id?: string | null;
  file_stack?: FourBasedFileStack | null;
  tip?: unknown;
  deleted_user_ids?: string[];
  [key: string]: unknown;
}

export interface FourBasedVaultItem {
  _id?: string;
  id?: string;
  guid?: string;
  fileStackType?: string;
  type?: string;
  duration?: number;
  width?: number;
  height?: number;
  price?: number;
  description?: string;
  destination?: string;
  video_thumbnail_source?: string;
  vault_file_stack_id?: string;
  status?: string;
  name?: string;
  tag?: string[] | string;
  belongs_to_folders?: string[];
  preview?: Record<string, string>;
  source?: string[];
  collection?: unknown[];
  [key: string]: unknown;
}

export interface FourBasedCoinPackage {
  _id?: string;
  coins?: number;
  price?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface FourBasedUserProfile {
  _id: string;
  name?: string;
  is_online?: boolean;
  last_activity_date?: string;
  last_seen_at?: string;
  last_login?: string;
  verified?: boolean;
  trusted_user?: boolean;
  creator?: boolean;
  folders?: string[];
  avatar?: {
    preview?: Record<string, string>;
  };
  [key: string]: unknown;
}

export async function connectFourBasedAccount(
  input: ConnectFourBasedInput
): Promise<ConnectFourBasedResponse> {
  return request<ConnectFourBasedResponse>('/api/creators/connect', {
    method: 'POST',
    body: JSON.stringify({
      accountId: input.accountId,
      platform: '4based',
      email: input.email,
      password: input.password,
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.username ? { username: input.username } : {}),
    }),
  });
}

export async function reconnectFourBasedAccount(
  creatorId: string,
  input: { email: string; password: string; proxyUrl?: string }
): Promise<{ creator: Creator }> {
  return request(`/api/creators/${creatorId}/4based/reconnect`, {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      password: input.password,
      ...(input.proxyUrl ? { proxyUrl: input.proxyUrl } : {}),
    }),
  });
}

export async function reconnectFourBasedAccountSaved(
  creatorId: string
): Promise<{ creator: Creator }> {
  return request(`/api/creators/${creatorId}/4based/reconnect-saved`, {
    method: 'POST',
  });
}

export type FourBasedChatFilter =
  | 'online'
  | 'unread'
  | 'read'
  | 'follower'
  | 'subscribers';

export interface FourBasedUserList {
  _id: string;
  name?: string;
  position?: number;
  user_id?: string;
  [key: string]: unknown;
}

export interface FourBasedPivot {
  _id?: string;
  alias?: string;
  note?: string;
  action_user_id?: string;
  chat_id?: string;
  [key: string]: unknown;
}

export async function listFourBasedChats(
  creatorId: string,
  options: {
    limit?: number;
    offset?: number;
    filter?: FourBasedChatFilter | null;
    listId?: string | null;
  } = {}
): Promise<{ chats: FourBasedChat[]; providerUserId: string }> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.filter) params.set('filter', options.filter);
  if (options.listId) params.set('listId', options.listId);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/chats${query ? `?${query}` : ''}`
  );
}

export async function pinFourBasedChat(
  creatorId: string,
  chatId: string,
  isPinned: boolean
): Promise<{ ok: boolean; isPinned: boolean }> {
  return request(
    `/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}/pin`,
    {
      method: 'POST',
      body: JSON.stringify({ isPinned }),
    }
  );
}

export async function listFourBasedUserLists(
  creatorId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ lists: FourBasedUserList[] }> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/user-lists${query ? `?${query}` : ''}`
  );
}

export async function getFourBasedFanLists(
  creatorId: string,
  fanId: string
): Promise<{ userId: string; userListIds: string[] }> {
  return request(
    `/api/creators/${creatorId}/4based/user-lists/contains/${encodeURIComponent(fanId)}`
  );
}

export async function addFourBasedFanToList(
  creatorId: string,
  listId: string,
  fanId: string
): Promise<{ ok: boolean }> {
  return request(
    `/api/creators/${creatorId}/4based/user-lists/${encodeURIComponent(listId)}/add`,
    {
      method: 'POST',
      body: JSON.stringify({ fanId }),
    }
  );
}

export async function removeFourBasedFanFromList(
  creatorId: string,
  listId: string,
  fanId: string
): Promise<{ ok: boolean }> {
  return request(
    `/api/creators/${creatorId}/4based/user-lists/${encodeURIComponent(listId)}/remove`,
    {
      method: 'POST',
      body: JSON.stringify({ fanId }),
    }
  );
}

export async function getFourBasedPivot(
  creatorId: string,
  fanId: string
): Promise<{ pivot: FourBasedPivot | null; alias: string; note: string }> {
  return request(
    `/api/creators/${creatorId}/4based/pivot/${encodeURIComponent(fanId)}`
  );
}

export async function updateFourBasedPivot(
  creatorId: string,
  fanId: string,
  patch: { alias?: string; note?: string }
): Promise<{ pivot: FourBasedPivot | null; alias: string; note: string }> {
  return request(
    `/api/creators/${creatorId}/4based/pivot/${encodeURIComponent(fanId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(patch),
    }
  );
}

export async function deleteFourBasedPivotField(
  creatorId: string,
  fanId: string,
  field: 'alias' | 'note'
): Promise<{ ok: boolean; pivot: FourBasedPivot | null; alias: string; note: string }> {
  return request(
    `/api/creators/${creatorId}/4based/pivot/${encodeURIComponent(fanId)}/${field}`,
    { method: 'DELETE' }
  );
}

/** Alias for the shared fan-stats endpoint (4based + maloum). */
export async function getFourBasedFanStats(filters: {
  creatorId: string;
  chatId?: string;
  fanId?: string;
}): Promise<MaloumFanStats> {
  return getMaloumFanStats(filters);
}

export async function getFourBasedChat(
  creatorId: string,
  chatId: string
): Promise<{ chat: FourBasedChat; providerUserId: string }> {
  return request(`/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}`);
}

export async function getFourBasedMessages(
  creatorId: string,
  chatId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ messages: FourBasedMessage[]; providerUserId: string }> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}/messages${
      query ? `?${query}` : ''
    }`
  );
}

export async function sendFourBasedMessage(
  creatorId: string,
  chatId: string,
  payload: {
    message: string;
    fileStackId?: string | null;
    localId?: string;
    fanId?: string | null;
    fanUsername?: string | null;
    englishText?: string | null;
  }
): Promise<{ message: FourBasedMessage; localId: string }> {
  return request(
    `/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function deleteFourBasedMessage(
  creatorId: string,
  chatId: string,
  messageId: string
): Promise<{ ok: boolean; message?: FourBasedMessage }> {
  return request(
    `/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function sendFourBasedPpv(
  creatorId: string,
  chatId: string,
  payload: {
    message: string;
    vaultId?: string;
    vaultGuid?: string;
    vaults?: Array<{
      id: string;
      guid?: string;
      position?: number;
      is_teaser?: boolean;
    }>;
    priceCoins: number;
    localId?: string;
    fanId?: string | null;
    fanUsername?: string | null;
    englishText?: string | null;
  }
): Promise<{
  message: FourBasedMessage;
  fileStack: FourBasedFileStack;
  localId: string;
}> {
  return request(
    `/api/creators/${creatorId}/4based/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function listFourBasedVault(
  creatorId: string,
  fanId?: string | null,
  options: {
    limit?: number;
    offset?: number;
    folder?: string;
    fileType?: 'image' | 'video';
    sold?: boolean;
    sent?: boolean;
    lastPublished?: boolean;
  } = {}
): Promise<{ items: FourBasedVaultItem[]; providerUserId: string }> {
  const params = new URLSearchParams();
  if (fanId) params.set('fanId', fanId);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.folder) params.set('folder', options.folder);
  if (options.fileType) params.set('fileType', options.fileType);
  if (options.sold != null) params.set('sold', options.sold ? 'true' : 'false');
  if (options.sent != null) params.set('sent', options.sent ? 'true' : 'false');
  if (options.lastPublished != null) {
    params.set('lastPublished', options.lastPublished ? 'true' : 'false');
  }
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/vault${query ? `?${query}` : ''}`
  );
}

export type VaultNotePlatform = 'maloum' | '4based';

export interface VaultMediaNote {
  mediaKey: string;
  note: string;
  updatedAt: string | null;
}

export async function listVaultMediaNotes(
  creatorId: string,
  platform: VaultNotePlatform,
  keys: string[]
): Promise<{ notes: Record<string, string> }> {
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))].slice(0, 200);
  if (unique.length === 0) return { notes: {} };
  const params = new URLSearchParams();
  params.set('platform', platform);
  params.set('keys', unique.join(','));
  return request(`/api/creators/${creatorId}/vault-notes?${params.toString()}`);
}

export async function getVaultMediaNote(
  creatorId: string,
  platform: VaultNotePlatform,
  mediaKey: string
): Promise<VaultMediaNote> {
  return request(
    `/api/creators/${creatorId}/vault-notes/${platform}/${encodeURIComponent(mediaKey)}`
  );
}

export async function upsertVaultMediaNote(
  creatorId: string,
  platform: VaultNotePlatform,
  mediaKey: string,
  note: string
): Promise<VaultMediaNote> {
  return request(
    `/api/creators/${creatorId}/vault-notes/${platform}/${encodeURIComponent(mediaKey)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ note }),
    }
  );
}

export type ScriptPlatform = 'maloum' | '4based';

export interface CreatorScriptMediaItem {
  mediaKey: string;
  type?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
  guid?: string;
}

export interface CreatorScriptFolder {
  id: string;
  creatorId: string;
  platform: ScriptPlatform;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorScript {
  id: string;
  creatorId: string;
  platform: ScriptPlatform;
  folderId: string | null;
  title: string;
  shortcutCode: string | null;
  messageText: string;
  price: number;
  media: CreatorScriptMediaItem[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  sentToFan?: boolean;
}

export interface CreatorScriptsListResponse {
  folders: CreatorScriptFolder[];
  scripts: CreatorScript[];
}

export async function listCreatorScripts(
  creatorId: string,
  platform: ScriptPlatform,
  fanId?: string | null
): Promise<CreatorScriptsListResponse> {
  const params = new URLSearchParams();
  params.set('platform', platform);
  if (fanId?.trim()) params.set('fanId', fanId.trim());
  return request(`/api/creators/${creatorId}/scripts?${params.toString()}`);
}

export async function createScriptFolder(
  creatorId: string,
  body: { platform: ScriptPlatform; name: string; sortOrder?: number }
): Promise<CreatorScriptFolder> {
  return request(`/api/creators/${creatorId}/script-folders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateScriptFolder(
  creatorId: string,
  folderId: string,
  body: { name?: string; sortOrder?: number }
): Promise<CreatorScriptFolder> {
  return request(`/api/creators/${creatorId}/script-folders/${folderId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteScriptFolder(
  creatorId: string,
  folderId: string
): Promise<{ ok: boolean; id: string }> {
  return request(`/api/creators/${creatorId}/script-folders/${folderId}`, {
    method: 'DELETE',
  });
}

export interface CreatorScriptInput {
  platform: ScriptPlatform;
  title: string;
  shortcutCode?: string | null;
  messageText?: string;
  price?: number;
  media?: CreatorScriptMediaItem[];
  folderId?: string | null;
  sortOrder?: number;
}

export async function createCreatorScript(
  creatorId: string,
  body: CreatorScriptInput
): Promise<CreatorScript> {
  return request(`/api/creators/${creatorId}/scripts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateCreatorScript(
  creatorId: string,
  scriptId: string,
  body: Partial<Omit<CreatorScriptInput, 'platform'>>
): Promise<CreatorScript> {
  return request(`/api/creators/${creatorId}/scripts/${scriptId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function deleteCreatorScript(
  creatorId: string,
  scriptId: string
): Promise<{ ok: boolean; id: string }> {
  return request(`/api/creators/${creatorId}/scripts/${scriptId}`, {
    method: 'DELETE',
  });
}

export async function markScriptSent(
  creatorId: string,
  scriptId: string,
  body: { fanId: string; chatId?: string | null }
): Promise<{
  id: string;
  scriptId: string;
  fanId: string;
  chatId: string | null;
  sentAt: string;
}> {
  return request(`/api/creators/${creatorId}/scripts/${scriptId}/sent`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface FourBasedMassMessageFileStack {
  _id?: string;
  type?: string;
  fileStackType?: string;
  preview?: Record<string, string>;
  source?: string[] | string;
  duration?: number;
  width?: number;
  height?: number;
  price?: number;
  vault_file_stack_id?: string;
  [key: string]: unknown;
}

export interface FourBasedMassMessage {
  _id: string;
  id?: string;
  user_id?: string;
  message?: string;
  status?: string;
  target_group?: string;
  filter?: string[];
  include_user_list?: string[];
  exclude_user_list?: string[];
  exclude_filter?: string[];
  user_list_id?: string | null;
  file_stack_id?: string | null;
  to_be_posted_at?: string | null;
  recipient_count?: number;
  viewed_count?: number;
  processing_finished_at?: string | null;
  created_at?: string;
  updated_at?: string;
  message_data?: {
    message?: string;
    type?: string;
    sender_status?: string;
    file_stack_id?: string;
    [key: string]: unknown;
  };
  file_stack?: FourBasedMassMessageFileStack | null;
  [key: string]: unknown;
}

export type FourBasedMassMessageTab = 'sent' | 'unsent';

export async function listFourBasedMassMessages(
  creatorId: string,
  options: {
    tab?: FourBasedMassMessageTab;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ messages: FourBasedMassMessage[]; providerUserId: string }> {
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/mass-messages${query ? `?${query}` : ''}`
  );
}

export async function deleteFourBasedMassMessage(
  creatorId: string,
  massMessageId: string
): Promise<{ ok: boolean; id: string }> {
  return request(
    `/api/creators/${creatorId}/4based/mass-messages/${encodeURIComponent(massMessageId)}`,
    { method: 'DELETE' }
  );
}

export async function countFourBasedMassMessageReceivers(
  creatorId: string,
  payload: {
    includeUserList?: string[];
    excludeUserList?: string[];
    excludeFilter?: string[];
    filter?: string[];
  } = {}
): Promise<{ count: number }> {
  return request(`/api/creators/${creatorId}/4based/mass-messages/receivers/count`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function sendFourBasedMassMessage(
  creatorId: string,
  payload: {
    message?: string;
    text?: string;
    includeUserList?: string[];
    excludeUserList?: string[];
    excludeFilter?: string[];
    filter?: string[];
    vaults?: Array<{
      id: string;
      guid?: string;
      position?: number;
      is_teaser?: boolean;
    }>;
    vaultId?: string;
    vaultGuid?: string;
    priceCoins?: number;
    price?: number;
    fileStackId?: string;
  }
): Promise<{ message: FourBasedMassMessage; providerUserId: string }> {
  return request(`/api/creators/${creatorId}/4based/mass-messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function getFourBasedProfile(
  creatorId: string
): Promise<{ profile: FourBasedUserProfile; providerUserId: string }> {
  return request(`/api/creators/${creatorId}/4based/profile`);
}

export async function getFourBasedUser(
  creatorId: string,
  userId: string
): Promise<{ user: FourBasedUserProfile; providerUserId: string }> {
  return request(`/api/creators/${creatorId}/4based/users/${encodeURIComponent(userId)}`);
}

export async function getFourBasedCoinPackages(
  creatorId: string
): Promise<{ packages: FourBasedCoinPackage[] }> {
  return request(`/api/creators/${creatorId}/4based/coin-packages`);
}

export async function getFourBasedUnread(
  creatorId: string
): Promise<{ unread: unknown }> {
  return request(`/api/creators/${creatorId}/4based/unread`);
}

export async function getFourBasedBadges(
  creatorId: string
): Promise<{ messages: number; notifications: number }> {
  return request(`/api/creators/${creatorId}/4based/badges`);
}

export interface FourBasedActivityUser {
  _id?: string;
  name?: string;
  is_online?: boolean;
  avatar?: {
    preview?: Record<string, string>;
  };
  [key: string]: unknown;
}

export interface FourBasedActivity {
  _id: string;
  type?: string;
  status?: string;
  for_user_id?: string;
  user_id?: string;
  created_at?: string;
  updated_at?: string;
  file_stack_id?: string | null;
  file_stack?: FourBasedFileStack | null;
  user?: FourBasedActivityUser | null;
  process?: { amount?: number; value?: number; [key: string]: unknown } | null;
  [key: string]: unknown;
}

export async function getFourBasedActivities(
  creatorId: string,
  options: { offset?: number; limit?: number; types?: string } = {}
): Promise<{
  activities: FourBasedActivity[];
  offset: number;
  limit: number;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.types) params.set('types', options.types);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/activities${query ? `?${query}` : ''}`
  );
}

export async function resetFourBasedActivities(
  creatorId: string
): Promise<{ ok: boolean }> {
  return request(`/api/creators/${creatorId}/4based/activities/reset`, {
    method: 'POST',
  });
}

function isFourBasedPublicPreviewUrl(url?: string | null): url is string {
  return Boolean(
    url &&
      /^https:\/\/media-public\.4based\.com\//i.test(url)
  );
}

export function isFourBasedPublicMediaUrl(url?: string | null): url is string {
  return isFourBasedPublicPreviewUrl(url);
}

/**
 * Strip a 4based media URL down to a proxy path (`protected/...` or `public/...`).
 * Returns null for media-public URLs that should be used directly as src.
 */
export function fourBasedMediaPathFromUrl(
  url: string | null | undefined
): string | null {
  if (!url || typeof url !== 'string') return null;
  if (isFourBasedPublicMediaUrl(url)) return null;
  const idxProtected = url.indexOf('/protected/');
  if (idxProtected >= 0) return url.slice(idxProtected + 1);
  const idxPublic = url.indexOf('/public/');
  if (idxPublic >= 0) return url.slice(idxPublic + 1);
  if (url.startsWith('https://media.4based.com/')) {
    return url.slice('https://media.4based.com/'.length);
  }
  if (url.startsWith('protected/') || url.startsWith('public/')) return url;
  return null;
}

/**
 * Resolve a 4based media URL for <img>/<video src>:
 * - media-public HTTPS → use directly (no DomX proxy)
 * - protected/public path or media.4based.com URL → DomX proxy + disk cache
 */
export function resolveFourBasedMediaSrc(
  creatorId: string,
  urlOrPath: string | null | undefined
): string | null {
  if (!urlOrPath || typeof urlOrPath !== 'string') return null;
  if (isFourBasedPublicMediaUrl(urlOrPath)) return urlOrPath;
  const path = fourBasedMediaPathFromUrl(urlOrPath) || (
    urlOrPath.startsWith('protected/') || urlOrPath.startsWith('public/')
      ? urlOrPath
      : null
  );
  if (!path) return null;
  return fourBasedMediaUrl(creatorId, path);
}

/** Pick a preview URL from a preview map, preferring listed sizes. */
export function pickFourBasedPreviewUrl(
  preview: Record<string, string> | null | undefined,
  preferredSizes: string[] = ['500x500', '400x400', '200x200', '900xxx']
): string | null {
  if (!preview || typeof preview !== 'object') return null;
  for (const size of preferredSizes) {
    const withExt = preview[`${size}.jpg`] || preview[size];
    if (typeof withExt === 'string' && withExt) return withExt;
  }
  for (const value of Object.values(preview)) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** First usable source URL from file_stack.source / vault source[]. */
export function pickFourBasedSourceUrl(
  source: unknown
): string | null {
  if (typeof source === 'string' && source) return source;
  if (Array.isArray(source)) {
    for (const entry of source) {
      if (typeof entry === 'string' && entry) return entry;
    }
  }
  return null;
}

/** Pick a public CDN preview URL from activity/file_stack.preview — never the DomX media proxy. */
export function fourBasedPublicPreviewUrl(
  fileStack:
    | FourBasedFileStack
    | { preview?: Record<string, string> | null }
    | null
    | undefined,
  preferredSizes: string[] = ['100x100', '200x200', '80x80', '50x50', '500x500']
): string | null {
  const preview = fileStack?.preview;
  if (!preview || typeof preview !== 'object') return null;

  for (const size of preferredSizes) {
    const withExt = preview[`${size}.jpg`] || preview[size];
    if (isFourBasedPublicPreviewUrl(withExt)) return withExt;
  }

  for (const value of Object.values(preview)) {
    if (isFourBasedPublicPreviewUrl(value)) return value;
  }
  return null;
}

/** Build a media-proxy URL for use in <img>/<video src>. Includes DomX access token. */
export function fourBasedMediaUrl(creatorId: string, path: string): string {
  const token = getToken() || '';
  const params = new URLSearchParams({
    path,
    access_token: token,
  });
  return `${API_URL}/api/creators/${creatorId}/4based/media?${params.toString()}`;
}

export function fourBasedPreviewPath(
  providerUserId: string,
  fileStackId: string,
  size: string = '500x500.jpg'
): string {
  return `protected/${providerUserId}/${fileStackId}/preview/${size}`;
}

/* ─── Maloum chat / vault API ─────────────────────────────────────────── */

export interface MaloumMediaAsset {
  uploadId?: string;
  mediaId?: string;
  uploadStatus?: string;
  type?: string;
  url?: string;
  width?: number;
  height?: number;
  length?: number;
  [key: string]: unknown;
}

export interface MaloumChatPartner {
  _id?: string;
  username?: string;
  nickname?: string;
  notes?: string;
  isCreator?: boolean;
  isTrusted?: boolean;
  totalSpendForCreator?: number;
  chatAccessSettings?: unknown;
  profilePicture?: MaloumMediaAsset;
  profilePictureThumbnail?: MaloumMediaAsset;
  [key: string]: unknown;
}

export interface MaloumLastMessage {
  _id?: string;
  sentAt?: string;
  type?: string;
  text?: string;
  priceCurrency?: string;
  senderId?: string;
  [key: string]: unknown;
}

export interface MaloumChat {
  _id: string;
  createdAt?: string;
  unreadMessages?: boolean;
  inbox?: string;
  chatPartner?: MaloumChatPartner;
  lastRelevantMessage?: MaloumLastMessage;
  taggedLists?: unknown[];
  unlocked?: boolean;
  hasMediaGallery?: boolean;
  chatPartnerBlockedByCurrentUser?: boolean;
  currentUserBlockedByChatPartner?: boolean;
  [key: string]: unknown;
}

export interface MaloumMessageContent {
  type?: string;
  text?: string;
  media?: MaloumMediaAsset[];
  thumbnails?: MaloumMediaAsset[];
  /** Present on fetched chat_product messages from Maloum API */
  price?: { gross?: number; net?: number; currency?: string };
  /** Used on optimistic / outbound send payloads */
  priceNet?: number;
  [key: string]: unknown;
}

export interface MaloumMessage {
  _id: string;
  chat?: string;
  readAt?: string | null;
  senderId?: string;
  sentAt?: string;
  isBroadcasted?: boolean;
  content?: MaloumMessageContent;
  isBought?: boolean;
  [key: string]: unknown;
}

export interface MaloumVaultFolder {
  _id: string;
  createdAt?: string;
  name?: string;
  isManaged?: boolean;
  pictureCount?: number;
  videoCount?: number;
  mostRecentMediaThumbnails?: MaloumMediaAsset[];
  [key: string]: unknown;
}

export interface MaloumVaultMediaItem {
  media?: MaloumMediaAsset;
  thumbnail?: MaloumMediaAsset;
  [key: string]: unknown;
}

export async function listMaloumChats(
  creatorId: string,
  options: {
    limit?: number;
    next?: string;
    filter?: 'unread' | null;
    lastMessageSender?: 'sentByMe' | 'sentByOther' | null;
  } = {}
): Promise<{ chats: MaloumChat[]; next: string | null; providerUserId: string | null }> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  if (options.filter) params.set('filter', options.filter);
  if (options.lastMessageSender) {
    params.set('lastMessageSender', options.lastMessageSender);
  }
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/chats${query ? `?${query}` : ''}`
  );
}

export async function getMaloumUnreadCount(
  creatorId: string
): Promise<{ unread: number }> {
  return request(`/api/creators/${creatorId}/maloum/chats/unread-count`);
}

export async function getMaloumBadges(
  creatorId: string
): Promise<{ messages: number; notifications: number }> {
  return request(`/api/creators/${creatorId}/maloum/badges`);
}

export interface MaloumNotification {
  _id: string;
  forUserId?: string;
  type?: string;
  isRead?: boolean;
  createdAt?: string;
  fanId?: string;
  fanUsername?: string | null;
  fanNickname?: string | null;
  net?: number;
  messageId?: string;
  [key: string]: unknown;
}

export async function getMaloumNotifications(
  creatorId: string,
  options: { limit?: number; next?: string } = {}
): Promise<{
  notifications: MaloumNotification[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/notifications${query ? `?${query}` : ''}`
  );
}

export async function markMaloumNotificationsReadAll(
  creatorId: string
): Promise<{ ok: boolean }> {
  return request(`/api/creators/${creatorId}/maloum/notifications/read-all`, {
    method: 'POST',
  });
}

export async function getMaloumChat(
  creatorId: string,
  chatId: string
): Promise<{ chat: MaloumChat; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}`);
}

export async function getMaloumMessages(
  creatorId: string,
  chatId: string,
  options: { limit?: number; next?: string } = {}
): Promise<{
  messages: MaloumMessage[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}/messages${
      query ? `?${query}` : ''
    }`
  );
}

export async function sendMaloumMessage(
  creatorId: string,
  chatId: string,
  payload: {
    message?: string;
    text?: string;
    media?: Array<{
      mediaId: string;
      type?: string;
      width?: number;
      height?: number;
    }>;
    priceNet?: number;
    optimisticMessageId?: string;
    fanId?: string | null;
    fanUsername?: string | null;
    englishText?: string | null;
  }
): Promise<{
  messageId: string;
  message: { _id: string };
  optimisticMessageId: string;
}> {
  return request(
    `/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function deleteMaloumMessage(
  creatorId: string,
  chatId: string,
  messageId: string,
  options: { deleteTextOnly?: boolean } = {}
): Promise<{ ok: boolean }> {
  return request(
    `/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        deleteTextOnly: Boolean(options.deleteTextOnly),
      }),
    }
  );
}

export async function sendMaloumPpv(
  creatorId: string,
  chatId: string,
  payload: {
    text?: string;
    message?: string;
    media: Array<{
      mediaId: string;
      type?: string;
      width?: number;
      height?: number;
    }>;
    priceNet: number;
    optimisticMessageId?: string;
  }
): Promise<{
  messageId: string;
  message: { _id: string };
  optimisticMessageId: string;
}> {
  return sendMaloumMessage(creatorId, chatId, payload);
}

export interface MaloumChatListItem {
  _id: string;
  name?: string;
  isManaged?: boolean;
  totalMemberCount?: number;
  [key: string]: unknown;
}

export interface MaloumBroadcastMedia {
  _id?: string;
  type?: string;
  url?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface MaloumBroadcastContent {
  text?: string;
  media?: MaloumBroadcastMedia[];
  price?: number;
  [key: string]: unknown;
}

export interface MaloumBroadcast {
  _id: string;
  processedAt?: string;
  content?: MaloumBroadcastContent;
  recipientCount?: number;
  viewerCount?: number;
  buyerCount?: number;
  isRevoked?: boolean;
  isSending?: boolean;
  includeFromLists?: MaloumChatListItem[];
  excludeFromLists?: MaloumChatListItem[];
  [key: string]: unknown;
}

export async function listMaloumBroadcasts(
  creatorId: string,
  options: { limit?: number; next?: string; filter?: string } = {}
): Promise<{
  broadcasts: MaloumBroadcast[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  if (options.filter) params.set('filter', options.filter);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/broadcasts${query ? `?${query}` : ''}`
  );
}

export async function sendMaloumBroadcast(
  creatorId: string,
  payload: {
    includeFromLists: string[];
    excludeFromLists?: string[];
    text?: string;
    message?: string;
    media?: Array<{
      mediaId: string;
      type?: string;
      width?: number;
      height?: number;
    }>;
    priceNet?: number;
    price?: number;
  }
): Promise<{ ok: boolean }> {
  return request(`/api/creators/${creatorId}/maloum/broadcasts`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function revokeMaloumBroadcast(
  creatorId: string,
  broadcastId: string
): Promise<{ ok: boolean }> {
  return request(
    `/api/creators/${creatorId}/maloum/broadcasts/${encodeURIComponent(broadcastId)}/revoke`,
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
}

export async function listMaloumChatLists(
  creatorId: string,
  options: { limit?: number; next?: string } = {}
): Promise<{
  lists: MaloumChatListItem[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/chat-lists${query ? `?${query}` : ''}`
  );
}

export async function createMaloumChatList(
  creatorId: string,
  name: string
): Promise<{ list: MaloumChatListItem; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/chat-lists`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export interface MaloumTopCreatorItem {
  rank?: number;
  user?: {
    _id?: string;
    username?: string;
    isCreator?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function listMaloumTopCreators(
  creatorId: string,
  options: { limit?: number; next?: number } = {}
): Promise<{
  creators: MaloumTopCreatorItem[];
  next: number | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next != null) params.set('next', String(options.next));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/top-creators${query ? `?${query}` : ''}`
  );
}

export interface MaloumUserProfile {
  _id?: string;
  username?: string;
  isCreator?: boolean;
  [key: string]: unknown;
}

export async function getMaloumUserProfile(
  creatorId: string,
  username: string
): Promise<{ profile: MaloumUserProfile; providerUserId: string | null }> {
  return request(
    `/api/creators/${creatorId}/maloum/users/${encodeURIComponent(username)}/profile`
  );
}

export interface MaloumFeedPost {
  _id: string;
  publishedAt?: string;
  caption?: string;
  commentCount?: number;
  [key: string]: unknown;
}

export async function listMaloumUserPosts(
  creatorId: string,
  username: string,
  options: { limit?: number; next?: string } = {}
): Promise<{
  posts: MaloumFeedPost[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/posts/user/${encodeURIComponent(username)}${
      query ? `?${query}` : ''
    }`
  );
}

export interface MaloumPostComment {
  _id?: string;
  text?: string;
  createdAt?: string;
  user?: {
    _id?: string;
    username?: string;
    isCreator?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function listMaloumPostComments(
  creatorId: string,
  postId: string,
  options: { limit?: number; next?: string } = {}
): Promise<{
  comments: MaloumPostComment[];
  next: string | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next) params.set('next', options.next);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/posts/${encodeURIComponent(postId)}/comments${
      query ? `?${query}` : ''
    }`
  );
}

export async function createMaloumChat(
  creatorId: string,
  member2: string
): Promise<{ chat: MaloumChat; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/chats`, {
    method: 'POST',
    body: JSON.stringify({ member2 }),
  });
}

export type MaloumFanScrapeSourceMode =
  | 'top_creators'
  | 'custom_usernames'
  | 'import_ids';
export type MaloumFanScrapeJobStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export interface MaloumFanScrapeCheckpoint {
  sourceCreators: string[];
  creatorIndex: number;
  postIndex: number;
  posts: string[];
  commentNext: string | null;
  processedFans: number;
  skippedFans: number;
  failedFans: number;
  skippedPosts?: number;
  distributedFans?: number;
  distributeFailed?: number;
  importFanIndex?: number;
  importCreatorIndex?: number;
  invalidUsernames: string[];
  lastError: string | null;
  currentCreatorUsername: string | null;
  currentPostId: string | null;
  statusMessage?: string | null;
}

export interface MaloumFanScrapeJob {
  id: string;
  motherCreatorId: string;
  targetListId: string | null;
  targetListName: string | null;
  status: MaloumFanScrapeJobStatus;
  sourceMode: MaloumFanScrapeSourceMode;
  topCreatorsLimit: number;
  postsPerCreator: number;
  customUsernames: string[];
  distributeToAllCreators?: boolean;
  distributeListName?: string;
  importFanIds?: string[];
  messageText?: string;
  targetCreatorIds?: string[];
  targetCreatorListIds?: Record<string, string>;
  checkpoint: MaloumFanScrapeCheckpoint;
  startedAt: string | null;
  updatedAt: string;
  createdAt: string;
  createdByUserId: string | null;
}

export async function getMaloumFanScrapeJob(creatorId: string): Promise<{
  job: MaloumFanScrapeJob;
  scrapedFanCount: number;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/job`);
}

export async function updateMaloumFanScrapeJob(
  creatorId: string,
  payload: {
    targetListId?: string | null;
    targetListName?: string | null;
    sourceMode?: MaloumFanScrapeSourceMode;
    topCreatorsLimit?: number;
    postsPerCreator?: number;
    customUsernames?: string[] | string;
    distributeToAllCreators?: boolean;
    distributeListName?: string;
    importFanIds?: string[] | string;
    messageText?: string;
    targetCreatorIds?: string[];
    targetCreatorListIds?: Record<string, string>;
    resetCheckpoint?: boolean;
  }
): Promise<{ job: MaloumFanScrapeJob; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/job`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function startMaloumFanScrapeJob(creatorId: string): Promise<{
  job: MaloumFanScrapeJob;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/job/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function stopMaloumFanScrapeJob(creatorId: string): Promise<{
  job: MaloumFanScrapeJob;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/job/stop`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function checkpointMaloumFanScrapeJob(
  creatorId: string,
  payload: {
    checkpoint?: Partial<MaloumFanScrapeCheckpoint>;
    status?: MaloumFanScrapeJobStatus;
  }
): Promise<{ job: MaloumFanScrapeJob; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/job/checkpoint`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function maloumFanScrapeFansExist(
  creatorId: string,
  fanIds: string[]
): Promise<{ existing: string[]; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/fans/exists`, {
    method: 'POST',
    body: JSON.stringify({ fanIds }),
  });
}

export async function upsertMaloumFanScrapeFan(
  creatorId: string,
  payload: {
    fanId: string;
    chatId?: string | null;
    username?: string | null;
    sourceCreatorUsername?: string | null;
    sourcePostId?: string | null;
    listId?: string | null;
  }
): Promise<{ fan: Record<string, unknown>; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/maloum/fan-scrape/fans`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type FourBasedFanScrapeJobStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export type FourBasedFanScrapeSourceMode = 'trending' | 'import_ids';

export interface FourBasedFanScrapeCheckpoint {
  trendingOffset: number;
  currentPagePostIds: string[];
  postIndex: number;
  commentOffset: number;
  processedFans: number;
  skippedFans: number;
  failedFans: number;
  skippedPosts?: number;
  importFanIndex?: number;
  importCreatorIndex?: number;
  lastError: string | null;
  currentPostId: string | null;
  statusMessage?: string | null;
  trendingExhausted?: boolean;
}

export interface FourBasedFanScrapeJob {
  id: string;
  motherCreatorId: string;
  status: FourBasedFanScrapeJobStatus;
  sourceMode?: FourBasedFanScrapeSourceMode;
  messageText: string;
  vaultIds: string[];
  priceCoins: number;
  importFans?: Record<string, string | null>;
  targetCreatorIds?: string[];
  checkpoint: FourBasedFanScrapeCheckpoint;
  startedAt: string | null;
  updatedAt: string;
  createdAt: string;
  createdByUserId: string | null;
}

export async function getFourBasedFanScrapeJob(creatorId: string): Promise<{
  job: FourBasedFanScrapeJob;
  scrapedFanCount: number;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/4based/fan-scrape/job`);
}

export async function updateFourBasedFanScrapeJob(
  creatorId: string,
  payload: {
    messageText?: string;
    vaultIds?: string[];
    priceCoins?: number;
    sourceMode?: FourBasedFanScrapeSourceMode;
    importFans?: Record<string, string | null> | string[] | string;
    targetCreatorIds?: string[];
    resetCheckpoint?: boolean;
  }
): Promise<{ job: FourBasedFanScrapeJob; providerUserId: string | null }> {
  return request(`/api/creators/${creatorId}/4based/fan-scrape/job`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function startFourBasedFanScrapeJob(creatorId: string): Promise<{
  job: FourBasedFanScrapeJob;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/4based/fan-scrape/job/start`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function stopFourBasedFanScrapeJob(creatorId: string): Promise<{
  job: FourBasedFanScrapeJob;
  serverRunning?: boolean;
  providerUserId: string | null;
}> {
  return request(`/api/creators/${creatorId}/4based/fan-scrape/job/stop`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function getMaloumFanAssignedLists(
  creatorId: string,
  memberId: string
): Promise<{ lists: MaloumChatListItem[]; providerUserId: string | null }> {
  return request(
    `/api/creators/${creatorId}/maloum/chat-lists/members/${encodeURIComponent(memberId)}/assigned`
  );
}

export async function setMaloumFanAssignedLists(
  creatorId: string,
  memberId: string,
  chatListIds: string[]
): Promise<{
  ok: boolean;
  lists: MaloumChatListItem[];
  providerUserId: string | null;
}> {
  return request(
    `/api/creators/${creatorId}/maloum/chat-lists/members/${encodeURIComponent(memberId)}/assigned`,
    {
      method: 'POST',
      body: JSON.stringify({ chatListIds }),
    }
  );
}

export async function updateMaloumFanNickname(
  creatorId: string,
  chatId: string,
  nickname: string
): Promise<{ ok: boolean; chat: MaloumChat; providerUserId: string | null }> {
  return request(
    `/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}/faninfo/nickname`,
    {
      method: 'PATCH',
      body: JSON.stringify({ nickname }),
    }
  );
}

export async function updateMaloumFanNotes(
  creatorId: string,
  chatId: string,
  notes: string
): Promise<{ ok: boolean; chat: MaloumChat; providerUserId: string | null }> {
  return request(
    `/api/creators/${creatorId}/maloum/chats/${encodeURIComponent(chatId)}/faninfo/notes`,
    {
      method: 'PATCH',
      body: JSON.stringify({ notes }),
    }
  );
}

export async function listMaloumVaultFolders(
  creatorId: string,
  options: { query?: string; limit?: number; next?: number } = {}
): Promise<{
  folders: MaloumVaultFolder[];
  next: number | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.query) params.set('query', options.query);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next != null) params.set('next', String(options.next));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/vault/folders${query ? `?${query}` : ''}`
  );
}

export async function listMaloumVaultMedia(
  creatorId: string,
  folderId: string,
  options: { fanId?: string; limit?: number; next?: number } = {}
): Promise<{
  items: MaloumVaultMediaItem[];
  next: number | null;
  providerUserId: string | null;
}> {
  const params = new URLSearchParams();
  if (options.fanId) params.set('fanId', options.fanId);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.next != null) params.set('next', String(options.next));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/vault/folders/${encodeURIComponent(folderId)}/media${
      query ? `?${query}` : ''
    }`
  );
}

export async function listMaloumVaultSent(
  creatorId: string,
  options: { fanId?: string; chatId?: string } = {}
): Promise<{ uploadIds: string[] }> {
  const params = new URLSearchParams();
  if (options.fanId) params.set('fanId', options.fanId);
  if (options.chatId) params.set('chatId', options.chatId);
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/maloum/vault-sent${query ? `?${query}` : ''}`
  );
}

export async function recordMaloumVaultSent(
  creatorId: string,
  payload: { fanId: string; chatId?: string; uploadIds: string[] }
): Promise<{ ok: boolean; uploadIds: string[] }> {
  return request(`/api/creators/${creatorId}/maloum/vault-sent`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Build a Maloum media-proxy URL for use in <img src>. Includes DomX access token. */
export function maloumMediaUrl(
  creatorId: string,
  options: {
    uploadId?: string | null;
    variant?: 'thumbnail' | 'full';
    url?: string | null;
  }
): string {
  const token = getToken() || '';
  const params = new URLSearchParams({
    access_token: token,
    variant: options.variant || 'thumbnail',
  });
  if (options.uploadId) params.set('uploadId', options.uploadId);
  if (options.url) params.set('url', options.url);
  return `${API_URL}/api/creators/${creatorId}/maloum/media?${params.toString()}`;
}

export interface TranslateHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

export async function translateToGerman(
  text: string,
  history: TranslateHistoryItem[] = []
): Promise<string> {
  const result = await request<{ translatedText: string }>('/api/translate-to-german', {
    method: 'POST',
    body: JSON.stringify({ text, history }),
  });
  const translated = result.translatedText?.trim();
  if (!translated) {
    throw new Error('Translation returned empty text');
  }
  return translated;
}

export type SuggestReplyId = 'rapport' | 'upsell';

export interface SuggestReplyOption {
  id: SuggestReplyId;
  label: string;
  english: string;
  german: string;
}

export async function suggestReply(payload: {
  messages: TranslateHistoryItem[];
  fanNotes?: string;
  fanNickname?: string;
}): Promise<{ suggestions: SuggestReplyOption[] }> {
  const result = await request<{ suggestions: SuggestReplyOption[] }>(
    '/api/suggest-reply',
    {
      method: 'POST',
      body: JSON.stringify({
        messages: payload.messages,
        fanNotes: payload.fanNotes || '',
        fanNickname: payload.fanNickname || '',
      }),
    }
  );
  if (!Array.isArray(result.suggestions) || result.suggestions.length < 2) {
    throw new Error('Suggest reply returned incomplete suggestions');
  }
  return result;
}

// ── Content moderation ─────────────────────────────────────────────────────

export type ModerationAction =
  | 'block_warn'
  | 'notify_management'
  | 'log_for_review';

export type ModerationMatchMode = 'contains' | 'whole_word';

export type ModerationEventStatus = 'open' | 'reviewed' | 'dismissed';

export type ModerationMatchedStage = 'english' | 'german';

export interface KeywordRule {
  id: string;
  name: string;
  englishKeywords: string[];
  germanKeywords: string[];
  keywords: string[];
  matchMode: ModerationMatchMode;
  caseSensitive: boolean;
  actions: ModerationAction[];
  enabled: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModerationEvent {
  id: string;
  ruleId: string | null;
  matchedKeyword: string;
  matchedStage: ModerationMatchedStage | null;
  actionsTaken: ModerationAction[];
  userId: string | null;
  chatterName: string | null;
  chatterEmail: string | null;
  creatorId: string | null;
  creatorName: string | null;
  creatorUsername: string | null;
  platform: 'maloum' | '4based';
  chatId: string | null;
  fanId: string | null;
  fanUsername: string | null;
  messageText: string;
  englishMessageText: string;
  blocked: boolean;
  notified: boolean;
  status: ModerationEventStatus;
  reviewedBy: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export async function getKeywordRules(): Promise<{ rules: KeywordRule[] }> {
  return request('/api/moderation/rules');
}

export async function createKeywordRule(input: {
  name?: string;
  englishKeywords?: string[];
  germanKeywords?: string[];
  englishKeywordText?: string;
  germanKeywordText?: string;
  keywords?: string[];
  keywordText?: string;
  actions: ModerationAction[];
  matchMode?: ModerationMatchMode;
  caseSensitive?: boolean;
  enabled?: boolean;
}): Promise<{ rule: KeywordRule }> {
  return request('/api/moderation/rules', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateKeywordRule(
  id: string,
  input: {
    name?: string;
    englishKeywords?: string[];
    germanKeywords?: string[];
    englishKeywordText?: string;
    germanKeywordText?: string;
    keywords?: string[];
    keywordText?: string;
    actions?: ModerationAction[];
    matchMode?: ModerationMatchMode;
    caseSensitive?: boolean;
    enabled?: boolean;
  }
): Promise<{ rule: KeywordRule }> {
  return request(`/api/moderation/rules/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteKeywordRule(id: string): Promise<{ ok: boolean }> {
  return request(`/api/moderation/rules/${id}`, { method: 'DELETE' });
}

export async function getModerationEvents(params?: {
  status?: ModerationEventStatus | '';
  platform?: 'maloum' | '4based' | '';
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ events: ModerationEvent[] }> {
  const searchParams = new URLSearchParams();
  if (params?.status) searchParams.set('status', params.status);
  if (params?.platform) searchParams.set('platform', params.platform);
  if (params?.search) searchParams.set('search', params.search);
  if (params?.limit != null) searchParams.set('limit', String(params.limit));
  if (params?.offset != null) searchParams.set('offset', String(params.offset));
  const qs = searchParams.toString();
  return request(`/api/moderation/events${qs ? `?${qs}` : ''}`);
}

export async function updateModerationEvent(
  id: string,
  status: ModerationEventStatus
): Promise<{ event: ModerationEvent }> {
  return request(`/api/moderation/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

