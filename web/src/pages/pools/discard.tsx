import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import type { DiscardAccount, DiscardUsageSyncResult } from '@/api/types';
import { DISCARD_USAGE_REASON_LABELS } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { BatchResultDialog, type BatchResult } from '@/components/batch-result-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SortableHead, type SortState } from '@/components/sortable-head';
import { PaginationBar } from '@/components/data/pagination-bar';
import { ListShell, ListToolbar, ToolbarChip, ToolbarSearch, ToolbarSpacer, RefreshButton } from '@/components/data/list-shell';
import { useListUrlState, useSearchParam } from '@/hooks/use-list-url-state';
import { useLiveList } from '@/hooks/use-live-list';
import { useRowSelection } from '@/hooks/use-row-selection';
import { runChunked } from '@/lib/batch';
import { formatRelativeTime, formatDateTime } from '@/lib/utils';

const REASON_LABELS: Record<string, string> = {
  banned_401: '封禁(401)',
  rate_limited_429: '限流(429)',
  repair_failed: '修复失败',
  login_failed: '登录封禁',
  manual: '手动废弃',
};

const REASON_CHIPS: Array<{ value: keyof typeof REASON_LABELS; variant: 'danger' | 'warning' | 'muted' }> = [
  { value: 'banned_401', variant: 'danger' },
  { value: 'rate_limited_429', variant: 'warning' },
  { value: 'repair_failed', variant: 'warning' },
  { value: 'login_failed', variant: 'danger' },
  { value: 'manual', variant: 'muted' },
];

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateRangeForDay(value: string) {
  if (!value) return { discarded_from: undefined, discarded_to: undefined };
  const start = new Date(`${value}T00:00:00`);
  if (Number.isNaN(start.getTime())) return { discarded_from: undefined, discarded_to: undefined };
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { discarded_from: start.toISOString(), discarded_to: end.toISOString() };
}

