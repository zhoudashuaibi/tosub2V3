import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Archive, CloudDownload, Coins, Download, KeyRound, Loader2, Plus, RefreshCw, Trash2, Upload, Users } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi, sub2apiApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import type {
  CodexFingerprintMode,
  MainAccount,
  MainBalanceEstimate,
  Sub2ApiConfigView,
  UploadOptions,
  UploadOrder,
} from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { BalanceTag } from '@/components/balance-tag';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { BatchResultDialog, type BatchResult } from '@/components/batch-result-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  CODEX_FINGERPRINT_MODE_HINT,
  CodexFingerprintModeSelect,
  normalizeCodexFingerprintMode,
} from '@/components/codex-fingerprint-mode-select';
import { ListShell, ListToolbar, ToolbarChip, ToolbarSearch, ToolbarSpacer, RefreshButton } from '@/components/data/list-shell';
import { FilterSelect } from '@/components/filter-select';
import { PaginationBar } from '@/components/data/pagination-bar';
import { SortableHead, type SortState } from '@/components/sortable-head';
import { useRowSelection } from '@/hooks/use-row-selection';
import { useListUrlState, useSearchParam } from '@/hooks/use-list-url-state';
import { useLiveList } from '@/hooks/use-live-list';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UploadOrderSelect, useOrderPreference } from '@/components/upload-order-select';
import { formatRelativeTime } from '@/lib/utils';

