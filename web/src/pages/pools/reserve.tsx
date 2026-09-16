import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Inbox, Loader2, Pencil, RefreshCw, Trash2, Upload, Download } from 'lucide-react';
import { toast } from 'sonner';
import { accountsApi } from '@/api';
import { download, errorMessage } from '@/api/client';
import type { ImportResult, ReserveAccount } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { BalanceTag } from '@/components/balance-tag';
import { StatusBadge } from '@/components/status-badge';
import { BatchActionBar } from '@/components/batch-action-bar';
import { BatchResultDialog, type BatchResult } from '@/components/batch-result-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ImportDialog } from '@/components/import-dialog';
import { CredentialsEditDialog } from '@/components/credentials-edit-dialog';
import { FilterSelect } from '@/components/filter-select';
import { PaginationBar } from '@/components/data/pagination-bar';
import { ListShell, ListToolbar, ToolbarChip, ToolbarSearch, ToolbarSpacer, RefreshButton } from '@/components/data/list-shell';
import { SortableHead, type SortState } from '@/components/sortable-head';
import { UploadOrderSelect, useOrderPreference } from '@/components/upload-order-select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useRowSelection } from '@/hooks/use-row-selection';
import { useListUrlState, useSearchParam } from '@/hooks/use-list-url-state';
import { useLiveList } from '@/hooks/use-live-list';
import { runChunked } from '@/lib/batch';
import { formatRelativeTime } from '@/lib/utils';