export function DiscardPoolPage() {
  const queryClient = useQueryClient();

  const { values, set, reset, hasActiveFilters } = useListUrlState({
    defaults: {
      q: '',
      reason: '',
      discardedDate: localDateValue(),
      sort: 'discarded_at:desc',
      page: 1,
      page_size: 50,
    },
  });

  const page = Number(values.page) || 1;
  const pageSize = Number(values.page_size) || 50;
  const sort = useMemo<SortState | null>(() => {
    const raw = String(values.sort || '');
    if (!raw) return null;
    const [key, dir] = raw.split(':');
    return key ? { key, dir: dir === 'asc' ? 'asc' : 'desc' } : null;
  }, [values.sort]);

  const discardedDate = String(values.discardedDate || '');
  const reason = String(values.reason || '');
  const discardedRange = useMemo(() => dateRangeForDay(discardedDate), [discardedDate]);

  const search = useSearchParam({
    value: String(values.q || ''),
    onChange: useCallback((next: string) => set({ q: next, page: 1 }), [set]),
  });

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['accounts', 'discard', { q: values.q, reason, discardedDate, sort, page, pageSize }],
    queryFn: () =>
      accountsApi.list<DiscardAccount>('discard', {
        q: String(values.q || '') || undefined,
        reason: reason || undefined,
        ...discardedRange,
        sort: sort ? `${sort.key}:${sort.dir}` : undefined,
        page,
        page_size: pageSize,
      }),
    interval: 30_000,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {};

  const resetKey = JSON.stringify({ q: values.q, reason, discardedDate, sort, page, pageSize });
  const selection = useRowSelection({ items, total, resetKey });

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  // 单行操作的目标集合：不能用 selection，否则会把批量选择覆盖成单条
  const [rowTargets, setRowTargets] = useState<DiscardAccount[]>([]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'discard'] });
    queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }, [queryClient]);

  const restoreMutation = useMutation({
    mutationFn: (ids: number[]) =>
      runChunked(ids, 'accounts.batchRestore', (chunk) => accountsApi.batchRestore(chunk)),
    onSuccess: (result) => {
      toast.success(`已移回主号池 ${result.restored} 个账号（待重新授权）`);
      if (result.skipped > 0) toast.warning(`${result.skipped} 个账号不在废弃池，已跳过`);
      selection.clear();
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) =>
      runChunked(ids, 'accounts.batchDelete', (chunk) => accountsApi.batchDelete(chunk)),
    onSuccess: (result) => {
      toast.success(`已彻底删除 ${result.deleted} 个账号`);
      setDeleteOpen(false);
      setRowTargets([]);
      selection.clear();
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /** 同步 sub2api 用量：有选中只同步选中，否则按当前筛选的全部待同步项 */
  const syncMutation = useMutation({
    mutationFn: (vars: { ids?: number[]; force?: boolean }) => accountsApi.syncDiscardUsage(vars),
    onSuccess: (result: DiscardUsageSyncResult) => {
      setBatchResult(buildSyncResult(result));
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const filtersActive = Boolean(String(values.q || '') || reason || discardedDate !== localDateValue());

  const filterForIds = useMemo(
    () => ({
      pool: 'discard' as const,
      q: String(values.q || '') || undefined,
      reason: reason || undefined,
      ...discardedRange,
      sort: sort ? `${sort.key}:${sort.dir}` : undefined,
    }),
    [values.q, reason, discardedRange, sort],
  );

  /** 「选中全部 N 条」：批量接口只收 id，先取回全部 id 再按接口上限分片提交 */
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

  const exportUrl = accountsApi.exportByFilterUrl({
    ...filterForIds,
    format: 'tosub2',
  });

  const handleExport = () => {
    download(exportUrl, 'tosub2-discard.json').catch((error) => toast.error(errorMessage(error)));
  };

  const targetCount = rowTargets.length > 0 ? rowTargets.length : selection.count;
  const targetIds = rowTargets.length > 0 ? rowTargets.map((row) => row.id) : selection.selectedIds;
  const staleCount = stats.used_amount_stale ?? 0;

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-muted/60 px-4 py-2.5 text-sm text-muted-foreground">
        移回主号池后账号为「待重新授权」状态，建议先批量授权再上传。「已用额度」取自 sub2api 账号用量统计，
        与主号池预估剩余余额同源。
      </div>

      <ListToolbar>
        {REASON_CHIPS.filter((chip) => chip.value !== 'login_failed' || (stats.login_failed ?? 0) > 0).map((chip) => (
          <ToolbarChip
            key={chip.value}
            label={REASON_LABELS[chip.value]}
            count={stats[chip.value] ?? 0}
            variant={chip.variant}
            active={reason === chip.value}
            onClick={() => set({ reason: reason === chip.value ? '' : chip.value, page: 1 })}
          />
        ))}
        <ToolbarChip
          label="已用额度合计"
          variant="secondary"
          title={`${stats.used_amount_known ?? 0} 个账号有同步数据`}
        />
        <span className="tabular-nums -ml-1 text-sm font-semibold">
          ${Number(stats.used_amount_total ?? 0).toFixed(2)}
        </span>
        <span className="text-xs text-muted-foreground">（{stats.used_amount_known ?? 0} 个已知）</span>

        <ToolbarSpacer />

        <ToolbarSearch value={search.value} onChange={search.setValue} placeholder="搜索邮箱…" className="w-52" />

        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          废弃日期
          <input
            type="date"
            value={discardedDate}
            onChange={(event) => set({ discardedDate: event.target.value, page: 1 })}
            className="h-8 rounded-md border border-input bg-card/60 px-2 text-sm"
          />
        </label>
        {discardedDate && (
          <Button variant="ghost" size="sm" onClick={() => set({ discardedDate: '', page: 1 })}>
            全部日期
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => set({ reason: '', q: '', page: 1 })}
          disabled={!filtersActive}
        >
          清除筛选
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport}>
          导出当前筛选
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              variant={staleCount > 0 ? 'default' : 'outline'}
              disabled={syncMutation.isPending}
              onClick={() => {
                // 有选中 → 只同步选中的；未选中 → 同步当前筛选下待同步的账号。
                // force 只对「已选中的明确目标」使用：未选中时若全量重算，
                // 会把早已被远端删除的老号一起重扫，结果列表里全是「远端无此号」。
                const selected = selection.count > 0;
                const scope = selected ? `已选的 ${selection.count} 个` : `待同步的 ${staleCount} 个`;
                if (!selected && staleCount === 0) {
                  toast.info('当前筛选下没有待同步的账号');
                  return;
                }
                const ok = window.confirm(
                  `将对${scope}账号逐个查询 sub2api 用量统计（90 天），可能需要数秒。是否继续？`,
                );
                if (!ok) return;
                syncMutation.mutate(selected ? { ids: selection.selectedIds, force: true } : {});
              }}
            >
              {syncMutation.isPending ? '同步中…' : '同步远端用量'}
              {staleCount > 0 && !syncMutation.isPending && (
                <Badge variant="secondary" className="tabular-nums ml-1">
                  {staleCount}
                </Badge>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            读取 sub2api 管理端账号的累计已用额度并保存快照；账号被废弃时已自动抓取过一次。
            默认只同步没有快照或快照超过 24 小时的账号
          </TooltipContent>
        </Tooltip>
        <RefreshButton isRefreshing={isRefreshing} onRefresh={refresh} />
      </ListToolbar>

      <ListShell
        items={items}
        isLoading={isLoading}
        emptyIcon={Archive}
        emptyTitle={reason ? `没有「${REASON_LABELS[reason] ?? reason}」的账号` : '废弃号池为空'}
        emptyDescription={
          reason
            ? '换个原因试试，或点击当前徽章取消筛选'
            : '被 sub2api 监控判定 401/429 或手动废弃的账号会出现在这里'
        }
        filtersActive={filtersActive}
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
            <SortableHead label="废弃原因" sortKey="discard_reason" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <TableHead>详情</TableHead>
            <SortableHead
              label="加入备用池"
              sortKey="reserve_joined_at"
              sort={sort}
              firstDir="desc"
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <SortableHead
              label="加入主号池"
              sortKey="joined_main_at"
              sort={sort}
              firstDir="desc"
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <SortableHead
              label="已用额度"
              sortKey="discard_used_amount"
              sort={sort}
              firstDir="desc"
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <SortableHead
              label="废弃时间"
              sortKey="discarded_at"
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
            <TableCell className="max-w-[220px] truncate font-mono text-xs">{account.email}</TableCell>
            <TableCell>
              <StatusBadge domain="discard" value={account.discard_reason} />
            </TableCell>
            <TableCell className="max-w-[240px]">
              {account.discard_detail ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="truncate text-xs text-muted-foreground">{account.discard_detail}</div>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md">{account.discard_detail}</TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground" title={formatDateTime(account.reserve_joined_at)}>
              {formatRelativeTime(account.reserve_joined_at)}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground" title={formatDateTime(account.joined_main_at)}>
              {account.joined_main_at ? formatRelativeTime(account.joined_main_at) : '—'}
            </TableCell>
            <TableCell>
              <UsedAmountTag account={account} />
            </TableCell>
            <TableCell className="text-xs text-muted-foreground" title={formatDateTime(account.discarded_at)}>
              {formatRelativeTime(account.discarded_at)}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setRowTargets([account]);
                    restoreMutation.mutate([account.id]);
                  }}
                  disabled={restoreMutation.isPending}
                >
                  <RotateCcw />
                  移回主池
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    setRowTargets([account]);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 />
                  删除
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

      <BatchActionBar count={selection.count} onClear={selection.clear}>
        {selection.count > 0 && selection.count <= items.length && total > items.length && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => selectAllMatching.mutate()}
            disabled={selectAllMatching.isPending}
          >
            {selectAllMatching.isPending ? '加载中…' : `选中全部 ${total} 条`}
          </Button>
        )}
        {selection.count > items.length && (
          <span className="text-xs text-muted-foreground">已选中全部 {selection.count} 条筛选结果</span>
        )}
        <Button
          size="sm"
          onClick={() => restoreMutation.mutate(selection.selectedIds)}
          disabled={restoreMutation.isPending}
        >
          <RotateCcw />
          批量移回主号池
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => {
            setRowTargets([]);
            setDeleteOpen(true);
          }}
        >
          <Trash2 />
          批量删除
        </Button>
      </BatchActionBar>

      <BatchResultDialog
        result={batchResult}
        onOpenChange={(open) => !open && setBatchResult(null)}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setRowTargets([]);
        }}
        title={`删除 ${targetCount} 个账号？`}
        description={
          rowTargets.length > 0
            ? `将删除 ${rowTargets[0].email} 的账号凭据、断点与产物文件，操作不可恢复。`
            : '将同时删除账号凭据、断点与产物文件，操作不可恢复。'
        }
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(targetIds)}
      />
    </div>
  );
}

