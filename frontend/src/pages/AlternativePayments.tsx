import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import AppLayout from '@/components/AppLayout';
import CreatorAvatar from '@/components/CreatorAvatar';
import { useConfirm } from '@/context/ConfirmDialogContext';
import {
  createAlternativePayment,
  deleteAlternativePayment,
  getAlternativePayments,
  getCreators,
  getStaff,
  updateAlternativePayment,
  type AlternativePayment,
  type AlternativePaymentMethod,
  type Creator,
  type CurrencyAmount,
  type User,
} from '@/lib/api';
import { formatLocalDateInput, formatMoney } from '@/lib/messagingDashboardFormat';
import { useStaffTimeZone } from '@/lib/berlinTime';

const inputClassName =
  'w-full px-3 py-2 text-sm border border-gray-200 dark:border-white/10 rounded-lg bg-white dark:bg-[#1a1a1a] text-gray-900 dark:text-gray-100';

const selectClassName = inputClassName;

const METHODS: { id: AlternativePaymentMethod; label: string; badge: string }[] = [
  {
    id: 'revolut',
    label: 'Revolut',
    badge: 'bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-200',
  },
  {
    id: 'amazon',
    label: 'Amazon',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200',
  },
  {
    id: 'paypal',
    label: 'PayPal',
    badge: 'bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200',
  },
  {
    id: 'bitcoin',
    label: 'Bitcoin',
    badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200',
  },
];

interface PaymentForm {
  saleDate: string;
  fanName: string;
  creatorId: string;
  chatterId: string;
  paymentMethod: AlternativePaymentMethod | '';
  amount: string;
  currency: 'EUR' | 'USD';
  notes: string;
}

function emptyForm(saleDate: string): PaymentForm {
  return {
    saleDate,
    fanName: '',
    creatorId: '',
    chatterId: '',
    paymentMethod: '',
    amount: '',
    currency: 'EUR',
    notes: '',
  };
}

function methodMeta(method: string) {
  return METHODS.find((item) => item.id === method) || null;
}

function formatCurrencyAmounts(amounts: CurrencyAmount[] | undefined): string {
  if (!amounts || amounts.length === 0) return formatMoney(0, 'EUR');
  return amounts.map((item) => formatMoney(item.amount, item.currency)).join(' · ');
}