export function ReservePoolPage() {
  const queryClient = useQueryClient();

  const { values, set, reset, hasActiveFilters } = useListUrlState({
    defaults: { q: '', statusFilter: '', quickFilter: '', sort: '', page: 1, page_size: 50 },
  });

  const statusFilter = String(values.statusFilter || '');
  const quickFilter = String(values.quickFilter || '') as '' | 'available' | 'banned' | 'no_balance';
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
    onChange: useCallback((next: string) => set({ q: next, page: 1 }), [set]),
  });

  const [importOpen, setImportOpen] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // 「查看详情」重开导入框时还原上次导入文本，保证收编/强制重提交可用
  const [lastImportText, setLastImportText] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<ReserveAccount | null>(null);
  const [joinOrder, setJoinOrder] = useOrderPreference('pools.reserveJoinOrder');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  /** 单行操作目标：与批量选择分开 */
  const [rowTargets, setRowTargets] = useState<ReserveAccount[]>([]);

  const { data, isLoading, isRefreshing, refresh } = useLiveList({
    queryKey: ['accounts', 'reserve', { q: values.q, statusFilter, quickFilter, sort, page, pageSize }],
    queryFn: () =>
      accountsApi.list<ReserveAccount>('reserve', {
        q: String(values.q || '') || undefined,
        status: statusFilter || undefined,
        available: quickFilter === 'available' ? 'true' : undefined,
        banned: quickFilter === 'banned' ? 'true' : undefined,
        has_balance: quickFilter === 'no_balance' ? 'false' : undefined,
        sort: sort ? `${sort.key}:${sort.dir}` : undefined,
        page,
        page_size: pageSize,
      }),
    interval: 10_000,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const stats = data?.stats ?? {};

  const resetKey = JSON.stringify({ q: values.q, statusFilter, quickFilter, sort, page, pageSize });
  const selection = useRowSelection({ items, total, resetKey });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['accounts', 'reserve'] });
    queryClient.invalidateQueries({ queryKey: ['accounts', 'main'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const importMutation = useMutation({
    // force/收编标记走 mutate 变量而非组件状态：避免 setState 后立即 mutate 读到旧值的竞态
    mutationFn: (vars: { text: string; forceDiscard?: boolean; forceRemote?: boolean; adoptRemote?: boolean }) =>
      accountsApi.import(vars.text, {
        force_discard: vars.forceDiscard,
        force_remote: vars.forceRemote,
        adopt_remote: vars.adoptRemote,
      }),
    onSuccess: (result) => {
      setImportResult(result);
      const adoptedCount = result.adopted_remote?.length ?? 0;
      const directMainCount = (result.main_created ?? 0) - adoptedCount;
      const reserveCount = result.created - (result.main_created ?? 0);
      const parts = [];
      if (directMainCount > 0) parts.push(`${directMainCount} 个账号直入主号池（含登录 tokens）`);
      if (adoptedCount > 0) parts.push(`${adoptedCount} 个远端账号已收编进主号池（不重新登录）`);
      if (reserveCount > 0) parts.push(`${reserveCount} 个账号已开始邮件初始化`);
      if (parts.length) toast.success(parts.join('，'));
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const [forceJoin, setForceJoin] = useState<{ ids: number[]; bannedCount: number } | null>(null);

  const joinMutation = useMutation({
    mutationFn: ({ ids, force }: { ids: number[]; force?: boolean }) =>
      accountsApi.joinMain(ids, joinOrder || undefined, force),
    onSuccess: (result) => {
      setBatchResult({
        action: '加入主号池',
        succeeded: result.started.length,
        skipped: result.skipped.map((skip) => ({ label: `#${skip.id}`, reason: skip.reason })),
      });
      selection.clear();
      setForceJoin(null);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // 选中里含封禁号时先确认，确认后 force 加入并清除封禁标记
  const tryJoin = (accounts: ReserveAccount[]) => {
    const bannedCount = accounts.filter((account) => account.banned).length;
    const ids = accounts.map((account) => account.id);
    if (bannedCount > 0) setForceJoin({ ids, bannedCount });
    else joinMutation.mutate({ ids });
  };

  const refreshMailMutation = useMutation({
    // 后端只有单条刷新接口：这里按并发 10 分批并发，避免选 200 条时打出 200 个并发请求
    mutationFn: (ids: number[]) => refreshMailBatched(ids),
    onSuccess: () => {
      toast.success('已开始重新拉取邮件');
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => runChunked(ids, 'accounts.batchDelete', (chunk) => accountsApi.batchDelete(chunk)),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 个账号`);
      selection.clear();
      setRowTargets([]);
      setDeleteOpen(false);
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  /** 「选中全部 N 条」：批量接口只收 id，先从后端取回全部 id */
  const filterForIds = useMemo(
    () => ({
      pool: 'reserve' as const,
      q: String(values.q || '') || undefined,
      status: statusFilter || undefined,
      available: quickFilter === 'available' ? 'true' : undefined,
      banned: quickFilter === 'banned' ? 'true' : undefined,
      has_balance: quickFilter === 'no_balance' ? 'false' : undefined,
      sort: sort ? `${sort.key}:${sort.dir}` : undefined,
    }),
    [values.q, statusFilter, quickFilter, sort],
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

  const selectedBalance = useMemo(
    () => items.filter((account) => selection.isSelected(account.id) && account.has_balance).reduce((sum, account) => sum + (account.initial_balance ?? 0), 0),
    [items, selection],
  );

  const targetCount = rowTargets.length > 0 ? rowTargets.length : selection.count;
  const targetIds = rowTargets.length > 0 ? rowTargets.map((account) => account.id) : selection.selectedIds;

  return (
    <div className="space-y-4">
      <ListToolbar>
        <ToolbarChip label="总数" count={total} variant="muted" />
        {(
          [
            { value: 'available', label: '可用', variant: 'success' },
            { value: 'banned', label: '已封禁', variant: 'danger' },
            { value: 'no_balance', label: '无余额', variant: 'warning' },
          ] as const
        ).map((chip) => (
          <ToolbarChip
            key={chip.value}
            label={chip.label}
            count={stats[chip.value] ?? 0}
            variant={chip.variant}
            active={quickFilter === chip.value}
            onClick={() => {
              set({ quickFilter: quickFilter === chip.value ? '' : chip.value, statusFilter: '', page: 1 });
            }}
          />
        ))}
        <ToolbarChip label="加入中" count={stats.joining ?? 0} variant="info" />
        <ToolbarChip label="总余额" variant="muted" />
        <span className="tabular-nums -ml-1 text-sm font-semibold">
          ${Number(stats.total_balance ?? 0).toFixed(2)}
        </span>
        <span className="text-xs text-muted-foreground">（{stats.with_balance ?? 0} 个已知余额）</span>

        <ToolbarSpacer />

        <ToolbarSearch value={search.value} onChange={search.setValue} placeholder="搜索邮箱…" className="w-52" />
        <FilterSelect
          value={statusFilter}
          onValueChange={(value) => set({ statusFilter: value, quickFilter: '', page: 1 })}
          label="全部状态"
          className="w-[132px]"
          options={[
            { value: 'mail_pending', label: '待初始化' },
            { value: 'mail_ok', label: '就绪' },
            { value: 'mail_failed', label: '初始化失败' },
            { value: 'joining', label: '加入中' },
          ]}
        />
        <Button variant="ghost" size="sm" onClick={reset} disabled={!hasActiveFilters}>
          清除筛选
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Upload />
          导入账号
        </Button>
        <RefreshButton isRefreshing={isRefreshing} onRefresh={refresh} />
      </ListToolbar>

      <ListShell
        items={items}
        isLoading={isLoading}
        emptyIcon={Inbox}
        emptyTitle="备用号池为空"
        emptyDescription="导入 sub2api 账号导出 JSON（notes 含邮箱四段信息、ChatGPT 密码、两步验证），系统将自动补全凭据并初始化余额与封禁状态"
        emptyActionLabel="导入第一批账号"
        onEmptyAction={() => setImportOpen(true)}
        filtersActive={hasActiveFilters}
        onClearFilters={reset}
        header={
          <>
            <TableHead className="w-10">
              <Checkbox checked={selection.headerState} onCheckedChange={selection.toggleAll} aria-label="全选当前页" />
            </TableHead>
            <SortableHead label="邮箱" sortKey="email" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="初始余额" sortKey="balance" sort={sort} firstDir="desc" onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="封禁状态" sortKey="banned" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="邮件状态" sortKey="mail_status" sort={sort} onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="导入时间" sortKey="imported_at" sort={sort} firstDir="desc" onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
            <SortableHead label="检查时间" sortKey="last_checked_at" sort={sort} firstDir="desc" onSort={(next) => set({ sort: serializeSort(next), page: 1 })} />
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
              {account.banned ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help text-destructive">🔒 {account.email}</span>
                  </TooltipTrigger>
                  <TooltipContent>{account.banned_reason ?? '已封禁'}</TooltipContent>
                </Tooltip>
              ) : (
                account.email
              )}
              {account.has_password && <Badge variant="secondary" className="ml-2 py-0 font-sans">密码</Badge>}
              {account.has_2fa && <Badge variant="info" className="ml-2 py-0 font-sans">2FA</Badge>}
              {account.status === 'joining' && (
                <Link to="/jobs" className="ml-2 text-xs text-primary hover:underline">
                  查看任务 →
                </Link>
              )}
            </TableCell>
            <TableCell>
              <BalanceTag value={account.has_balance ? account.initial_balance : null} />
            </TableCell>
            <TableCell>
              {account.banned ? <Badge variant="danger">已封禁</Badge> : <span className="text-muted-foreground">—</span>}
            </TableCell>
            <TableCell>
              <MailStatusBadge account={account} />
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.imported_at)}</TableCell>
            <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.last_checked_at)}</TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={account.status === 'joining'}
                  onClick={() => tryJoin([account])}
                >
                  {account.banned ? '强制加入' : '加入主号池'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditAccount(account)}>
                  <Pencil />
                  编辑
                </Button>
                <Button size="sm" variant="ghost" onClick={() => refreshMailMutation.mutate([account.id])}>
                  重新检查
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

      <BatchActionBar
        count={selection.count}
        onClear={selection.clear}
        extra={`合计余额 $${selectedBalance.toFixed(2)}`}
      >
        {selection.count > 0 && selection.count <= items.length && total > items.length && (
          <Button size="sm" variant="ghost" onClick={() => selectAllMatching.mutate()} disabled={selectAllMatching.isPending}>
            {selectAllMatching.isPending ? '加载中…' : `选中全部 ${total} 条`}
          </Button>
        )}
        {selection.count > items.length && (
          <span className="text-xs text-muted-foreground">已选中全部 {selection.count} 条筛选结果</span>
        )}
        <UploadOrderSelect value={joinOrder} onValueChange={setJoinOrder} />
        <Button
          size="sm"
          onClick={() => {
            // 用当前选择里的账号对象判断是否含封禁号（排除式全选时拿不到对象，直接提交）
            const selectedAccounts = items.filter((account) => selection.isSelected(account.id));
            if (selectedAccounts.length === selection.count) tryJoin(selectedAccounts);
            else joinMutation.mutate({ ids: selection.selectedIds });
          }}
          disabled={joinMutation.isPending}
        >
          {joinMutation.isPending && <Loader2 className="animate-spin" />}
          批量加入主号池
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
          onClick={() => refreshMailMutation.mutate(selection.selectedIds)}
          disabled={refreshMailMutation.isPending}
        >
          {refreshMailMutation.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          重新检查
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

      <BatchResultDialog result={batchResult} onOpenChange={(open) => !open && setBatchResult(null)} />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        title="导入账号"
        description="导入 sub2api 账号导出 JSON：邮箱四段信息、ChatGPT 密码、两步验证密钥一次性补全，全部进入备用号池"
        placeholder={[
          'sub2api 账号导出 JSON（accounts[].notes 携带全部凭据）：',
          '{ "accounts": [{ "name": "a@b.com----…----GPT密码",',
          '    "notes": "{\\"mailbox\\":{\\"password\\":\\"邮箱密码\\",\\"client_id\\":\\"…\\",\\"refresh_token\\":\\"…\\"},',
          '              \\"gpt\\":{\\"password\\":\\"GPT密码\\"},\\"two_factor\\":{\\"enabled\\":true,\\"secret\\":\\"…\\"}}",',
          '    "credentials": { "refresh_token": "…", "access_token": "…" } }] }',
          '',
          'notes.mailbox → 邮箱----密码----clientId----refreshToken（四段）',
          'notes.gpt.password → ChatGPT 登录密码（勿与邮箱密码混淆）',
          'notes.two_factor.enabled + secret → 两步验证',
          'credentials 里的 OAuth tokens 忽略：加入主号池走本系统登录授权',
        ].join('\n')}
        initialText={lastImportText}
        result={importResult}
        busy={importMutation.isPending}
        onSubmit={(text) => {
          setLastImportText(text);
          // 已有结果 → 点导入 = 带 force 重提交（强制入备用池）
          importMutation.mutate(importResult ? { text, forceDiscard: true, forceRemote: true } : { text });
        }}
        extraAction={
          (importResult?.duplicates_remote?.length ?? 0) > 0
            ? {
                label: '收编进主号池',
                onSubmit: (text) => {
                  setLastImportText(text);
                  importMutation.mutate({ text, adoptRemote: true });
                },
              }
            : undefined
        }
      />
      {importResult && (importResult.duplicates_in_discard.length > 0 || importResult.duplicates_remote.length > 0) && (
        <div className="flex items-center gap-3 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm">
          <span className="flex-1">
            {importResult.duplicates_remote.length > 0 &&
              `${importResult.duplicates_remote.length} 个账号已在远端 sub2api：可在导入详情中「收编进主号池」（直接关联远端，不重新登录）。`}
            {importResult.duplicates_in_discard.length > 0 && ' 废弃池重复账号可在详情中再次点「导入」强制重新导入。'}
          </span>
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
            查看详情
          </Button>
        </div>
      )}

      <CredentialsEditDialog account={editAccount} open={!!editAccount} onOpenChange={(next) => !next && setEditAccount(null)} />

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

      <ConfirmDialog
        open={forceJoin !== null}
        onOpenChange={(open) => !open && setForceJoin(null)}
        title={`强制加入 ${forceJoin?.ids.length ?? 0} 个账号？`}
        description={`其中 ${forceJoin?.bannedCount ?? 0} 个已被邮件检查标记为封禁。强制加入将清除封禁标记并发起授权登录，是否继续？`}
        confirmText="强制加入"
        busy={joinMutation.isPending}
        onConfirm={() => forceJoin && joinMutation.mutate({ ids: forceJoin.ids, force: true })}
      />
    </div>
  );
}

/** 刷新邮件状态：后端只有单条接口，这里按并发 10 分批，避免一次打出上百个并发请求。 */
async function refreshMailBatched(ids: number[], concurrency = 10): Promise<{ ok: number }> {
  for (let start = 0; start < ids.length; start += concurrency) {
    await Promise.all(ids.slice(start, start + concurrency).map((id) => accountsApi.refreshMail(id)));
  }
  return { ok: ids.length };
}

function serializeSort(sort: SortState | null): string {
  return sort ? `${sort.key}:${sort.dir}` : '';
}

function MailStatusBadge({ account }: { account: ReserveAccount }) {
  if (account.mail_status === 'checking') {
    return (
      <Badge variant="info">
        <Loader2 className="h-3 w-3 animate-spin" /> 检查中
      </Badge>
    );
  }
  if (account.mail_status === 'ok') return <Badge variant="success">正常</Badge>;
  if (account.mail_status === 'skipped') return <Badge variant="muted">跳过</Badge>;
  if (account.mail_status === 'fetch_failed') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Badge variant="danger">取件失败</Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{account.mail_error ?? '未知错误'}</TooltipContent>
      </Tooltip>
    );
  }
  return <Badge variant="muted">待检查</Badge>;
}