export function MainPoolPage() {
  const queryClient = useQueryClient();

  const { values, set, reset, hasActiveFilters } = useListUrlState({
    defaults: { q: '', statusFilter: '', remoteFilter: '', uploadedOnly: 0, sort: '', page: 1, page_size: 50 },
  });

  const statusFilter = String(values.statusFilter || '');
  const remoteFilter = String(values.remoteFilter || '');
  const uploadedOnly = Number(values.uploadedOnly) === 1;
  const page = Number(values.page) || 1;
  const pageSize = Number(values.page_size) || 50;

  const sort = useMemo<SortState | null>(() => {
    const raw = String(values.sort || '');
    if (!raw) return null;
    const [key, dir] = raw.split(':');
    return key ? { key, dir: dir === 'asc' ? 'asc' : 'desc' } : null;
  }, [values.sort]);

  const search = useSearchParam({
    value: String(values.q || ''),
    onChange: (next) => set({ q: next, page: 1 }),
  });

  const [uploadOpen, setUploadOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [estimate, setEstimate] = useState<MainBalanceEstimate | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  /** 单行操作的目标：与批量选择分开，避免点行内按钮时把已选的多条覆盖成一条 */
  const [rowTargets, setRowTargets] = useState<MainAccount[]>([]);

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['accounts', 'main', { q: values.q, statusFilter, remoteFilter, uploadedOnly, sort, page, pageSize }],
    queryFn: () =>
      accountsApi.list<MainAccount>('main', {
        q: String(values.q || '') || undefined,
        status: statusFilter || undefined,
        remote_status: remoteFilter || undefined,
        uploaded: uploadedOnly ? 'true' : undefined,
        sort: sort ? `${sort.key}:${sort.dir}` : undefined,
        page,
        page_size: pageSize,
      }),
    interval: 10_000,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {};

  const resetKey = JSON.stringify({ q: values.q, statusFilter, remoteFilter, uploadedOnly, sort, page, pageSize });
  const selection = useRowSelection({ items, total, resetKey });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const authorizeMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchAuthorize(ids),
    onSuccess: (result) => {
      setBatchResult({
        action: '批量授权',
        succeeded: result.started,
        skipped: result.skipped.map((skip) => ({ label: `#${skip.id}`, reason: skip.reason })),
      });
      selection.clear();
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const balanceMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchRefreshBalance(ids),
    onSuccess: (result) => {
      toast.success(`已发起 ${result.started} 个余额查询任务`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const estimateMutation = useMutation({
    mutationFn: () => accountsApi.mainBalanceEstimate(),
    onSuccess: (result) => setEstimate(result),
    onError: (error) => toast.error(errorMessage(error)),
  });

  const syncRemoteMutation = useMutation({
    mutationFn: () => sub2apiApi.syncRemote(),
    onSuccess: (result) => {
      const parts = [`新关联 ${result.linked}`, `状态更新 ${result.status_updated}`];
      if (result.unlinked) parts.push(`解除 ${result.unlinked}`);
      if (result.duplicates) parts.push(`远端重复 ${result.duplicates}`);
      const text = `远端同步完成（扫描 ${result.scanned}）：${parts.join('，')}`;
      if (result.duplicates) toast.warning(`${text}。重复账号的孤儿副本不会再被回推凭据，建议清理`);
      else toast.success(text);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const discardMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchDiscard(ids),
    onSuccess: (result) => {
      toast.success(`已废弃 ${result.discarded} 个账号`);
      selection.clear();
      setRowTargets([]);
      setDiscardOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => accountsApi.batchDelete(ids),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 个账号`);
      selection.clear();
      setRowTargets([]);
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const uploadMutation = useMutation({
    mutationFn: ({ ids, options, order }: { ids: number[]; options?: UploadOptions; order?: UploadOrder }) =>
      accountsApi.batchUpload(ids, options, order),
    onSuccess: (result) => {
      setBatchResult({
        action: '上传到 sub2api',
        succeeded: result.created + result.updated,
        notes: [`新增 ${result.created} 条，替换 ${result.updated} 条`],
        failed: result.failed.map((item) => ({
          id: item.id,
          label: item.email ?? `#${item.id}`,
          reason: item.error,
        })),
      });
      selection.clear();
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'monitor'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /** 「选中全部 N 条」：批量接口只收 id，先从后端取回全部 id */
  const filterForIds = useMemo(
    () => ({
      pool: 'main' as const,
      q: String(values.q || '') || undefined,
      status: statusFilter || undefined,
      remote_status: remoteFilter || undefined,
      uploaded: uploadedOnly ? 'true' : undefined,
      sort: sort ? `${sort.key}:${sort.dir}` : undefined,
    }),
    [values.q, statusFilter, remoteFilter, uploadedOnly, sort],
  );

  const selectAllMatching = useMutation({
    mutationFn: () => accountsApi.idsByFilter(filterForIds),
    onSuccess: (result) => {
      selection.replace(result.ids);
      if (result.truncated) {
        toast.warning(`筛选结果超过 ${result.ids.length} 条，已选中前 ${result.ids.length} 条`);
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const selectedBalance = items.filter((account) => selection.isSelected(account.id)).reduce((sum, account) => sum + (account.balance ?? 0), 0);
  const targetCount = rowTargets.length > 0 ? rowTargets.length : selection.count;
  const targetIds = rowTargets.length > 0 ? rowTargets.map((account) => account.id) : selection.selectedIds;

  return (
    <div className="space-y-4">
      <ListToolbar>
        {(
          [
            { value: 'active', label: '可用', variant: 'success' },
            { value: 'authorizing', label: '授权中', variant: 'info' },
            { value: 'needs_reauth', label: '待重授', variant: 'warning' },
          ] as const
        ).map((chip) => (
          <ToolbarChip
            key={chip.value}
            label={chip.label}
            count={stats[chip.value] ?? 0}
            variant={chip.variant}
            active={statusFilter === chip.value}
            onClick={() => set({ statusFilter: statusFilter === chip.value ? '' : chip.value, page: 1 })}
          />
        ))}
        <ToolbarChip
          label="已上传"
          count={stats.uploaded ?? 0}
          variant="secondary"
          active={uploadedOnly}
          onClick={() => set({ uploadedOnly: uploadedOnly ? 0 : 1, page: 1 })}
        />
        <ToolbarChip label="总余额" variant="muted" />
        <span className="tabular-nums -ml-1 text-sm font-semibold">
          ${Number(stats.total_balance ?? 0).toFixed(2)}
        </span>

        <ToolbarSpacer />

        <ToolbarSearch value={search.value} onChange={search.setValue} placeholder="搜索邮箱…" className="w-52" />
        <FilterSelect
          value={statusFilter}
          onValueChange={(value) => set({ statusFilter: value, page: 1 })}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'active', label: '可用' },
            { value: 'authorizing', label: '授权中' },
            { value: 'needs_reauth', label: '待重新授权' },
          ]}
        />
        <FilterSelect
          value={remoteFilter}
          onValueChange={(value) => set({ remoteFilter: value, page: 1 })}
          label="全部远端"
          className="w-[132px]"
          options={[
            { value: 'active', label: '远端可用' },
            { value: 'abnormal', label: '远端异常' },
            { value: 'not_uploaded', label: '未上传' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasActiveFilters}>
          清除筛选
        </Button>
        <Button variant="outline" size="sm" disabled={estimateMutation.isPending} onClick={() => estimateMutation.mutate()}>
          {estimateMutation.isPending ? <Loader2 className="animate-spin" /> : <Coins />}
          预估剩余余额
        </Button>
        <Button variant="outline" size="sm" disabled={syncRemoteMutation.isPending} onClick={() => syncRemoteMutation.mutate()}>
          {syncRemoteMutation.isPending ? <Loader2 className="animate-spin" /> : <CloudDownload />}
          同步远端
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          添加账号
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            download(
              selection.count > 0 && selection.count <= 500
                ? accountsApi.exportUrl({ ids: selection.selectedIds, format: 'tosub2' })
                : accountsApi.exportByFilterUrl({ ...filterForIds, format: 'tosub2' }),
              'tosub2-accounts.json',
            ).catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Download />
          {selection.count > 0 ? `导出所选 (${selection.count})` : '导出账号'}
        </Button>
        <RefreshButton isRefreshing={isRefreshing} onRefresh={refresh} />
      </ListToolbar>

      <ListShell
        items={items}
        isLoading={isLoading}
        emptyIcon={Users}
        emptyTitle="主号池为空"
        emptyDescription="从备用号池「加入主号池」完成邮箱验证码登录，或手动添加账号"
        filtersActive={hasActiveFilters}
        onClearFilters={reset}
        header={
          <>
            <TableHead className="w-10">
              <Checkbox
                checked={selection.headerState}
                onCheckedChange={selection.toggleAll}
                aria-label="全选当前页"
              />
            </TableHead>
            <SortableHead label="邮箱" sortKey="email" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="状态" sortKey="status" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="余额" sortKey="balance" sort={sort} firstDir="desc" onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="远端状态" sortKey="remote_status" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead
              label="上传时间"
              sortKey="sub2api_uploaded_at"
              sort={sort}
              firstDir="desc"
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <SortableHead
              label="最近登录"
              sortKey="last_login_at"
              sort={sort}
              firstDir="desc"
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <TableHead className="text-right">操作</TableHead>
          </>
        }
      >
        {items.map((account) => (
          <TableRow key={account.id} data-state={selection.isSelected(account.id) ? 'selected' : undefined}>
            <TableCell>
              <Checkbox
                checked={selection.isSelected(account.id)}
                onCheckedChange={() => selection.toggle(account.id)}
                aria-label={`选择 ${account.email}`}
              />
            </TableCell>
            <TableCell className="max-w-[240px] truncate font-mono text-xs">
              {account.status === 'needs_reauth' && <span className="mr-1 text-[var(--warning)]">⚠</span>}
              {account.email}
              {account.has_password && <Badge variant="secondary" className="ml-2 py-0 font-sans">密码</Badge>}
              {account.has_2fa && <Badge variant="info" className="ml-2 py-0 font-sans">2FA</Badge>}
            </TableCell>
            <TableCell>
              <StatusBadge domain="main" value={account.status} />
            </TableCell>
            <TableCell>
              <BalanceTag value={account.balance} checkedAt={account.balance_checked_at} error={account.balance_error} />
            </TableCell>
            <TableCell>
              {account.sub2api_account_id ? (
                account.remote_status === 'active' ? (
                  <Badge variant="success">● active</Badge>
                ) : (
                  <Badge variant="danger">● {account.remote_status}</Badge>
                )
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.sub2api_uploaded_at)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.last_login_at)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRowTargets([account]);
                    setUploadOpen(true);
                  }}
                >
                  上传
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={account.status === 'authorizing'}
                  onClick={() => authorizeMutation.mutate([account.id])}
                >
                  <KeyRound />
                  重新授权
                </Button>
                <Button size="sm" variant="ghost" onClick={() => balanceMutation.mutate([account.id])}>
                  <RefreshCw />
                  查余额
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    setRowTargets([account]);
                    setDiscardOpen(true);
                  }}
                >
                  <Archive />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </ListShell>

      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(next) => set({ page: next })}
        onPageSizeChange={(next) => set({ page_size: next, page: 1 })}
      />

      <BatchActionBar
        count={selection.count}
        extra={`合计余额 $${selectedBalance.toFixed(2)}`}
        onClear={selection.clear}
      >
        {selection.count > 0 && selection.count <= items.length && total > items.length && (
          <Button size="sm" variant="ghost" onClick={() => selectAllMatching.mutate()} disabled={selectAllMatching.isPending}>
            {selectAllMatching.isPending ? '加载中…' : `选中全部 ${total} 条`}
          </Button>
        )}
        {selection.count > items.length && (
          <span className="text-xs text-muted-foreground">已选中全部 {selection.count} 条筛选结果</span>
        )}
        <Button size="sm" onClick={() => authorizeMutation.mutate(selection.selectedIds)} disabled={authorizeMutation.isPending}>
          {authorizeMutation.isPending && <Loader2 className="animate-spin" />}
          批量授权
        </Button>
        <Button size="sm" onClick={() => setUploadOpen(true)}>
          <Upload />
          批量上传 sub2api
        </Button>
        <Button size="sm" variant="outline" onClick={() => balanceMutation.mutate(selection.selectedIds)}>
          <Coins />
          批量获取余额
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            download(
              accountsApi.exportUrl({ ids: selection.selectedIds, format: 'tosub2' }),
              'tosub2-accounts.json',
            ).catch((error) => toast.error(errorMessage(error)))
          }
        >
          <Download />
          导出账号
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download(accountsApi.exportUrl({ ids: selection.selectedIds, format: 'sub2api' }), 'sub2api-import.json')}
        >
          导出(sub2api)
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => download(accountsApi.exportUrl({ ids: selection.selectedIds, format: 'source' }), 'accounts-source.txt')}
        >
          导出(原始资料)
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => {
            setRowTargets([]);
            setDiscardOpen(true);
          }}
        >
          批量废弃
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() => {
            setRowTargets([]);
            setDeleteOpen(true);
          }}
        >
          <Trash2 />
        </Button>
      </BatchActionBar>

      <BatchResultDialog result={batchResult} onOpenChange={(open) => !open && setBatchResult(null)} />

      <UploadConfigDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        count={targetCount}
        busy={uploadMutation.isPending}
        onUpload={(options, order) => uploadMutation.mutate({ ids: targetIds, options, order })}
      />

      <AddAccountDialog open={addOpen} onOpenChange={setAddOpen} />

      <BalanceEstimateDialog estimate={estimate} onOpenChange={(open) => !open && setEstimate(null)} />

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={(open) => {
          setDiscardOpen(open);
          if (!open) setRowTargets([]);
        }}
        title={`废弃 ${targetCount} 个账号？`}
        description="账号将移入废弃号池并记录原因，可随时移回主号池。"
        confirmText="废弃"
        busy={discardMutation.isPending}
        onConfirm={() => discardMutation.mutate(targetIds)}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setRowTargets([]);
        }}
        title={`删除 ${targetCount} 个账号？`}
        description="将同时删除凭据、断点与产物文件，操作不可恢复。"
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(targetIds)}
      />
    </div>
  );
}