function formatSaleDate(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default function AlternativePayments() {
  const confirm = useConfirm();
  const timeZone = useStaffTimeZone();
  const today = useMemo(() => formatLocalDateInput(new Date(), timeZone), [timeZone]);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [method, setMethod] = useState('');
  const [chatterId, setChatterId] = useState('');
  const [creatorId, setCreatorId] = useState('');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  const [payments, setPayments] = useState<AlternativePayment[]>([]);
  const [chatters, setChatters] = useState<User[]>([]);
  const [creators, setCreators] = useState<Creator[]>([]);
  const telegramCreators = useMemo(
    () => creators.filter((creator) => creator.platform === 'telegram'),
    [creators]
  );
  const [totals, setTotals] = useState<CurrencyAmount[]>([]);
  const [total, setTotal] = useState(0);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<PaymentForm>(() => emptyForm(today));
  const [saving, setSaving] = useState(false);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const loadFilterOptions = useCallback(async () => {
    const [staffResult, creatorsResult] = await Promise.all([getStaff(), getCreators()]);
    setChatters(
      staffResult.staff.filter(
        (member) => member.role === 'chatter' || member.role === 'team_leader'
      )
    );
    setCreators(creatorsResult.creators);
  }, []);

  const loadPayments = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (!options.silent) setLoading(true);
      else setRefreshing(true);
      setError(null);
      try {
        const response = await getAlternativePayments({
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          paymentMethod: (method || undefined) as AlternativePaymentMethod | undefined,
          chatterId: chatterId || undefined,
          creatorId: creatorId || undefined,
          page,
          limit,
        });
        setPayments(response.data);
        setTotals(response.totals || []);
        setTotal(response.pagination.total);
        setFrom(response.pagination.from);
        setTo(response.pagination.to);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load alternative payments');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [startDate, endDate, method, chatterId, creatorId, page, limit]
  );

  useEffect(() => {
    void loadFilterOptions().catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to load filter options');
    });
  }, [loadFilterOptions]);

  useEffect(() => {
    void loadPayments();
  }, [loadPayments]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm(today));
    setFormOpen(true);
    setError(null);
  }

  function openEdit(payment: AlternativePayment) {
    setEditingId(payment.id);
    setForm({
      saleDate: payment.saleDate,
      fanName: payment.fanName || '',
      creatorId: payment.creatorId || '',
      chatterId: payment.chatterId || '',
      paymentMethod: payment.paymentMethod,
      amount: String(payment.amount),
      currency: payment.currency,
      notes: payment.notes || '',
    });
    setFormOpen(true);
    setError(null);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(emptyForm(today));
  }

  async function handleSave() {
    const amount = Number(form.amount);
    if (!form.saleDate) {
      setError('A sale date is required');
      return;
    }
    if (!form.paymentMethod) {
      setError('A payment method is required');
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Amount must be zero or greater');
      return;
    }

    const input = {
      saleDate: form.saleDate,
      fanName: form.fanName.trim() || null,
      creatorId: form.creatorId || null,
      chatterId: form.chatterId || null,
      paymentMethod: form.paymentMethod,
      amount,
      currency: form.currency,
      notes: form.notes.trim() || null,
    };

    setSaving(true);
    setError(null);
    try {
      if (editingId) {
        await updateAlternativePayment(editingId, input);
      } else {
        await createAlternativePayment(input);
        setPage(1);
      }
      closeForm();
      await loadPayments({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save payment');
    } finally {
      setSaving(false);
    }
  }

  async function assignChatter(payment: AlternativePayment, nextChatterId: string) {
    setAssigningId(payment.id);
    setError(null);
    try {
      await updateAlternativePayment(payment.id, { chatterId: nextChatterId || null });
      if (editingId === payment.id) {
        setForm((current) => ({ ...current, chatterId: nextChatterId }));
      }
      await loadPayments({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign chatter');
    } finally {
      setAssigningId(null);
    }
  }

  async function handleDelete(payment: AlternativePayment) {
    const accepted = await confirm({
      title: `Delete ${payment.saleCode}?`,
      message: 'This removes the sale from alternative payments and from sales totals.',
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (!accepted) return;
    setError(null);
    try {
      await deleteAlternativePayment(payment.id);
      if (editingId === payment.id) closeForm();
      await loadPayments({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete payment');
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title="Alternative Payments" activePage="alternativePayments">
      <div className="space-y-0 -m-4 sm:-m-6 md:-m-8">
        <div className="flex flex-col gap-4 border-b border-gray-200 dark:border-white/10 px-6 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              Alternative Payments
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Telegram creators only. The sale is not filed as Telegram, so the full amount counts
              with no platform cut.
            </p>
          </div>
          <button
            type="button"
            onClick={openCreate}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-black"
          >
            Add sale
          </button>
        </div>

        {formOpen ? (
          <div className="border-b border-gray-200 bg-gray-50/60 px-6 py-4 dark:border-white/10 dark:bg-white/[0.02]">
            <div className="mb-3 text-sm font-medium text-gray-900 dark:text-gray-100">
              {editingId ? 'Edit sale' : 'New sale'}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Date
                </span>
                <input
                  type="date"
                  value={form.saleDate}
                  onChange={(event) => setForm((current) => ({ ...current, saleDate: event.target.value }))}
                  className={inputClassName}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Fan
                </span>
                <input
                  value={form.fanName}
                  onChange={(event) => setForm((current) => ({ ...current, fanName: event.target.value }))}
                  className={inputClassName}
                  placeholder="Optional"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Creator
                </span>
                <select
                  value={form.creatorId}
                  onChange={(event) => setForm((current) => ({ ...current, creatorId: event.target.value }))}
                  className={selectClassName}
                >
                  <option value="">Unassigned</option>
                  {telegramCreators.map((creator) => (
                    <option key={creator.id} value={creator.id}>
                      {creator.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Chatter
                </span>
                <select
                  value={form.chatterId}
                  onChange={(event) => setForm((current) => ({ ...current, chatterId: event.target.value }))}
                  className={selectClassName}
                >
                  <option value="">Unassigned</option>
                  {chatters.map((chatter) => (
                    <option key={chatter.id} value={chatter.id}>
                      {chatter.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Method
                </span>
                <select
                  value={form.paymentMethod}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      paymentMethod: event.target.value as AlternativePaymentMethod | '',
                    }))
                  }
                  className={selectClassName}
                >
                  <option value="">Select</option>
                  {METHODS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Amount
                </span>
                <div className="flex gap-2">
                  <input
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                    className={inputClassName}
                    placeholder="0.00"
                  />
                  <select
                    value={form.currency}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        currency: event.target.value === 'USD' ? 'USD' : 'EUR',
                      }))
                    }
                    className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm text-gray-900 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-100"
                  >
                    <option value="EUR">EUR</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </label>
              <label className="space-y-1 md:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  Notes
                </span>
                <input
                  value={form.notes}
                  onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
                  className={inputClassName}
                  placeholder="Session, bundle, or reference"
                />
              </label>
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving}
                className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-black"
              >
                {saving ? 'Saving...' : editingId ? 'Save changes' : 'Save sale'}
              </button>
              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-200 dark:hover:bg-white/5"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="border-b border-gray-200 bg-gray-50/60 px-6 py-4 dark:border-white/10 dark:bg-white/[0.02]">
          <div className="mb-4 flex flex-wrap items-center gap-4 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium text-gray-800 dark:text-gray-200">
              Total: {formatCurrencyAmounts(totals)}
            </span>
            <button
              type="button"
              onClick={() => void loadPayments({ silent: true })}
              disabled={refreshing}
              className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white p-2 text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-300 dark:hover:bg-white/5"
              title="Refresh"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                From
              </span>
              <input
                type="date"
                value={startDate}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setPage(1);
                }}
                className={inputClassName}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                To
              </span>
              <input
                type="date"
                value={endDate}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setPage(1);
                }}
                className={inputClassName}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Method
              </span>
              <select
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                {METHODS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Chatter
              </span>
              <select
                value={chatterId}
                onChange={(event) => {
                  setChatterId(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                <option value="unassigned">Unassigned</option>
                {chatters.map((chatter) => (
                  <option key={chatter.id} value={chatter.id}>
                    {chatter.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                Creator
              </span>
              <select
                value={creatorId}
                onChange={(event) => {
                  setCreatorId(event.target.value);
                  setPage(1);
                }}
                className={selectClassName}
              >
                <option value="">All</option>
                <option value="unassigned">Unassigned</option>
                {telegramCreators.map((creator) => (
                  <option key={creator.id} value={creator.id}>
                    {creator.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            type="button"
            onClick={() => {
              setStartDate('');
              setEndDate('');
              setMethod('');
              setChatterId('');
              setCreatorId('');
              setPage(1);
              setLimit(20);
            }}
            className="mt-4 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-200 dark:hover:bg-white/5"
          >
            Reset filters
          </button>
        </div>

        {error ? (
          <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 px-6 py-4 text-sm text-gray-500 dark:text-gray-400 md:flex-row md:items-center md:justify-between">
          <span>
            Showing {from} to {to} of {total} results
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span>Page size</span>
              <select
                value={limit}
                onChange={(event) => {
                  setLimit(Number(event.target.value));
                  setPage(1);
                }}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-100"
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1 || loading}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a]"
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages || loading}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50 dark:border-white/10 dark:bg-[#1a1a1a]"
              >
                Next
              </button>
            </div>
          </div>
        </div>

        <div className="table-scroll overflow-auto border-t border-gray-200 dark:border-white/10">
          <table className="w-full min-w-[1100px] text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500 dark:bg-white/5 dark:text-gray-400">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Sale ID</th>
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Fan</th>
                <th className="px-4 py-3 text-left font-medium">Creator</th>
                <th className="px-4 py-3 text-left font-medium">Chatter</th>
                <th className="px-4 py-3 text-left font-medium">Method</th>
                <th className="px-4 py-3 text-left font-medium">Amount</th>
                <th className="px-4 py-3 text-left font-medium">Notes</th>
                <th className="px-4 py-3 text-left font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    Loading alternative payments...
                  </td>
                </tr>
              ) : payments.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-500 dark:text-gray-400">
                    No alternative payments for the selected filters.
                  </td>
                </tr>
              ) : (
                payments.map((payment) => {
                  const badge = methodMeta(payment.paymentMethod);
                  const chatterMissing =
                    payment.chatterId &&
                    !chatters.some((chatter) => chatter.id === payment.chatterId);
                  return (
                    <tr
                      key={payment.id}
                      className="border-b border-gray-100 hover:bg-gray-50/60 dark:border-white/5 dark:hover:bg-white/[0.02]"
                    >
                      <td className="whitespace-nowrap px-4 py-3 font-medium">{payment.saleCode}</td>
                      <td className="whitespace-nowrap px-4 py-3">{formatSaleDate(payment.saleDate)}</td>
                      <td className="px-4 py-3">{payment.fanName || '--'}</td>
                      <td className="px-4 py-3">
                        {payment.creatorName ? (
                          <div className="flex min-w-[160px] items-center gap-2">
                            <CreatorAvatar
                              avatarUrl={payment.creatorAvatarUrl}
                              displayName={payment.creatorName}
                              className="h-8 w-8 shrink-0 rounded-full object-cover"
                              initialsClassName="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium dark:bg-white/10"
                            />
                            <div className="min-w-0 truncate font-medium">{payment.creatorName}</div>
                          </div>
                        ) : (
                          '--'
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={payment.chatterId || ''}
                          disabled={assigningId === payment.id}
                          onChange={(event) => void assignChatter(payment, event.target.value)}
                          className="min-w-[160px] rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-900 dark:border-white/10 dark:bg-[#1a1a1a] dark:text-gray-100"
                        >
                          <option value="">Unassigned</option>
                          {chatterMissing ? (
                            <option value={payment.chatterId || ''}>
                              {payment.chatterName || 'Assigned chatter'}
                            </option>
                          ) : null}
                          {chatters.map((chatter) => (
                            <option key={chatter.id} value={chatter.id}>
                              {chatter.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${badge?.badge || 'bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300'}`}
                        >
                          {badge?.label || payment.paymentMethod}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-medium">
                        {formatMoney(payment.amount, payment.currency)}
                      </td>
                      <td className="max-w-[280px] px-4 py-3 text-gray-600 dark:text-gray-300">
                        <span className="line-clamp-2">{payment.notes || '--'}</span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openEdit(payment)}
                          className="mr-3 text-sm text-gray-700 underline-offset-2 hover:underline dark:text-gray-200"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(payment)}
                          className="text-sm text-red-600 underline-offset-2 hover:underline dark:text-red-400"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  );
}