/** 已用额度：有快照显示金额 + 同步时间，无快照显示待同步提示。 */
function UsedAmountTag({ account }: { account: DiscardAccount }) {
  if (account.used_amount === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
            未同步
          </span>
        </TooltipTrigger>
        <TooltipContent>点右上角「同步远端用量」从 sub2api 读取累计已用额度</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums cursor-help font-mono text-sm text-[var(--warning)]">
          ${Number(account.used_amount).toFixed(2)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <div>同步时间：{formatDateTime(account.used_amount_at)}（{formatRelativeTime(account.used_amount_at)}）</div>
        {account.used_amount_source && <div className="text-muted-foreground">来源：{account.used_amount_source}</div>}
        <div className="text-muted-foreground">
          取自 sub2api 账号累计用量。sub2api 不提供历史时点查询，账号被废弃时已自动抓取一次
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function serializeSort(sort: SortState | null): string {
  return sort ? `${sort.key}:${sort.dir}` : '';
}

/** 把同步结果映射成统一的批量结果弹窗内容。 */
function buildSyncResult(result: DiscardUsageSyncResult): BatchResult {
  const summary = result.summary ?? {};
  const notes: string[] = [];
  const failed = result.items
    .filter((item) => item.reason)
    .map((item) => {
      const label =
        DISCARD_USAGE_REASON_LABELS[item.reason as keyof typeof DISCARD_USAGE_REASON_LABELS] ?? String(item.reason);
      // 只有「重试可能改变结果」的原因才带 id（带 id 的项会出现在「仅重试失败项」里）：
      // not_linked / remote_account_not_found 重试一百次也是同样结论
      const retryable = item.reason === 'fetch_failed' || item.reason === 'remote_used_amount_unknown';
      return {
        id: retryable ? item.id : undefined,
        label: item.email,
        // 查询失败时带上服务端返回的具体原因，便于区分「远端没有」与「sub2api 连不上」
        reason: item.detail ? `${label}：${item.detail}` : label,
      };
    });

  if (summary.not_linked) notes.push(`${summary.not_linked} 个账号从未上传 sub2api，无远端用量可查`);
  if (summary.remote_account_not_found) notes.push(`${summary.remote_account_not_found} 个账号在 sub2api 中已不存在`);
  if (summary.remote_used_amount_unknown) notes.push(`${summary.remote_used_amount_unknown} 个账号远端未提供用量字段`);
  if (summary.fetch_failed) notes.push(`${summary.fetch_failed} 个账号查询 sub2api 失败（详情见下方失败列表）`);

  return {
    action: '同步远端已用额度',
    succeeded: summary.updated ?? 0,
    failed,
    notes: [`共扫描 ${summary.scanned ?? 0} 个账号`, ...notes],
  };
}
