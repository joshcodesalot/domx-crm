import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Shield, Users } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import StaffCredentialsModal from '@/components/StaffCredentialsModal';
import { useAuth } from '@/context/AuthContext';
import {
  assignStaffRole,
  activateStaff,
  createStaff,
  deactivateStaff,
  deleteStaff,
  getAssignableRoles,
  getPermissions,
  getRoles,
  getStaff,
  resetStaffPassword,
  updateRolePermissions,
  type Permission,
  type Role,
  type User,
} from '@/lib/api';

type Tab = 'staff' | 'matrix';

interface StaffFormState {
  name: string;
  email: string;
  role: string;
}

interface CredentialsState {
  email: string;
  tempPassword: string;
  title: string;
}

const EMPTY_FORM: StaffFormState = {
  name: '',
  email: '',
  role: 'chatter',
};

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500';

const selectClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const tableSelectClassName =
  'text-sm px-2 py-1 border border-gray-200 dark:border-white/10 rounded bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

function formatDate(value: string | null): string {
  if (!value) return 'Never';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusBadgeClass(status: string): string {
  return status === 'active'
    ? 'bg-green-100 text-green-700 dark:bg-green-500/10 dark:text-green-400'
    : 'bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-400';
}

export default function ManageStaff() {
  const { user, hasPermission } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('staff');
  const [staff, setStaff] = useState<User[]>([]);
  const [assignableRoles, setAssignableRoles] = useState<Role[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [dirtyRoles, setDirtyRoles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [credentials, setCredentials] = useState<CredentialsState | null>(null);
  const [form, setForm] = useState<StaffFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const canCreate = hasPermission('staff.create');
  const canEdit = hasPermission('staff.edit');
  const canAssignRole = hasPermission('staff.assign_role');
  const canDeactivate = hasPermission('staff.deactivate');
  const canDelete = hasPermission('staff.delete');
  const canViewMatrix = hasPermission('roles.view');
  const canManageMatrix = hasPermission('roles.manage');

  const loadStaff = useCallback(async () => {
    const [{ staff: staffList }, rolesRes] = await Promise.all([
      getStaff(),
      getAssignableRoles(),
    ]);
    setStaff(staffList);
    setAssignableRoles(rolesRes.roles);
  }, []);

  const loadMatrix = useCallback(async () => {
    const [rolesRes, permsRes] = await Promise.all([getRoles(), getPermissions()]);
    setRoles(rolesRes.roles);
    setPermissions(permsRes.permissions);
    const nextMatrix: Record<string, string[]> = {};
    for (const role of rolesRes.roles) {
      nextMatrix[role.slug] = [...(role.permissions || [])];
    }
    setMatrix(nextMatrix);
    setDirtyRoles(new Set());
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        await loadStaff();
        if (canViewMatrix) {
          await loadMatrix();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [loadStaff, loadMatrix, canViewMatrix]);

  const permissionsByCategory = useMemo(() => {
    const grouped: Record<string, Permission[]> = {};
    for (const perm of permissions) {
      if (!grouped[perm.category]) grouped[perm.category] = [];
      grouped[perm.category].push(perm);
    }
    return grouped;
  }, [permissions]);

  function toggleMatrixPermission(roleSlug: string, permSlug: string) {
    if (!canManageMatrix) return;
    if (roleSlug === 'owner' && permSlug === 'roles.manage') return;

    setMatrix((prev) => {
      const current = prev[roleSlug] || [];
      const has = current.includes(permSlug);
      const next = has
        ? current.filter((p) => p !== permSlug)
        : [...current, permSlug];

      return { ...prev, [roleSlug]: next };
    });
    setDirtyRoles((prev) => new Set(prev).add(roleSlug));
  }

  async function handleCreateStaff(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { user: createdUser, tempPassword } = await createStaff(form);
      setShowAddModal(false);
      setForm(EMPTY_FORM);
      setCredentials({
        email: createdUser.email,
        tempPassword,
        title: 'Staff Created',
      });
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create staff');
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword(staffId: string, staffName: string, staffEmail: string) {
    if (
      !confirm(
        `Reset password for ${staffName}? They will need to set a new password on next login.`
      )
    ) {
      return;
    }

    setError(null);
    try {
      const { tempPassword } = await resetStaffPassword(staffId);
      setCredentials({
        email: staffEmail,
        tempPassword,
        title: 'Password Reset',
      });
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    }
  }

  async function handleRoleChange(staffId: string, role: string) {
    setError(null);
    try {
      await assignStaffRole(staffId, role);
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign role');
    }
  }

  async function handleDeactivate(staffId: string) {
    if (!confirm('Deactivate this staff member?')) return;
    setError(null);
    try {
      await deactivateStaff(staffId);
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deactivate staff');
    }
  }

  async function handleActivate(staffId: string) {
    setError(null);
    try {
      await activateStaff(staffId);
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate staff');
    }
  }

  async function handleDelete(staffId: string, staffName: string) {
    if (!confirm(`Permanently delete ${staffName}? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteStaff(staffId);
      await loadStaff();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete staff');
    }
  }

  async function handleSaveMatrix() {
    setSaving(true);
    setError(null);
    try {
      for (const roleSlug of dirtyRoles) {
        await updateRolePermissions(roleSlug, matrix[roleSlug] || []);
      }
      await loadMatrix();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppLayout title="Manage Staff" activePage="staff">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h2 className="text-2xl font-semibold mb-1">Manage Staff</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Manage team members and role permissions
          </p>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2 mb-6 border-b border-gray-200 dark:border-white/10">
          <button
            type="button"
            onClick={() => setActiveTab('staff')}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === 'staff'
                ? 'border-gray-900 dark:border-white text-gray-900 dark:text-white'
                : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
            }`}
          >
            <Users className="w-4 h-4" />
            Staff List
          </button>
          {canViewMatrix && (
            <button
              type="button"
              onClick={() => setActiveTab('matrix')}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === 'matrix'
                  ? 'border-gray-900 dark:border-white text-gray-900 dark:text-white'
                  : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              }`}
            >
              <Shield className="w-4 h-4" />
              Permission Matrix
            </button>
          )}
        </div>

        {loading ? (
          <div className="border border-gray-200 dark:border-white/10 rounded-lg p-12 text-center">
            <p className="text-sm text-gray-400">Loading...</p>
          </div>
        ) : activeTab === 'staff' ? (
          <div>
            {canCreate && (
              <div className="mb-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90 transition-opacity"
                >
                  <Plus className="w-4 h-4" />
                  Add Staff
                </button>
              </div>
            )}

            <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5">
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Email</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Role</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Last Login</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map((member) => (
                    <tr
                      key={member.id}
                      className="border-b border-gray-100 dark:border-white/5 last:border-0"
                    >
                      <td className="px-4 py-3 font-medium">{member.name}</td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">{member.email}</td>
                      <td className="px-4 py-3">
                        {canAssignRole && member.id !== user?.id ? (
                          <select
                            value={member.role}
                            onChange={(e) => handleRoleChange(member.id, e.target.value)}
                            className={tableSelectClassName}
                          >
                            {assignableRoles.map((role) => (
                              <option
                                key={role.slug}
                                value={role.slug}
                                className="bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100"
                              >
                                {role.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs bg-gray-100 dark:bg-white/10">
                            {member.roleName}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs ${statusBadgeClass(member.status)}`}>
                          {member.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {formatDate(member.lastLoginAt)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {member.id !== user?.id && (
                          <div className="flex items-center justify-end gap-2">
                            {canEdit && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleResetPassword(member.id, member.name, member.email)
                                }
                                className="px-2 py-1 text-xs rounded border border-blue-200 dark:border-blue-500/30 text-blue-700 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10"
                              >
                                Reset Password
                              </button>
                            )}
                            {member.status === 'active' && canDeactivate && (
                              <button
                                type="button"
                                onClick={() => handleDeactivate(member.id)}
                                className="px-2 py-1 text-xs rounded border border-amber-200 dark:border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10"
                              >
                                Deactivate
                              </button>
                            )}
                            {member.status === 'inactive' && canDeactivate && (
                              <button
                                type="button"
                                onClick={() => handleActivate(member.id)}
                                className="px-2 py-1 text-xs rounded border border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-500/10"
                              >
                                Activate
                              </button>
                            )}
                            {canDelete && (
                              <button
                                type="button"
                                onClick={() => handleDelete(member.id, member.name)}
                                className="px-2 py-1 text-xs rounded border border-red-200 dark:border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
                              >
                                Delete
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                  {staff.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                        No staff members found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div>
            {canManageMatrix && dirtyRoles.size > 0 && (
              <div className="mb-4 flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveMatrix}
                  disabled={saving}
                  className="px-4 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            )}

            <div className="border border-gray-200 dark:border-white/10 rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/5">
                    <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400 sticky left-0 bg-gray-50 dark:bg-[#111]">
                      Permission
                    </th>
                    {roles.map((role) => (
                      <th
                        key={role.slug}
                        className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap"
                      >
                        {role.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(permissionsByCategory).map(([category, perms]) => (
                    <Fragment key={category}>
                      <tr className="bg-gray-50/50 dark:bg-white/[0.02]">
                        <td
                          colSpan={roles.length + 1}
                          className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-gray-400"
                        >
                          {category}
                        </td>
                      </tr>
                      {perms.map((perm) => (
                        <tr
                          key={perm.slug}
                          className="border-b border-gray-100 dark:border-white/5"
                        >
                          <td className="px-4 py-3 sticky left-0 bg-white dark:bg-[#0a0a0a]">
                            <div className="font-medium">{perm.name}</div>
                            <div className="text-xs text-gray-400">{perm.slug}</div>
                          </td>
                          {roles.map((role) => {
                            const checked = (matrix[role.slug] || []).includes(perm.slug);
                            const locked =
                              role.slug === 'owner' && perm.slug === 'roles.manage';
                            const editable = canManageMatrix && !locked;

                            return (
                              <td key={role.slug} className="px-4 py-3 text-center">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={!editable}
                                  onChange={() => toggleMatrixPermission(role.slug, perm.slug)}
                                  className="w-4 h-4 rounded border-gray-300 dark:border-white/20 disabled:opacity-50"
                                  title={
                                    locked
                                      ? 'Owner must retain roles.manage'
                                      : perm.description || perm.name
                                  }
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            {!canManageMatrix && (
              <p className="mt-4 text-xs text-gray-400">
                You have read-only access to the permission matrix.
              </p>
            )}
          </div>
        )}

        {credentials && (
          <StaffCredentialsModal
            email={credentials.email}
            tempPassword={credentials.tempPassword}
            title={credentials.title}
            onClose={() => setCredentials(null)}
          />
        )}

        {showAddModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white dark:bg-[#111] rounded-lg border border-gray-200 dark:border-white/10 w-full max-w-md p-6">
              <h3 className="text-lg font-semibold mb-4">Add Staff Member</h3>
              <form onSubmit={handleCreateStaff} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    required
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className={inputClassName}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                    Role
                  </label>
                  <select
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value })}
                    className={selectClassName}
                  >
                    {assignableRoles.map((role) => (
                      <option
                        key={role.slug}
                        value={role.slug}
                        className="bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100"
                      >
                        {role.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddModal(false);
                      setForm(EMPTY_FORM);
                    }}
                    className="flex-1 px-4 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg hover:bg-gray-50 dark:hover:bg-white/5"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 px-4 py-2 text-sm font-medium bg-gray-900 dark:bg-white text-white dark:text-black rounded-lg hover:opacity-90 disabled:opacity-50"
                  >
                    {saving ? 'Creating...' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