function serializeSort(sort: SortState | null): string {
  return sort ? `${sort.key}:${sort.dir}` : '';
}

function BalanceEstimateDialog({
  estimate,
  onOpenChange,
}: {
  estimate: MainBalanceEstimate | null;
  onOpenChange: (open: boolean) => void;
}) {
  const reasonLabel: Record<string, string> = {
    not_uploaded: '未上传到 Sub2API',
    remote_account_not_found: 'Sub2API 中未找到账号',
    initial_balance_unknown: '初始化余额未知',
    remote_used_amount_unknown: 'Sub2API 未提供明确已用金额',
  };
  const unknownItems = estimate?.items.filter((item) => item.reason) ?? [];
  return (
    <Dialog open={Boolean(estimate)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>主号池预估剩余余额</DialogTitle>
          <DialogDescription>
            使用 Sub2API 管理端账号统计中的累计费用减去本地初始化余额（统计最近 90 天），不会调用 OpenAI 余额接口或刷新账号授权。
          </DialogDescription>
        </DialogHeader>
        {estimate && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">预估剩余</div><div className="text-xl font-semibold">${estimate.total_estimated_remaining.toFixed(2)}</div></div>
              <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">可计算账号</div><div className="text-xl font-semibold">{estimate.calculable_count}</div></div>
              <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">未知账号</div><div className="text-xl font-semibold">{estimate.unknown_count}</div></div>
            </div>
            {unknownItems.length > 0 && (
              <div className="max-h-64 space-y-1 overflow-auto rounded-md border p-3 text-sm">
                {unknownItems.map((item) => (
                  <div key={item.id} className="flex justify-between gap-3">
                    <span className="truncate font-mono">{item.email}</span>
                    <span className="shrink-0 text-muted-foreground">{reasonLabel[item.reason ?? ''] ?? '无法计算'}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="text-xs text-muted-foreground">本地初始化余额缺失时，使用 Sub2API 账号名末尾的 `---N` 整数美元后缀；该后缀来自上传时的邮件余额。</div>
            <div className="text-xs text-muted-foreground">查询时间：{new Date(estimate.queried_at).toLocaleString()}</div>
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UploadConfigDialog({
  open,
  onOpenChange,
  count,
  busy,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  busy: boolean;
  onUpload: (options: UploadOptions, order?: UploadOrder) => void;
}) {
  const { data: config } = useQuery({
    queryKey: ['sub2api', 'config'],
    queryFn: () => sub2apiApi.config(),
    enabled: open,
  });
  const { data: groups } = useQuery({
    queryKey: ['sub2api', 'groups'],
    queryFn: () => sub2apiApi.groups(),
    enabled: open,
    retry: false,
  });
  const { data: remoteProxies } = useQuery({
    queryKey: ['sub2api', 'proxies'],
    queryFn: () => sub2apiApi.proxies(),
    enabled: open,
    retry: false,
  });

  const defaults = config?.upload_defaults ?? {};
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [concurrency, setConcurrency] = useState('');
  const [loadFactor, setLoadFactor] = useState('');
  const [priority, setPriority] = useState('');
  const [modelWhitelist, setModelWhitelist] = useState('');
  const [autoSelectProxy, setAutoSelectProxy] = useState(true);
  const [proxyId, setProxyId] = useState('');
  const [disable5h, setDisable5h] = useState(false);
  const [disable7d, setDisable7d] = useState(false);
  const [longContextBilling, setLongContextBilling] = useState(true);
  const [codexFingerprintMode, setCodexFingerprintMode] = useState<CodexFingerprintMode>('off');
  const [loaded, setLoaded] = useState(false);
  const [order, setOrder] = useOrderPreference('pools.mainUploadOrder');

  useEffect(() => {
    if (open && config && !loaded) {
      setGroupIds(config.group_ids ?? []);
      setDisable5h(Boolean(defaults.disable_auto_pause_5h));
      setDisable7d(Boolean(defaults.disable_auto_pause_7d));
      setLongContextBilling(defaults.enable_long_context_billing !== false);
      setCodexFingerprintMode(normalizeCodexFingerprintMode(defaults.codex_fingerprint_mode));
      setAutoSelectProxy(defaults.auto_select_proxy !== false);
      setConcurrency(defaults.concurrency != null ? String(defaults.concurrency) : '');
      setLoadFactor(defaults.load_factor != null ? String(defaults.load_factor) : '');
      setPriority(defaults.priority != null ? String(defaults.priority) : '');
      setModelWhitelist((defaults.model_whitelist ?? []).join(', '));
      setProxyId(defaults.proxy_id != null ? String(defaults.proxy_id) : '');
      setLoaded(true);
    }
    if (!open) setLoaded(false);
  }, [open, config, defaults, loaded]);

  if (open && config && !config.base_url) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>尚未配置 sub2api</DialogTitle>
            <DialogDescription>请先完成 sub2api 连接配置后再上传账号。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button asChild>
              <Link to="/sub2api">前去配置</Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>上传 {count} 个账号到 sub2api</DialogTitle>
          <DialogDescription>已存在的账号将替换凭据，不存在的将新增</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label>分组（留空 = 默认分组）</Label>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
              {(groups?.items ?? []).length === 0 && <span className="text-xs text-muted-foreground">无可用分组（或连接未配置）</span>}
              {(groups?.items ?? []).map((group) => (
                <label key={group.id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={groupIds.includes(group.id)}
                    onCheckedChange={() =>
                      setGroupIds((prev) => (prev.includes(group.id) ? prev.filter((g) => g !== group.id) : [...prev, group.id]))
                    }
                  />
                  {group.name} (#{group.id})
                </label>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>上传顺序</Label>
            <UploadOrderSelect value={order} onValueChange={setOrder} size="default" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label>并发数（留空保留原值）</Label>
              <Input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} placeholder="10" />
            </div>
            <div className="space-y-1.5">
              <Label>负载因子</Label>
              <Input value={loadFactor} onChange={(e) => setLoadFactor(e.target.value)} placeholder="1" />
            </div>
            <div className="space-y-1.5">
              <Label>优先级（留空按余额分档）</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="余额分档" />
              <p className="text-xs text-muted-foreground">留空时：≤10 刀 → 40，11-19 刀 → 20，20-39 刀 → 30，≥40 刀 → 10</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>模型白名单（逗号分隔，留空不限制）</Label>
            <Input value={modelWhitelist} onChange={(e) => setModelWhitelist(e.target.value)} placeholder="gpt-5, gpt-5-mini" />
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={autoSelectProxy} onCheckedChange={setAutoSelectProxy} />
              自动绑定 sub2api 内绑定数最少的代理
            </label>
            {!autoSelectProxy && (
              <Select value={proxyId || '__none__'} onValueChange={(value) => setProxyId(value === '__none__' ? '' : value)}>
                <SelectTrigger className="w-full" aria-label="指定上传代理">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="__none__">不指定代理</SelectItem>
                    {(remoteProxies?.items ?? []).map((proxy) => (
                      <SelectItem key={proxy.id} value={String(proxy.id)}>
                        #{proxy.id} {proxy.name} ({proxy.host}:{proxy.port})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex flex-wrap gap-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={disable5h} onCheckedChange={setDisable5h} />
              禁用 5h 自动暂停
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={disable7d} onCheckedChange={setDisable7d} />
              禁用 7d 自动暂停
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={longContextBilling} onCheckedChange={setLongContextBilling} />
              API 长上下文计费
            </label>
          </div>
          <div className="space-y-1.5">
            <Label>Codex 指纹收敛</Label>
            <CodexFingerprintModeSelect value={codexFingerprintMode} onValueChange={setCodexFingerprintMode} />
            <p className="text-xs text-muted-foreground">{CODEX_FINGERPRINT_MODE_HINT}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              onUpload({
                group_ids: groupIds,
                concurrency: concurrency === '' ? null : Number(concurrency),
                load_factor: loadFactor === '' ? null : Number(loadFactor),
                priority: priority === '' ? null : Number(priority),
                model_whitelist: modelWhitelist
                  .split(',')
                  .map((m) => m.trim())
                  .filter(Boolean),
                auto_select_proxy: autoSelectProxy,
                proxy_id: proxyId ? Number(proxyId) : null,
                disable_auto_pause_5h: disable5h,
                disable_auto_pause_7d: disable7d,
                enable_long_context_billing: longContextBilling,
                codex_fingerprint_mode: codexFingerprintMode,
              }, order || undefined)
            }
          >
            {busy && <Loader2 className="animate-spin" />}
            上传
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddAccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mailApiUrl, setMailApiUrl] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpPickupCode, setTotpPickupCode] = useState('');
  const [outlookPassword, setOutlookPassword] = useState('');
  const [outlookClientId, setOutlookClientId] = useState('');
  const [outlookRefreshToken, setOutlookRefreshToken] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { email };
      if (password) body.password = password;
      if (mailApiUrl) body.mail_api_url = mailApiUrl;
      if (totpSecret) body.totp_secret = totpSecret;
      if (totpPickupCode) body.totp_pickup_code = totpPickupCode;
      if (outlookRefreshToken) {
        body.outlook = {
          password: outlookPassword,
          client_id: outlookClientId,
          refresh_token: outlookRefreshToken,
        };
      }
      return accountsApi.create(body);
    },
    onSuccess: (result) => {
      toast.success(`账号已创建，登录任务已发起（${result.job_id.slice(0, 8)}…）`);
      onOpenChange(false);
      setEmail('');
      setPassword('');
      setMailApiUrl('');
      setTotpSecret('');
      setTotpPickupCode('');
      setOutlookPassword('');
      setOutlookClientId('');
      setOutlookRefreshToken('');
      queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>手动添加账号（进主号池）</DialogTitle>
          <DialogDescription>至少提供一项凭据；创建后自动发起登录任务</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label>邮箱 *</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="a@b.com" />
          </div>
          <div className="space-y-1.5">
            <Label>登录密码</Label>
            <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="（可选）" />
          </div>
          <div className="space-y-1.5">
            <Label>收码 API 地址</Label>
            <Input value={mailApiUrl} onChange={(e) => setMailApiUrl(e.target.value)} placeholder="（可选）https://…" />
          </div>
          <div className="space-y-1.5">
            <Label>2FA 密钥（Base32）</Label>
            <Input value={totpSecret} onChange={(e) => setTotpSecret(e.target.value)} placeholder="（可选）" />
          </div>
          <div className="space-y-1.5">
            <Label>2FA 取件码（在线取码，如 2fa.show）</Label>
            <Input value={totpPickupCode} onChange={(e) => setTotpPickupCode(e.target.value)} placeholder="（可选）CBCLDAV22HRBZUDELLKNRPK4L3YJ25IQ" />
          </div>
          <div className="space-y-1.5 rounded-md border p-3">
            <Label className="text-muted-foreground">Outlook 凭据（可选，用于自动收码）</Label>
            <Input value={outlookPassword} onChange={(e) => setOutlookPassword(e.target.value)} placeholder="邮箱密码" className="mt-2" />
            <Input value={outlookClientId} onChange={(e) => setOutlookClientId(e.target.value)} placeholder="clientId (UUID)" className="mt-2" />
            <Input value={outlookRefreshToken} onChange={(e) => setOutlookRefreshToken(e.target.value)} placeholder="refresh_token" className="mt-2" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !email.includes('@')}>
            {create.isPending && <Loader2 className="animate-spin" />}
            创建并登录
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
