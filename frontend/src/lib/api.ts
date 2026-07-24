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

  if (response.status === 401 && token) {
    clearToken();
    window.dispatchEvent(new CustomEvent('domx:session-expired'));
  }

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
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

export async function saveCreatorAvatarFromMaloum(
  creatorId: string,
  sourceUrl: string,
  options: { overwrite?: boolean; accountId: string }
): Promise<{ creator: Creator; skipped?: boolean; reason?: string }> {
  if (!window.electronAPI?.isElectron) {
    throw new Error('Saving Maloum avatars requires the DomX desktop app');
  }

  if (!options?.accountId) {
    throw new Error('accountId is required to download avatar from Maloum');
  }

  const image = await window.electronAPI.fetchCreatorAvatarImage({
    accountId: options.accountId,
    sourceUrl,
  });

  return request<{ creator: Creator; skipped?: boolean; reason?: string }>(
    `/api/creators/${creatorId}/avatar`,
    {
      method: 'POST',
      body: JSON.stringify({
        imageBase64: image.base64,
        contentType: image.contentType,
        overwrite: options.overwrite ?? false,
      }),
    }
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

export async function getMessagingDashboard(filters: {
  startDate?: string;
  endDate?: string;
  chatterId?: string;
  creatorId?: string;
  purchased?: boolean;
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

  if (typeof filters.purchased === 'boolean') {
    params.set('purchased', String(filters.purchased));
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

export async function updateMessagingDashboardPurchased(
  maloumMessageId: string,
  purchased: boolean
): Promise<CreateMessagingDashboardEntryResponse> {
  return request<CreateMessagingDashboardEntryResponse>(
    `/api/messaging-dashboard/${encodeURIComponent(maloumMessageId)}/purchased`,
    {
      method: 'PATCH',
      body: JSON.stringify({ purchased }),
    }
  );
}

// --- 4based ---

export interface ConnectFourBasedInput {
  accountId: string;
  email: string;
  password: string;
  proxyUrl: string;
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
      proxyUrl: input.proxyUrl,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.username ? { username: input.username } : {}),
    }),
  });
}

export async function reconnectFourBasedAccount(
  creatorId: string,
  input: { email: string; password: string; proxyUrl: string }
): Promise<{ creator: Creator }> {
  return request(`/api/creators/${creatorId}/4based/reconnect`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listFourBasedChats(
  creatorId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<{ chats: FourBasedChat[]; providerUserId: string }> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return request(
    `/api/creators/${creatorId}/4based/chats${query ? `?${query}` : ''}`
  );
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

export async function sendFourBasedPpv(
  creatorId: string,
  chatId: string,
  payload: {
    message: string;
    vaultId: string;
    vaultGuid?: string;
    priceCoins: number;
    localId?: string;
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
  fanId: string,
  options: { limit?: number; offset?: number; tag?: string } = {}
): Promise<{ items: FourBasedVaultItem[]; providerUserId: string }> {
  const params = new URLSearchParams({ fanId });
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  if (options.tag) params.set('tag', options.tag);
  return request(`/api/creators/${creatorId}/4based/vault?${params.toString()}`);
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

