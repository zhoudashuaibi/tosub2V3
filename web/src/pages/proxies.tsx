import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Globe, Loader2, Pencil, Search, Trash2, Upload, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { proxiesApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { Proxy, ProxyImportResult } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { ImportDialog } from '@/components/import-dialog';
import { FilterSelect } from '@/components/filter-select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelativeTime } from '@/lib/utils';

export function ProxiesPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ProxyImportResult | null>(null);
  const [importedCount, setImportedCount] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['proxies', { q, statusFilter }],
    queryFn: () => proxiesApi.list({ q: q || undefined, status: statusFilter || undefined, page_size: 500 }),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? [];
      return items.some((p) => p.status === 'testing') ? 3000 : 30000;
    },
    placeholderData: keepPreviousData,
  });

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
      toast.success(`已开始测试 ${result.started} 条代理，结果稍后刷新`);
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
      setSelected(new Set());
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const items = data?.items ?? [];
  const stats = data?.stats ?? {};
  const selectedIds = useMemo(() => [...selected], [selected]);
  const testing = items.filter((i) => i.status === 'testing').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success">可用 {stats.alive ?? 0}</Badge>
        <Badge variant="danger">失效 {stats.dead ?? 0}</Badge>
        <Badge variant="warning">CF拦截 {stats.cf_challenge ?? 0}</Badge>
        <Badge variant="muted">未测 {stats.unknown ?? 0}</Badge>
        {testing > 0 && <Badge variant="info"><Loader2 className="h-3 w-3 animate-spin" /> 测试中 {testing}</Badge>}
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索代理/备注…" className="h-6 w-52 pl-8" />
        </div>
        <FilterSelect
          value={statusFilter}
          onValueChange={setStatusFilter}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'alive', label: '可用' },
            { value: 'dead', label: '失效' },
            { value: 'cf_challenge', label: '被 CF 拦截' },
            { value: 'unknown', label: '未测' },
          ]}
        />
        <Button variant="outline" size="sm" onClick={() => testMutation.mutate(undefined)} disabled={testMutation.isPending}>
          <Activity />
          测试全部连通性
        </Button>
        <Button size="sm" onClick={() => { setImportResult(null); setImportOpen(true); }}>
          <Upload />
          批量导入
        </Button>
      </div>

      <div className="rounded-lg border bg-card">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Globe}
            title="代理列表为空"
            actionLabel="导入第一批代理"
            onAction={() => setImportOpen(true)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={selected.size === items.length}
                    onCheckedChange={() =>
                      setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.id))))
                    }
                  />
                </TableHead>
                <TableHead>代理</TableHead>
                <TableHead>备注</TableHead>
                <TableHead>协议</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>延迟</TableHead>
                <TableHead>最近检测</TableHead>
                <TableHead>失败计数</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((proxy) => (
                <TableRow key={proxy.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(proxy.id)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(proxy.id)) next.delete(proxy.id);
                          else next.add(proxy.id);
                          return next;
                        })
                      }
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
                          onChange={(e) => setEditLabel(e.target.value)}
                          className="h-7 w-28 text-xs"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') labelMutation.mutate({ id: proxy.id, label: editLabel });
                            if (e.key === 'Escape') setEditingId(null);
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
                  <TableCell className="font-mono text-xs">
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
                        <Zap className="h-3.5 w-3.5" />
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
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => {
                          setSelected(new Set([proxy.id]));
                          setDeleteOpen(true);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <BatchActionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="outline" onClick={() => testMutation.mutate(selectedIds)}>
          <Activity />
          测试选中
        </Button>
        <Button size="sm" variant="destructive" onClick={() => setDeleteOpen(true)}>
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

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`删除 ${selected.size} 条代理？`}
        confirmText="删除"
        busy={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(selectedIds)}
      />
    </div>
  );
}
