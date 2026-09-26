import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, RotateCcw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import type { CodexFingerprintMode, DiscardAccount, DiscardUsageSyncResult } from '@/api/types';
import { DISCARD_USAGE_REASON_LABELS } from '@/api/types';
import { BalanceTag } from '@/components/balance-tag';
import { Badge } from '@/components/ui/badge';
import { CODEX_FINGERPRINT_MODE_OPTIONS } from '@/components/codex-fingerprint-mode-select';
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
import { batchCount, runChunked } from '@/lib/batch';
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

/**
 * 封号时 Codex 指纹收敛档位的紧凑标签（表内用，宽度有限）。
 * 完整文案（含「默认」「风险」等说明）在悬浮提示里复用上传弹窗那份
 * CODEX_FINGERPRINT_MODE_OPTIONS，避免两处文案漂移。
 */
const FINGERPRINT_LABELS: Record<CodexFingerprintMode, string> = {
  off: '关闭（透传）',
  device: '仅设备',
  session: '设备+会话',
  full: '完全收敛',
};

/** 收敛越强越可疑：全收敛用警示色吸引眼球，透传用弱化色，一眼能看出「这批号是不是都开了收敛」。 */
const FINGERPRINT_VARIANTS: Record<CodexFingerprintMode, 'muted' | 'secondary' | 'info' | 'warning'> = {
  off: 'muted',
  device: 'secondary',
  session: 'info',
  full: 'warning',
};

function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 'YYYY-MM-DD' → 本地当天 00:00；格式不对（如手改 URL）返回 null，按「不限」处理。 */
function startOfLocalDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 废弃时间区间（本地日期，两端都含当天）→ 接口的左闭右开 ISO 区间。
 * 任一端为空即该侧不限；两端都空＝全部。起止颠倒（手改 URL）时自动对调，避免后端 422。
 */
function discardedRangeParams(fromDate: string, toDate: string) {
  let start = startOfLocalDay(fromDate);
  let endDay = startOfLocalDay(toDate);
  if (start && endDay && start > endDay) [start, endDay] = [endDay, start];
  let end: Date | null = null;
  if (endDay) {
    end = new Date(endDay);
    end.setDate(end.getDate() + 1);
  }
  return { discarded_from: start?.toISOString(), discarded_to: end?.toISOString() };
}

