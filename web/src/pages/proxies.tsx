import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity, Globe, Loader2, Pencil, Trash2, Upload, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { proxiesApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { Proxy, ProxyImportResult } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { BatchResultDialog, type BatchResult } from '@/components/batch-result-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ImportDialog } from '@/components/import-dialog';
import { FilterSelect } from '@/components/filter-select';
import { PaginationBar } from '@/components/data/pagination-bar';
import { ListShell, ListToolbar, ToolbarChip, ToolbarSearch, ToolbarSpacer, RefreshButton } from '@/components/data/list-shell';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRowSelection } from '@/hooks/use-row-selection';
import { useListUrlState, useSearchParam } from '@/hooks/use-list-url-state';
import { useLiveList } from '@/hooks/use-live-list';
import { formatRelativeTime } from '@/lib/utils';

export function ProxiesPage() {
  const queryClient = useQueryClient();

  const { values, set, reset, hasActiveFilters } = useListUrlState({
    defaults: { q: '', statusFilter: '', page: 1, page_size: 50 },
  });

  const statusFilter = String(values.statusFilter || '');
  const page = Number(values.page) || 1;
  const pageSize = Number(values.page_size) || 50;

  const search = useSearchParam({
    value: String(values.q || ''),
    onChange: useCallback((next: string) => set({ q: next, page: 1 }), [set]),
  });

  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ProxyImportResult | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  /** 单行删除目标：与批量选择分开 */
  const [rowTargets, setRowTargets] = useState<Proxy[]>([]);

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['proxies', { q: values.q, statusFilter, page, pageSize }],
    queryFn: () =>
      proxiesApi.list({
        q: String(values.q || '') || undefined,
        status: statusFilter || undefined,
        page,
        page_size: pageSize,
      }),
    // 有代理在测活时轮询更密，否则退避
    interval: 15_000,
    enabled: true,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {};
  const testing = items.filter((item) => item.status === 'testing').length;

  const resetKey = JSON.stringify({ q: values.q, statusFilter, page, pageSize });
  const selection = useRowSelection({ items, total, resetKey });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['proxies'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const importMutation = useMutation({
    mutationFn: (text: string) => proxiesApi.import(text),
    onSuccess: (result) => {
      setImportResult(result);
      setImportedCount(result.created);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const testMutation = useMutation({
    mutationFn: (ids?: number[]) => proxiesApi.test(ids?.length ? ids : undefined),
    onSuccess: (result) => {
      toast.success(`已开始测试 ${result.started} 条代理，结果稍后自动刷新`);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const labelMutation = useMutation({
    mutationFn: ({ id, label }: { id: number; label: string }) => proxiesApi.updateLabel(id, label),
    onSuccess: () => {
      setEditingId(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => proxiesApi.batchRemove(ids),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 条代理`);
      selection.clear();
      setRowTargets([]);
      setDeleteOpen(false);
      setBatchResult(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const targetCount = rowTargets.length > 0 ? rowTargets.length : selection.count;

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ToolbarChip label="可用" count={stats.alive ?? 0} variant="success" active={statusFilter === 'alive'} onClick={() => set({ statusFilter: statusFilter === 'alive' ? '' : 'alive', page: 1 })} />
        <ToolbarChip label="失效" count={stats.dead ?? 0} variant="danger" active={statusFilter === 'dead'} onClick={() => set({ statusFilter: statusFilter === 'dead' ? '' : 'dead', page: 1 })} />
        <ToolbarChip label="CF拦截" count={stats.cf_challenge ?? 0} variant="warning" active={statusFilter === 'cf_challenge'} onClick={() => set({ statusFilter: statusFilter === 'cf_challenge' ? '' : 'cf_challenge', page: 1 })} />
        <ToolbarChip label="未测" count={stats.unknown ?? 0} variant="muted" active={statusFilter === 'unknown'} onClick={() => set({ statusFilter: statusFilter === 'unknown' ? '' : 'unknown', page: 1 })} />
        {testing > 0 && (
          <Badge variant="info">
            <Loader2 className="size-3 animate-spin" /> 测试中 {testing}
          </Badge>
        )}

        <ToolbarSpacer />

        <ToolbarSearch value={search.value} onChange={search.setValue} placeholder="搜索代理/备注…" className="w-56" />
        <FilterSelect
          value={statusFilter}
          onValueChange={(value) => set({ statusFilter: value, page: 1 })}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'alive', label: '可用' },
            { value: 'dead', label: '失效' },
            { value: 'cf_challenge', label: '被 CF 拦截' },
            { value: 'unknown', label: '未测' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasActiveFilters}>
          清除筛选
        </Button>
        <Button variant="outline" size="sm" onClick={() => testMutation.mutate(undefined)} disabled={testMutation.isPending}>
          <Activity />
          测试全部连通性
        </Button>
        <Button
          size="sm"
          onClick={() => {
            setImportResult(null);
            setImportOpen(true);
          }}
        >
          <Upload />
          批量导入
        </Button>
        <RefreshButton isRefreshing={isRefreshing} onRefresh={refresh} />
      </ListToolbar>

      <ListShell
        items={items}
        isLoading={isLoading}
        emptyIcon={Globe}
        emptyTitle="代理列表为空"
        emptyDescription="导入形如 http://user:pass@host:port 的代理，可选在末尾用 ---- 追加备注"
        emptyActionLabel="导入第一批代理"
        onEmptyAction={() => setImportOpen(true)}
        filtersActive={hasActiveFilters}
        onClearFilters={reset}
        header={
          <>
            <TableHead className="w-10">
              <Checkbox checked={selection.headerState} onCheckedChange={selection.toggleAll} aria-label="全选当前页" />
            </TableHead>
            <TableHead>代理</TableHead>
            <TableHead>备注</TableHead>
            <TableHead>协议</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>延迟</TableHead>
            <TableHead>最近检测</TableHead>
            <TableHead>失败计数</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </>
        }
      >
        {items.map((proxy) => (
          <TableRow key={proxy.id} data-state={selection.isSelected(proxy.id) ? 'selected' : undefined}>
            <TableCell>
              <Checkbox
                checked={selection.isSelected(proxy.id)}
                onCheckedChange={() => selection.toggle(proxy.id)}
                aria-label={`选择 ${proxy.display_url}`}
              />
            </TableCell>
            <TableCell className="max-w-[280px] truncate font-mono text-xs">
              {proxy.display_url}
              {proxy.rotatable && <span className="ml-1.5 text-[10px] text-primary">可轮换</span>}
            </TableCell>
            <TableCell>
              {editingId === proxy.id ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={editLabel}
                    onChange={(event) => setEditLabel(event.target.value)}
                    className="h-7 w-28 text-xs"
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') labelMutation.mutate({ id: proxy.id, label: editLabel });
                      if (event.key === 'Escape') setEditingId(null);
                    }}
                  />
                  <Button size="sm" variant="ghost" onClick={() => labelMutation.mutate({ id: proxy.id, label: editLabel })}>
                    保存
                  </Button>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">{proxy.label ?? '—'}</span>
              )}
            </TableCell>
            <TableCell className="text-xs">{proxy.protocol}</TableCell>
            <TableCell>
              <StatusBadge domain="proxy" value={proxy.status} tooltip={proxy.last_error} />
            </TableCell>
            <TableCell className="tabular-nums font-mono text-xs">
              {proxy.last_latency_ms !== null && proxy.status !== 'dead' ? `${proxy.last_latency_ms}ms` : '—'}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(proxy.last_checked_at)}</TableCell>
            <TableCell>
              {proxy.fail_count > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help font-mono text-xs text-destructive">{proxy.fail_count}</span>
                  </TooltipTrigger>
                  <TooltipContent>任务运行中的连接失败累计，达到阈值自动置为失效</TooltipContent>
                </Tooltip>
              ) : (
                <span className="font-mono text-xs">0</span>
              )}
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="outline" onClick={() => testMutation.mutate([proxy.id])}>
                  <Zap />
                  测试
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingId(proxy.id);
                    setEditLabel(proxy.label ?? '');
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => {
                    setRowTargets([proxy]);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 />
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
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate(selection.selectedIds)}>
          <Activity />
          测试选中
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
          删除选中
        </Button>
      </BatchActionBar>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="批量导入代理"
        placeholder={'http://user:pass@host:port----备注（可选）\nsocks5h://user:pass@host:1080'}
        result={importResult}
        busy={importMutation.isPending}
        onSubmit={(text) => importMutation.mutate(text)}
      />
      {importedCount > 0 && !importOpen && (
        <div className="flex items-center gap-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm">
          <span className="flex-1">刚导入了 {importedCount} 条代理，要立即测试连通性吗？</span>
          <Button
            size="sm"
            onClick={() => {
              testMutation.mutate(undefined);
              setImportedCount(0);
            }}
          >
            立即测试
          </Button>
        </div>
      )}

      <BatchResultDialog result={batchResult} onOpenChange={(open) => !open && setBatchResult(null)} />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          setDeleteOpen(open);
          if (!open) setRowTargets([]);
        }}
        title={`删除 ${targetCount} 条代理？`}
        description={
          rowTargets.length > 0
            ? `将删除 ${rowTargets[0].display_url} 及其备注，操作不可恢复。`
            : '删除后已绑定这些代理的任务会退回本机直连（或按严格模式直接失败），操作不可恢复。'
        }
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(rowTargets.length > 0 ? rowTargets.map((proxy) => proxy.id) : selection.selectedIds)}
      />
    </div>
  );
}
