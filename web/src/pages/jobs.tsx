import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Download, ListChecks, Loader2, RotateCcw, Send, Trash2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { jobsApi, proxiesApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import { STAGE_LABELS, isBannedJobError } from '@/api/types';
import type { Job } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ListShell, ListToolbar, ToolbarChip, ToolbarSearch, ToolbarSpacer, RefreshButton } from '@/components/data/list-shell';
import { FilterSelect } from '@/components/filter-select';
import { LogViewer } from '@/components/log-viewer';
import { PaginationBar } from '@/components/data/pagination-bar';
import { useListUrlState, useSearchParam } from '@/hooks/use-list-url-state';
import { useLiveList } from '@/hooks/use-live-list';
import { formatDateTime, formatRelativeTime } from '@/lib/utils';

const TYPE_LABELS: Record<string, string> = {
  login: '登录',
  balance: '余额',
};

const STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  { value: 'active', label: '进行中' },
  { value: 'awaiting_input', label: '待输入' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
];

export function JobsPage() {
  const queryClient = useQueryClient();
  const { values, set, reset, hasActiveFilters } = useListUrlState({
    defaults: { status: '', type: '', q: '', page: 1, page_size: 50 },
  });

  const statusTab = String(values.status || '');
  const typeFilter = String(values.type || '');
  const page = Number(values.page) || 1;
  const pageSize = Number(values.page_size) || 50;

  const search = useSearchParam({
    value: String(values.q || ''),
    onChange: useCallback((next: string) => set({ q: next, page: 1 }), [set]),
  });

  const [expanded, setExpanded] = useState<string | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [cleanupDays, setCleanupDays] = useState('30');

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['jobs', { statusTab, typeFilter, q: values.q, page, pageSize }],
    queryFn: () =>
      jobsApi.list({
        status: statusTab || undefined,
        type: typeFilter || undefined,
        q: String(values.q || '') || undefined,
        page,
        page_size: pageSize,
      }),
    interval: 2000,
  });

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // 筛选/清理导致总页数缩小时，把当前页拉回范围内
  useEffect(() => {
    if (page > totalPages) set({ page: totalPages });
  }, [page, totalPages, set]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['jobs'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    // 取消/重试会改账号状态（joining → mail_failed、authorizing → needs_reauth）：号池列表若不失效，
    // 备用池会继续显示「加入中」并禁用「加入主号池」，看起来像任务没被取消掉。
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    queryClient.invalidateQueries({ queryKey: ['sub2api'] });
  }, [queryClient]);

  const cleanupMutation = useMutation({
    mutationFn: (days: number) => jobsApi.cleanup(days),
    onSuccess: (result) => {
      toast.success(result.deleted > 0 ? `已清理 ${result.deleted} 条任务` : '没有符合条件的任务');
      setCleanupOpen(false);
      setExpanded(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) => jobsApi.cancel(id),
    onSuccess: () => {
      toast.success('任务已取消');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const retryMutation = useMutation({
    mutationFn: (vars: { id: string; proxyId?: number }) => jobsApi.retry(vars.id, vars.proxyId),
    onSuccess: () => {
      toast.success('重试任务已创建');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const cancelAllMutation = useMutation({
    mutationFn: () => jobsApi.cancelAll(),
    onSuccess: (result) => {
      toast.success(`已取消 ${result.canceled} 个任务`);
      setCancelAllOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const stats = data?.stats ?? { queued: 0, running: 0, awaiting_input: 0 }; // awaiting_input 仅历史任务

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ToolbarChip label="排队" count={stats.queued} variant="muted" active={statusTab === 'queued'} onClick={() => set({ status: statusTab === 'queued' ? '' : 'queued', page: 1 })} />
        <ToolbarChip label="进行中" count={stats.running} variant="info" active={statusTab === 'running'} onClick={() => set({ status: statusTab === 'running' ? '' : 'running', page: 1 })} />
        <ToolbarSpacer />

        <ToolbarSearch value={search.value} onChange={search.setValue} placeholder="搜索邮箱…" className="w-52" />
        <FilterSelect
          value={typeFilter}
          onValueChange={(value) => set({ type: value, page: 1 })}
          label="全部类型"
          className="w-[124px]"
          options={[
            { value: 'login', label: '登录' },
            { value: 'balance', label: '余额' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasActiveFilters}>
          清除筛选
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>
          <Trash2 />
          清理
        </Button>
        <Button variant="destructive" size="sm" onClick={() => setCancelAllOpen(true)}>
          <XCircle />
          取消全部
        </Button>
        <RefreshButton isRefreshing={isRefreshing} onRefresh={refresh} />
      </ListToolbar>

      <div className="flex flex-wrap gap-1 border-b">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => set({ status: tab.value, page: 1 })}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              statusTab === tab.value
                ? 'border-primary font-medium text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <ListShell
        items={items}
        isLoading={isLoading}
        emptyIcon={ListChecks}
        emptyTitle="暂无任务"
        emptyDescription="从号池发起加入/授权/余额查询后，任务会出现在这里"
        filtersActive={hasActiveFilters}
        onClearFilters={reset}
        header={
          <>
            <TableHead className="w-8" />
            <TableHead>邮箱</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>尝试</TableHead>
            <TableHead>代理</TableHead>
            <TableHead>开始时间</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </>
        }
      >
        {items.map((job) => (
          <JobRow
            key={job.id}
            job={job}
            expanded={expanded === job.id}
            onToggle={() => setExpanded((prev) => (prev === job.id ? null : job.id))}
            onCancel={() => cancelMutation.mutate(job.id)}
            onRetry={(proxyId) => retryMutation.mutate({ id: job.id, proxyId })}
            busy={cancelMutation.isPending || retryMutation.isPending}
          />
        ))}
      </ListShell>

      <PaginationBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={(next) => set({ page: next })}
        onPageSizeChange={(next) => set({ page_size: next, page: 1 })}
      />

      <ConfirmDialog
        open={cancelAllOpen}
        onOpenChange={setCancelAllOpen}
        title="取消全部活跃任务？"
        description="排队、进行中、等待输入的任务都会被取消。"
        confirmText="全部取消"
        busy={cancelAllMutation.isPending}
        onConfirm={() => cancelAllMutation.mutate()}
      />

      <Dialog open={cleanupOpen} onOpenChange={setCleanupOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>清理历史任务</DialogTitle>
            <DialogDescription>
              任务默认全部保留。输入天数，早于该天数结束的任务（含日志与产物文件）将被删除，进行中的任务不受影响。
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-3 px-1">
            <span className="text-sm">清理</span>
            <Input
              type="number"
              min={0}
              value={cleanupDays}
              onChange={(event) => setCleanupDays(event.target.value)}
              className="w-24"
            />
            <span className="text-sm">天前结束的任务</span>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanupOpen(false)} disabled={cleanupMutation.isPending}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={cleanupMutation.isPending || cleanupDays.trim() === '' || Number(cleanupDays) < 0 || !Number.isInteger(Number(cleanupDays))}
              onClick={() => cleanupMutation.mutate(Number(cleanupDays))}
            >
              {cleanupMutation.isPending ? '清理中…' : '清理'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function JobRow({
  job,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  busy,
}: {
  job: Job;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: (proxyId?: number) => void;
  busy: boolean;
}) {
  const queryClient = useQueryClient();

  /** 展开时按需拉详情：列表只带 error_summary，完整 error 在详情接口 */
  const detail = useQuery({
    queryKey: ['jobs', job.id, 'detail'],
    queryFn: () => jobsApi.get(job.id),
    enabled: expanded,
  });

  /** 待输入的号：重试时可换一个存活代理 */
  const aliveProxies = useQuery({
    queryKey: ['proxies', 'alive-options'],
    queryFn: () => proxiesApi.list({ status: 'alive', page_size: 200 }),
    enabled: expanded && job.can_retry && job.status === 'failed',
    staleTime: 60_000,
  });

  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-1 hover:bg-muted"
            aria-label={expanded ? '收起详情' : '展开详情'}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </button>
        </TableCell>
        <TableCell className="max-w-[200px] truncate font-mono text-xs">{job.email ?? '—'}</TableCell>
        <TableCell className="text-xs">{TYPE_LABELS[job.type] ?? job.type}</TableCell>
        <TableCell>
          <div className="flex items-center gap-1.5">
            <StatusBadge domain="job" value={job.status} />
            {job.status === 'failed' && isBannedJobError(job.error ?? job.error_summary) ? (
              <Badge variant="danger">账号封禁/停用</Badge>
            ) : (
              job.stage && <span className="text-xs text-muted-foreground">{STAGE_LABELS[job.stage] ?? job.stage}</span>
            )}
          </div>
        </TableCell>
        <TableCell className="tabular-nums text-xs">{job.attempt}</TableCell>
        <TableCell className="max-w-[160px] truncate font-mono text-xs text-muted-foreground">
          {job.proxy_display ?? '本机直连'}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground" title={formatDateTime(job.started_at)}>
          {formatRelativeTime(job.started_at ?? job.created_at)}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-1">
            {job.can_cancel && (
              <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
                取消
              </Button>
            )}
            {job.can_retry && job.status !== 'completed' && (
              <Button size="sm" variant="outline" onClick={() => onRetry()} disabled={busy}>
                <RotateCcw />
                重试
              </Button>
            )}
            {job.status === 'completed' && job.has_result && (
              <Button size="sm" variant="outline" onClick={() => download(`/jobs/${job.id}/result`, `${job.id}.json`)}>
                <Download />
                产物
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-muted/30 p-4">
            <div className="space-y-3">
              {job.has_error && (
                <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  错误：{detail.data?.error ?? job.error_summary}
                  {!detail.data && detail.isLoading && <span className="ml-1 text-muted-foreground">（加载完整错误…）</span>}
                </div>
              )}

              {job.status === 'failed' && job.can_retry && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-3">
                  <span className="text-sm text-muted-foreground">换代理重试：</span>
                  <FilterSelect
                    value=""
                    onValueChange={(value) => onRetry(value ? Number(value) : undefined)}
                    label="使用随机存活代理"
                    className="w-[260px]"
                    options={(aliveProxies.data?.items ?? [])
                      .slice(0, 50)
                      .map((proxy) => ({
                        value: String(proxy.id),
                        label: `#${proxy.id} ${proxy.label ?? proxy.display_url}`,
                      }))}
                  />
                  <span className="text-xs text-muted-foreground">
                    出错任务在选路失败时会反复用同一条代理，指定一条更稳的能显著提高成功率
                  </span>
                </div>
              )}

              <LogViewer jobId={job.id} status={job.status} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