export function DiscardPoolPage() {
  const queryClient = useQueryClient();

  const today = useMemo(() => localDateValue(), []);
  const { values, set } = useListUrlState({
    defaults: {
      q: '',
      reason: '',
      // 默认只看今天废弃的号；清除后两端都为空＝全部时间
      discardedFrom: today,
      discardedTo: today,
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

  const discardedFrom = String(values.discardedFrom ?? '');
  const discardedTo = String(values.discardedTo ?? '');
  const reason = String(values.reason || '');
  const discardedRange = useMemo(() => discardedRangeParams(discardedFrom, discardedTo), [discardedFrom, discardedTo]);
  const hasDateRange = Boolean(discardedRange.discarded_from || discardedRange.discarded_to);
  const isTodayOnly = discardedFrom === today && discardedTo === today;

  /** 改一端时若起止颠倒，把另一端拉到同一天，保证区间始终有效 */
  const setDiscardedFrom = (next: string) =>
    set({ discardedFrom: next, discardedTo: next && discardedTo && next > discardedTo ? next : discardedTo, page: 1 });
  const setDiscardedTo = (next: string) =>
    set({ discardedFrom: next && discardedFrom && next < discardedFrom ? next : discardedFrom, discardedTo: next, page: 1 });
  const clearDateRange = () => set({ discardedFrom: '', discardedTo: '', page: 1 });

  const search = useSearchParam({
    value: String(values.q || ''),
    onChange: useCallback((next: string) => set({ q: next, page: 1 }), [set]),
  });

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['accounts', 'discard', { q: values.q, reason, discardedFrom, discardedTo, sort, page, pageSize }],
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

  const resetKey = JSON.stringify({ q: values.q, reason, discardedFrom, discardedTo, sort, page, pageSize });
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

  /** 同步 sub2api 用量：有选中只同步选中，否则同步当前筛选下待同步的账号 */
  const syncMutation = useMutation({
    // 服务端 ids 上限 500（maxItems）。「选中全部 N 条」可能几千个，一次提交会被
    // 422 校验挡下（表现为「多选不能同步」，只剩不选中的全量路径可用），故按批提交并合并结果。
    mutationFn: (vars: {
      ids?: number[];
      force?: boolean;
      filters?: { q?: string; reason?: string; discarded_from?: string; discarded_to?: string };
    }) =>
      vars.ids?.length
        ? runChunked(vars.ids, 'accounts.discardUsageSync', (chunk) =>
            accountsApi.syncDiscardUsage({ ids: chunk, force: vars.force }),
          )
        : accountsApi.syncDiscardUsage(vars),
    onSuccess: (result: DiscardUsageSyncResult) => {
      setBatchResult(buildSyncResult(result));
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // 时间区间有独立的清除按钮，这里只管搜索词与原因；两者分开，避免「清除筛选」顺手把时间也改掉
  const filtersActive = Boolean(String(values.q || '') || reason);
  const clearFilters = () => set({ reason: '', q: '', page: 1 });

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

  /**
   * 未选中时同步的范围＝当前列表筛选（q / 原因 / 废弃时间区间）。
   * 必须与徽章、按钮上那个「待同步 N」同一口径，否则按钮写 20、实际扫全池 1498。
   */
  const syncFilters = useMemo(
    () => ({
      q: String(values.q || '') || undefined,
      reason: reason || undefined,
      ...discardedRange,
    }),
    [values.q, reason, discardedRange],
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
        移回主号池后账号为「待重新授权」状态，建议先批量授权再上传。「初始余额」为导入时从邮箱余额
        初始化的值（与备用池同源，未拿到时显示「未查询」）；「已用额度」取自 sub2api 账号用量统计，
        与主号池预估剩余余额同源；「代理 IP」是废弃那一刻抓的出口代理快照（代理名 + 认证账号），
        同一个代理上死了一批号就是该 IP 被拉黑的信号 —— 搜索框支持直接搜代理名或认证账号。
        「Codex 指纹收敛」同样是**废弃那一刻**从远端账号 extra 抓的档位快照（off = 远端没开收敛），
        同一档收敛下死了一批号就是该档位可疑的信号，点表头可把同档的号聚在一起看。
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

        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span>废弃时间</span>
          <input
            type="date"
            aria-label="废弃时间起"
            value={discardedFrom}
            onChange={(event) => setDiscardedFrom(event.target.value)}
            className="h-8 rounded-md border border-input bg-card/60 px-2 text-sm"
          />
          <span>至</span>
          <input
            type="date"
            aria-label="废弃时间止"
            value={discardedTo}
            onChange={(event) => setDiscardedTo(event.target.value)}
            className="h-8 rounded-md border border-input bg-card/60 px-2 text-sm"
          />
          {!hasDateRange && <span className="text-xs">（全部）</span>}
          <Button
            variant="ghost"
            size="sm"
            onClick={clearDateRange}
            disabled={!hasDateRange}
            title="清空时间筛选，查看全部废弃账号"
          >
            <X />
            清除
          </Button>
          {!isTodayOnly && (
            <Button variant="ghost" size="sm" onClick={() => set({ discardedFrom: today, discardedTo: today, page: 1 })}>
              今天
            </Button>
          )}
        </div>

        <Button variant="outline" size="sm" onClick={clearFilters} disabled={!filtersActive}>
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
                // 选中量超过单批上限时后端要分几批（提示用，实际分片在 mutationFn 里做）
                const batches = selected ? batchCount(selection.selectedIds, 'accounts.discardUsageSync') : 1;
                if (!selected && staleCount === 0) {
                  toast.info('当前筛选下没有待同步的账号');
                  return;
                }
                const ok = window.confirm(
                  `将对${scope}账号逐个查询 sub2api 用量统计（90 天），可能需要数秒${
                    batches > 1 ? `，共分 ${batches} 批提交` : ''
                  }。是否继续？`,
                );
                if (!ok) return;
                syncMutation.mutate(selected ? { ids: selection.selectedIds, force: true } : { filters: syncFilters });
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
        emptyTitle={
          hasDateRange ? (isTodayOnly ? '今天没有废弃的账号' : '所选时间段内没有废弃的账号') : '废弃号池为空'
        }
        emptyDescription={
          hasDateRange
            ? '清除时间筛选可查看全部废弃账号'
            : '被 sub2api 监控判定 401/429 或手动废弃的账号会出现在这里'
        }
        emptyActionLabel={hasDateRange ? '清除时间筛选' : undefined}
        onEmptyAction={hasDateRange ? clearDateRange : undefined}
        filtersActive={filtersActive}
        onClearFilters={clearFilters}
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
            <SortableHead
              label="代理 IP"
              sortKey="proxy_name"
              sort={sort}
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
            <SortableHead
              label="Codex 指纹收敛"
              sortKey="codex_fingerprint_mode"
              sort={sort}
              onSort={(next) => set({ sort: serializeSort(next), page: 1 })}
            />
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
              label="初始余额"
              sortKey="initial_balance"
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
            <TableCell>
              <DiscardProxyCell account={account} />
            </TableCell>
            <TableCell>
              <DiscardCodexFingerprintCell account={account} />
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
              <BalanceTag value={account.has_balance ? account.initial_balance : null} />
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

/**
 * 废弃时的出口代理：名字 + 认证账号。
 *
 * 两截都有意义：代理名（sub2api 里的编号）说明是哪台机器，
 * 认证账号说明是这台机器上的哪条出口 —— 同一个代理服务商换一个认证账号就是另一个 IP。
 * 两个都没有时显示「—」而不是「直连」：老数据本来就没抓过，不能反推成直连。
 */
function DiscardProxyCell({ account }: { account: DiscardAccount }) {
  const name = account.proxy_name;
  const user = account.proxy_user;
  if (!name && !user) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
            —
          </span>
        </TooltipTrigger>
        <TooltipContent>
          没有这条号的出口代理记录：本列是废弃那一刻抓的快照，只在废弃时代理信息可读到才有值
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="max-w-[150px] cursor-help font-mono text-xs leading-tight">
          <div className="truncate">{name ?? `代理 #${account.proxy_id ?? '?'}`}</div>
          {user && <div className="truncate text-muted-foreground">认证账号 {user}</div>}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <div>代理名：{name ?? `代理 #${account.proxy_id ?? '?'}`}</div>
        <div>认证账号：{user ?? '未记录'}</div>
        {account.proxy_id != null && <div className="text-muted-foreground">代理 ID：{account.proxy_id}</div>}
        <div className="text-muted-foreground">
          废弃当时抓取（{formatDateTime(account.proxy_at)}）；认证账号是代理服务商那一侧的账号，不是号本身
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * 封号时的 Codex 指纹收敛档位：四档之一，或「—」（读不到）。
 *
 * 与「代理 IP」列同一个用途 —— 封号归因：同一档收敛下死了一批号，就是该档位可疑的信号。
 * 值同样是废弃那一刻从远端账号 extra 抓的快照，之后不改写（远端档位随时能被人改，
 * 事后现查得到的是「现在是什么」，与封号当时无关）。
 *
 * off 照实显示「关闭（透传）」而不是并入「—」：远端没开收敛是**确定**的结论
 * （sub2api 契约里 off 就是不写这个 extra 键），跟「没抓到」是两回事，
 * 混起来就分不清「这批号都没开收敛」和「这批号压根没抓到档位」。
 */
function DiscardCodexFingerprintCell({ account }: { account: DiscardAccount }) {
  const mode = account.codex_fingerprint_mode;
  if (!mode) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
            —
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-md">
          没有这条号的收敛档位记录：本列是废弃那一刻从 sub2api 远端账号 extra 抓的快照。
          从未上传过远端、远端账号已被删除，或远端对象不带 extra 时会取不到，不反推成「关闭」
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant={FINGERPRINT_VARIANTS[mode]} className="cursor-help">
          {FINGERPRINT_LABELS[mode]}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-md">
        <div>{CODEX_FINGERPRINT_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode}</div>
        <div className="text-muted-foreground">
          废弃当时抓取（{formatDateTime(account.codex_fingerprint_at)}），取自 sub2api 账号
          extra.codex_fingerprint_mode；之后远端改档位也不会改写这里
        </div>
      </TooltipContent>
    </Tooltip>
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
