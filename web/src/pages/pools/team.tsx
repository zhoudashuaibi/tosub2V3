import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Download,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Search,
  ShieldCheck,
  Ticket,
  Trash2,
  Upload,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { sub2apiApi, teamApi } from '@/api';
import { errorMessage } from '@/api/client';
import type {
  CodexFingerprintMode,
  TeamAccount,
  TeamCard,
  TeamCardImportResult,
  TeamConfigView,
  TeamSession,
} from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BatchActionBar } from '@/components/batch-action-bar';
import {
  CODEX_FINGERPRINT_MODE_HINT,
  CodexFingerprintModeSelect,
  normalizeCodexFingerprintMode,
} from '@/components/codex-fingerprint-mode-select';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { cn, formatRelativeTime } from '@/lib/utils';

const ACCOUNT_HEALTH: Record<string, { label: string; variant: 'success' | 'danger' | 'warning' | 'muted' }> = {
  healthy: { label: '健康', variant: 'success' },
  need_reclaim: { label: '需找回(401)', variant: 'danger' },
  cannot_reclaim: { label: '不可找回', variant: 'muted' },
  unknown: { label: '未知', variant: 'muted' },
};

const CARD_STATUS: Record<string, { label: string; variant: 'success' | 'danger' | 'warning' | 'muted' }> = {
  unextracted: { label: '未提取', variant: 'muted' },
  healthy: { label: '健康', variant: 'success' },
  need_reclaim: { label: '需找回', variant: 'danger' },
  cannot_reclaim: { label: '不可找回', variant: 'muted' },
  mixed: { label: '混合', variant: 'warning' },
};

const PHASE_LABELS: Record<string, string> = {
  starting: '启动中',
  submitting: '提交批次',
  polling: '等待找回完成',
  downloading: '下载凭据',
  saving: '保存凭据',
  uploading: '自动上传 sub2api',
  checking: '健康检查中',
  done: '已完成',
  error: '失败',
};

function maskCardCode(code: string): string {
  if (code.length <= 16) return `${code.slice(0, 6)}****`;
  return `${code.slice(0, 11)}****${code.slice(-4)}`;
}

export function TeamPoolPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('accounts');

  // 账号列表筛选/选择
  const [accountQ, setAccountQ] = useState('');
  const [healthFilter, setHealthFilter] = useState('');
  const [uploadedFilter, setUploadedFilter] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<Set<number>>(new Set());

  // 卡密列表筛选/选择
  const [cardQ, setCardQ] = useState('');
  const [cardStatusFilter, setCardStatusFilter] = useState('');
  const [selectedCards, setSelectedCards] = useState<Set<number>>(new Set());

  const [revealCodes, setRevealCodes] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteCardsOpen, setDeleteCardsOpen] = useState(false);
  const [uploadConfirmOpen, setUploadConfirmOpen] = useState(false);

  const { data: session } = useQuery({
    queryKey: ['team', 'session'],
    queryFn: () => teamApi.session(),
    refetchInterval: (query) => (((query.state.data as TeamSession | undefined)?.running) ? 2000 : 15000),
  });

  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['team', 'accounts', { accountQ, healthFilter, uploadedFilter }],
    queryFn: () =>
      teamApi.accounts({
        q: accountQ || undefined,
        status: healthFilter || undefined,
        uploaded: uploadedFilter || undefined,
        page_size: 200,
      }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const { data: cardsData, isLoading: cardsLoading } = useQuery({
    queryKey: ['team', 'cards', { cardQ, cardStatusFilter }],
    queryFn: () =>
      teamApi.cards({ q: cardQ || undefined, status: cardStatusFilter || undefined, page_size: 200 }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
  });

  const invalidateTeam = () => queryClient.invalidateQueries({ queryKey: ['team'] });

  // 会话从运行中转为结束时刷新列表（凭据/状态已落库）
  const sessionWasRunning = useRef(false);
  useEffect(() => {
    if (sessionWasRunning.current && !session?.running) invalidateTeam();
    sessionWasRunning.current = Boolean(session?.running);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.running]);

  const busy = Boolean(session?.running);

  const healthMutation = useMutation({
    mutationFn: (cardIds: number[]) => teamApi.healthCheck(cardIds),
    onSuccess: () => {
      toast.success('健康检查已开始');
      queryClient.invalidateQueries({ queryKey: ['team', 'session'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const reclaimMutation = useMutation({
    mutationFn: ({ ids, mode }: { ids: number[]; mode: '401' | 'all' }) => teamApi.reclaim(ids, mode),
    onSuccess: (_result, { mode, ids }) => {
      toast.success(mode === 'all' ? `已开始提取 ${ids.length} 张卡密的凭据` : `已开始 401 找回（${ids.length} 张卡密）`);
      queryClient.invalidateQueries({ queryKey: ['team', 'session'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const uploadMutation = useMutation({
    mutationFn: (accountIds: number[]) => teamApi.upload(accountIds),
    onSuccess: (result) => {
      toast.success(
        `上传完成：新增 ${result.created}，替换凭据 ${result.updated}` +
          (result.failed.length ? `，失败 ${result.failed.length}` : ''),
      );
      if (result.failed.length) {
        toast.error(result.failed.map((f) => `${f.email ?? f.id}: ${f.error}`).slice(0, 3).join('\n'), {
          duration: 8000,
        });
      }
      setSelectedAccounts(new Set());
      setUploadConfirmOpen(false);
      invalidateTeam();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const deleteCardsMutation = useMutation({
    mutationFn: (ids: number[]) => teamApi.deleteCards(ids),
    onSuccess: (result) => {
      toast.success(`已删除 ${result.deleted} 张卡密（连带其账号）`);
      setSelectedCards(new Set());
      setDeleteCardsOpen(false);
      invalidateTeam();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const importMutation = useMutation({
    mutationFn: ({ text }: { text: string; autoExtract: boolean }) => teamApi.importCards(text),
    onSuccess: (result, { autoExtract }) => {
      if (autoExtract && result.imported_ids.length) {
        reclaimMutation.mutate({ ids: result.imported_ids, mode: 'all' });
      }
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const accountItems = accountsData?.items ?? [];
  const cardItems = cardsData?.items ?? [];
  const accountStats = accountsData?.stats ?? {};
  const cardStats = cardsData?.stats ?? {};
  const selectedAccountIds = useMemo(() => [...selectedAccounts], [selectedAccounts]);
  const selectedCardIds = useMemo(() => [...selectedCards], [selectedCards]);
  // 选中账号 → 去重后的卡密 ID（健康检查/找回按卡密操作）
  const selectedAccountCardIds = useMemo(
    () => [...new Set(accountItems.filter((a) => selectedAccounts.has(a.id)).map((a) => a.card_id))],
    [accountItems, selectedAccounts],
  );

  const renderCode = (code: string) => (
    <span className="font-mono text-xs">{revealCodes ? code : maskCardCode(code)}</span>
  );

  return (
    <div className="space-y-4">
      {/* ---- 会话进度 / 最近结果 ---- */}
      {(session?.running || session?.result || session?.error) && (
        <Card data-session={session?.kind ?? undefined}>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              {session?.running ? (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              ) : session?.phase === 'error' ? (
                <ShieldCheck className="h-4 w-4 text-destructive" />
              ) : (
                <ShieldCheck className="h-4 w-4 text-[var(--success)]" />
              )}
              {session?.kind === 'health_check' ? '健康检查' : session?.kind === 'reclaim' ? '提取 / 401 找回' : 'Team 会话'}
              {session?.phase && <span className="text-sm font-normal text-muted-foreground">· {PHASE_LABELS[session.phase] ?? session.phase}</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {session?.running && (
              <>
                <div className="text-sm text-muted-foreground">{session.message || '处理中…'}</div>
                {session.progress && progressPercent(session.progress) != null && (
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${progressPercent(session.progress)}%` }}
                    />
                  </div>
                )}
              </>
            )}
            {!session?.running && session?.phase === 'error' && (
              <div className="text-sm text-destructive">{session.error}</div>
            )}
            {!session?.running && session?.result && <div className="text-sm">{sessionResultSummary(session)}</div>}
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="accounts">账号列表</TabsTrigger>
            <TabsTrigger value="cards">卡密管理</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>卡密 {cardStats.total ?? 0}</span>
            <span>账号 {accountStats.total ?? 0}</span>
            <span>已上传 {accountStats.uploaded ?? 0}</span>
          </div>
        </div>

        {/* ---- 账号列表 ---- */}
        <TabsContent value="accounts" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { value: 'need_reclaim', label: '需找回', variant: 'danger' as const },
                { value: 'healthy', label: '健康', variant: 'success' as const },
              ] as const
            ).map((chip) => (
              <button
                key={chip.value}
                type="button"
                aria-pressed={healthFilter === chip.value}
                className="cursor-pointer rounded-full focus-visible:outline-none"
                onClick={() => setHealthFilter((prev) => (prev === chip.value ? '' : chip.value))}
              >
                <Badge
                  variant={chip.variant}
                  className={cn(
                    healthFilter === chip.value
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {chip.label} {accountStats[chip.value] ?? 0}
                </Badge>
              </button>
            ))}
            {(['1', '0'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={uploadedFilter === value}
                className="cursor-pointer rounded-full focus-visible:outline-none"
                onClick={() => setUploadedFilter((prev) => (prev === value ? '' : value))}
              >
                <Badge
                  variant="secondary"
                  className={cn(
                    uploadedFilter === value
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {value === '1' ? '已上传' : '未上传'} {value === '1' ? accountStats.uploaded ?? 0 : (accountStats.total ?? 0) - (accountStats.uploaded ?? 0)}
                </Badge>
              </button>
            ))}
            <div className="flex-1" />
            <Button variant="ghost" size="icon" title={revealCodes ? '隐藏卡密' : '显示完整卡密'} onClick={() => setRevealCodes((v) => !v)}>
              {revealCodes ? <EyeOff /> : <Eye />}
            </Button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={accountQ} onChange={(e) => setAccountQ(e.target.value)} placeholder="搜索邮箱/卡密…" className="h-6 w-52 pl-8" />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || healthMutation.isPending || selectedAccountCardIds.length === 0}
              title={selectedAccountCardIds.length ? '检查选中账号所属卡密' : '先勾选账号'}
              onClick={() => healthMutation.mutate(selectedAccountCardIds)}
            >
              {healthMutation.isPending ? <Loader2 className="animate-spin" /> : <HeartPulse />}
              健康检查
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || reclaimMutation.isPending || selectedAccountCardIds.length === 0}
              title={selectedAccountCardIds.length ? '对选中账号所属卡密发起 401 找回' : '先勾选账号'}
              onClick={() => reclaimMutation.mutate({ ids: selectedAccountCardIds, mode: '401' })}
            >
              {reclaimMutation.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              401找回
            </Button>
          </div>

          <div className="rounded-lg border bg-card">
            {accountsLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : accountItems.length === 0 ? (
              <EmptyState
                icon={UsersRound}
                title={accountQ || healthFilter || uploadedFilter ? '没有符合条件的账号' : '还没有 team 账号'}
                description={
                  accountQ || healthFilter || uploadedFilter
                    ? '换个条件试试，或点击当前高亮的徽章取消筛选'
                    : '到「卡密管理」导入兑换码，系统会自动提取凭据入库'
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={selectedAccounts.size === accountItems.length}
                        onCheckedChange={() =>
                          setSelectedAccounts((prev) =>
                            prev.size === accountItems.length ? new Set() : new Set(accountItems.map((i) => i.id)),
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>简短名</TableHead>
                    <TableHead>卡密</TableHead>
                    <TableHead>邮箱</TableHead>
                    <TableHead>健康状态</TableHead>
                    <TableHead>sub2api</TableHead>
                    <TableHead>凭据更新</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accountItems.map((account: TeamAccount) => (
                    <TableRow key={account.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedAccounts.has(account.id)}
                          onCheckedChange={() =>
                            setSelectedAccounts((prev) => {
                              const next = new Set(prev);
                              if (next.has(account.id)) next.delete(account.id);
                              else next.add(account.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{account.short_name ?? '—'}</TableCell>
                      <TableCell>{renderCode(account.card_code)}</TableCell>
                      <TableCell className="max-w-[220px] truncate text-xs">{account.email}</TableCell>
                      <TableCell>
                        <Badge variant={ACCOUNT_HEALTH[account.health_status ?? 'unknown']?.variant ?? 'muted'}>
                          {ACCOUNT_HEALTH[account.health_status ?? 'unknown']?.label ?? account.health_status ?? '未知'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {account.sub2api_account_id ? (
                          <>
                            <Badge variant="secondary" className="mr-1.5 py-0">#{account.sub2api_account_id}</Badge>
                            {formatRelativeTime(account.sub2api_uploaded_at)}
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelativeTime(account.updated_at)}</TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={uploadMutation.isPending || (busy && session?.kind === 'reclaim')}
                          onClick={() => {
                            setSelectedAccounts(new Set([account.id]));
                            setUploadConfirmOpen(true);
                          }}
                        >
                          上传
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <BatchActionBar
            count={selectedAccounts.size}
            onClear={() => setSelectedAccounts(new Set())}
            extra={`涉及 ${selectedAccountCardIds.length} 张卡密`}
          >
            <Button
              size="sm"
              onClick={() => setUploadConfirmOpen(true)}
              disabled={uploadMutation.isPending || (busy && session?.kind === 'reclaim')}
            >
              {uploadMutation.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              上传 sub2api
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reclaimMutation.isPending}
              onClick={() => reclaimMutation.mutate({ ids: selectedAccountCardIds, mode: '401' })}
            >
              <KeyRound />
              401找回
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || healthMutation.isPending}
              onClick={() => healthMutation.mutate(selectedAccountCardIds)}
            >
              <HeartPulse />
              健康检查
            </Button>
          </BatchActionBar>
        </TabsContent>

        {/* ---- 卡密管理 ---- */}
        <TabsContent value="cards" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                { value: 'unextracted', label: '未提取', variant: 'muted' as const },
                { value: 'need_reclaim', label: '需找回', variant: 'danger' as const },
                { value: 'healthy', label: '健康', variant: 'success' as const },
                { value: 'mixed', label: '混合', variant: 'warning' as const },
              ] as const
            ).map((chip) => (
              <button
                key={chip.value}
                type="button"
                aria-pressed={cardStatusFilter === chip.value}
                className="cursor-pointer rounded-full focus-visible:outline-none"
                onClick={() => setCardStatusFilter((prev) => (prev === chip.value ? '' : chip.value))}
              >
                <Badge
                  variant={chip.variant}
                  className={cn(
                    cardStatusFilter === chip.value
                      ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                      : 'opacity-80 hover:opacity-100',
                  )}
                >
                  {chip.label} {cardStats[chip.value] ?? 0}
                </Badge>
              </button>
            ))}
            <Badge variant="muted">全部 {cardStats.total ?? 0}</Badge>
            <div className="flex-1" />
            <Button variant="ghost" size="icon" title={revealCodes ? '隐藏卡密' : '显示完整卡密'} onClick={() => setRevealCodes((v) => !v)}>
              {revealCodes ? <EyeOff /> : <Eye />}
            </Button>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={cardQ} onChange={(e) => setCardQ(e.target.value)} placeholder="搜索卡密…" className="h-6 w-52 pl-8" />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || healthMutation.isPending || selectedCards.size === 0}
              title={selectedCards.size ? '检查选中卡密' : '先勾选卡密'}
              onClick={() => healthMutation.mutate(selectedCardIds)}
            >
              {healthMutation.isPending ? <Loader2 className="animate-spin" /> : <HeartPulse />}
              健康检查
            </Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Plus />
              添加卡密
            </Button>
          </div>

          <div className="rounded-lg border bg-card">
            {cardsLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : cardItems.length === 0 ? (
              <EmptyState
                icon={Ticket}
                title={cardQ || cardStatusFilter ? '没有符合条件的卡密' : '还没有导入卡密'}
                description={
                  cardQ || cardStatusFilter
                    ? '换个条件试试，或点击当前高亮的徽章取消筛选'
                    : '粘贴 30d.team 的兑换码（每行一条），导入后可自动提取凭据'
                }
                actionLabel="添加卡密"
                onAction={() => setImportOpen(true)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox
                        checked={selectedCards.size === cardItems.length}
                        onCheckedChange={() =>
                          setSelectedCards((prev) =>
                            prev.size === cardItems.length ? new Set() : new Set(cardItems.map((i) => i.id)),
                          )
                        }
                      />
                    </TableHead>
                    <TableHead>卡密</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>账号 / 已上传</TableHead>
                    <TableHead>最近检查</TableHead>
                    <TableHead>提取 / 找回</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cardItems.map((card: TeamCard) => (
                    <TableRow key={card.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedCards.has(card.id)}
                          onCheckedChange={() =>
                            setSelectedCards((prev) => {
                              const next = new Set(prev);
                              if (next.has(card.id)) next.delete(card.id);
                              else next.add(card.id);
                              return next;
                            })
                          }
                        />
                      </TableCell>
                      <TableCell>{renderCode(card.card_code)}</TableCell>
                      <TableCell>
                        <Badge variant={CARD_STATUS[card.status]?.variant ?? 'muted'}>
                          {CARD_STATUS[card.status]?.label ?? card.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {card.account_count} / {card.uploaded_count}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatRelativeTime(card.health?.checked_at ?? null)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[card.last_extracted_at, card.last_reclaim_at].filter(Boolean).length
                          ? `${formatRelativeTime(card.last_extracted_at)} · ${formatRelativeTime(card.last_reclaim_at)}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || reclaimMutation.isPending}
                            onClick={() => reclaimMutation.mutate({ ids: [card.id], mode: 'all' })}
                          >
                            提取
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy || reclaimMutation.isPending}
                            onClick={() => reclaimMutation.mutate({ ids: [card.id], mode: '401' })}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                            找回
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            onClick={() => {
                              setSelectedCards(new Set([card.id]));
                              setDeleteCardsOpen(true);
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

          <BatchActionBar count={selectedCards.size} onClear={() => setSelectedCards(new Set())}>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || reclaimMutation.isPending}
              onClick={() => reclaimMutation.mutate({ ids: selectedCardIds, mode: 'all' })}
            >
              <Download />
              提取凭据
            </Button>
            <Button
              size="sm"
              onClick={() => reclaimMutation.mutate({ ids: selectedCardIds, mode: '401' })}
              disabled={busy || reclaimMutation.isPending}
            >
              {reclaimMutation.isPending && <Loader2 className="animate-spin" />}
              <KeyRound />
              401找回
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || healthMutation.isPending}
              onClick={() => healthMutation.mutate(selectedCardIds)}
            >
              <HeartPulse />
              健康检查
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDeleteCardsOpen(true)}>
              <Trash2 />
            </Button>
          </BatchActionBar>
        </TabsContent>
      </Tabs>

      {/* ---- 配置区 ---- */}
      <TeamConfigSection />

      {/* ---- 弹窗 ---- */}
      <ImportCardsDialog
        open={importOpen}
        onOpenChange={(nextOpen) => {
          setImportOpen(nextOpen);
          if (!nextOpen) importMutation.reset();
        }}
        busy={importMutation.isPending}
        result={importMutation.data ?? null}
        error={importMutation.isError ? errorMessage(importMutation.error) : null}
        onSubmit={(text, autoExtract) => importMutation.mutate({ text, autoExtract })}
      />

      <ConfirmDialog
        open={deleteCardsOpen}
        onOpenChange={setDeleteCardsOpen}
        title={`删除 ${selectedCards.size} 张卡密？`}
        description="将同时删除卡密下已提取的全部 team 账号与凭据，操作不可恢复。"
        confirmText="删除"
        busy={deleteCardsMutation.isPending}
        onConfirm={() => deleteCardsMutation.mutate(selectedCardIds)}
      />

      <ConfirmDialog
        open={uploadConfirmOpen}
        onOpenChange={setUploadConfirmOpen}
        title={`上传 ${selectedAccounts.size} 个账号到 sub2api？`}
        description="使用下方「上传默认配置」；远端已存在的账号将替换凭据并恢复调度，账号名使用简短名、备注记录卡密。"
        confirmText="上传"
        destructive={false}
        busy={uploadMutation.isPending}
        onConfirm={() => uploadMutation.mutate(selectedAccountIds)}
      />
    </div>
  );
}

function progressPercent(progress: NonNullable<TeamSession['progress']>): number | null {
  if (progress.total && progress.total > 0 && progress.done != null) {
    return Math.min(100, Math.round((progress.done / progress.total) * 100));
  }
  if (progress.tasks_total && progress.tasks_total > 0 && progress.tasks_done != null) {
    return Math.min(100, Math.round((progress.tasks_done / progress.tasks_total) * 100));
  }
  return null;
}

function sessionResultSummary(session: TeamSession): string {
  const r = (session.result ?? {}) as Record<string, unknown>;
  if (session.kind === 'health_check') {
    const parts = [
      `需找回 ${r.need_reclaim ?? 0}`,
      `健康 ${r.healthy ?? 0}`,
      `不可找回 ${r.cannot_reclaim ?? 0}`,
      `未知 ${r.unknown ?? 0}`,
      `卡密 ${r.cards ?? 0}`,
    ];
    if (Array.isArray(r.errors) && r.errors.length) parts.push(`错误 ${r.errors.length} 批`);
    return `健康检查完成：${parts.join(' · ')}`;
  }
  const parts = [
    `更新凭据 ${r.updated ?? 0}`,
    `本来正常 ${r.no_action ?? 0}`,
    `不可找回 ${r.unreclaimable ?? 0}`,
    `失败 ${r.failed ?? 0}`,
    `下载订单 ${r.downloaded ?? 0}`,
    `新增账号 ${r.accounts_inserted ?? 0}`,
    `更新账号 ${r.accounts_updated ?? 0}`,
  ];
  const upload = r.upload as { created?: number; updated?: number; error?: string } | null | undefined;
  if (upload?.error) parts.push(`自动上传失败：${upload.error}`);
  else if (upload) parts.push(`自动上传：新增 ${upload.created ?? 0} · 替换 ${upload.updated ?? 0}`);
  if (Array.isArray(r.errors) && r.errors.length) parts.push(`提示 ${r.errors.length} 条`);
  return `提取 / 找回完成（${r.mode === 'all' ? '全部提取' : '仅 401'}）：${parts.join(' · ')}`;
}

function ImportCardsDialog({
  open,
  onOpenChange,
  busy,
  result,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  result: TeamCardImportResult | null;
  error: string | null;
  onSubmit: (text: string, autoExtract: boolean) => void;
}) {
  const [text, setText] = useState('');
  const [autoExtract, setAutoExtract] = useState(true);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setText('');
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>添加 team 卡密</DialogTitle>
          <DialogDescription>每行一条兑换码（如 team-cef2c5-PTRW-225182D3B8C0），自动查重</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'team-cef2c5-PTRW-225182D3B8C0\nteam-cef2c5-PTRW-CB086776D5BB'}
          className="min-h-[130px] font-mono text-xs"
          spellCheck={false}
        />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={autoExtract} onCheckedChange={setAutoExtract} />
          导入后立即提取凭据（自动调 30d.team 批量接口下载入库）
        </label>
        {error && <div className="text-sm text-destructive">{error}</div>}
        {result && (
          <div className="space-y-1.5 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="text-[var(--success)]">成功导入 {result.imported} 张卡密</div>
            {result.duplicates_in_batch.length > 0 && (
              <div className="text-muted-foreground">批内重复已跳过 {result.duplicates_in_batch.length} 条</div>
            )}
            {result.duplicates_existing.length > 0 && (
              <div className="text-muted-foreground">已存在跳过 {result.duplicates_existing.length} 条</div>
            )}
            {result.invalid.length > 0 && (
              <div className="text-destructive">
                非法行 {result.invalid.length} 条：第 {result.invalid.slice(0, 5).map((i) => i.line).join('、')} 行
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={busy}>
            关闭
          </Button>
          <Button disabled={busy || !text.trim()} onClick={() => onSubmit(text, autoExtract)}>
            {busy && <Loader2 className="animate-spin" />}
            导入
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamConfigSection() {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({ queryKey: ['team', 'config'], queryFn: () => teamApi.config() });
  const { data: sub2apiConfig } = useQuery({ queryKey: ['sub2api', 'config'], queryFn: () => sub2apiApi.config() });
  const { data: groups } = useQuery({
    queryKey: ['sub2api', 'groups'],
    queryFn: () => sub2apiApi.groups(),
    enabled: Boolean(sub2apiConfig?.base_url),
    retry: false,
  });
  const { data: remoteProxies } = useQuery({
    queryKey: ['sub2api', 'proxies'],
    queryFn: () => sub2apiApi.proxies(),
    enabled: Boolean(sub2apiConfig?.base_url),
    retry: false,
  });

  const [redeemUrl, setRedeemUrl] = useState('');
  const [autoUpload, setAutoUpload] = useState(true);
  const [loaded, setLoaded] = useState(false);

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

  useEffect(() => {
    if (config && !loaded) {
      setRedeemUrl(config.redeem_base_url);
      setAutoUpload(config.auto_upload_after_reclaim !== false);
      const ud = config.upload_defaults ?? {};
      setGroupIds(config.group_ids ?? []);
      setConcurrency(ud.concurrency != null ? String(ud.concurrency) : '');
      setLoadFactor(ud.load_factor != null ? String(ud.load_factor) : '');
      setPriority(ud.priority != null ? String(ud.priority) : '');
      setModelWhitelist((ud.model_whitelist ?? []).join(', '));
      setAutoSelectProxy(ud.auto_select_proxy !== false);
      setProxyId(ud.proxy_id != null ? String(ud.proxy_id) : '');
      setDisable5h(Boolean(ud.disable_auto_pause_5h));
      setDisable7d(Boolean(ud.disable_auto_pause_7d));
      setLongContextBilling(ud.enable_long_context_billing !== false);
      setCodexFingerprintMode(normalizeCodexFingerprintMode(ud.codex_fingerprint_mode));
      setLoaded(true);
    }
  }, [config, loaded]);

  const uploadDefaultsState = {
    concurrency: concurrency === '' ? null : Number(concurrency),
    load_factor: loadFactor === '' ? null : Number(loadFactor),
    priority: priority === '' ? null : Number(priority),
    model_whitelist: modelWhitelist
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    disable_auto_pause_5h: disable5h,
    disable_auto_pause_7d: disable7d,
    enable_long_context_billing: longContextBilling,
    codex_fingerprint_mode: codexFingerprintMode,
    auto_select_proxy: autoSelectProxy,
    proxy_id: proxyId ? Number(proxyId) : null,
  };

  const saveRedeemMutation = useMutation({
    mutationFn: () =>
      teamApi.updateConfig({ redeem_base_url: redeemUrl, auto_upload_after_reclaim: autoUpload }),
    onSuccess: () => {
      toast.success('兑换服务配置已保存');
      queryClient.invalidateQueries({ queryKey: ['team', 'config'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveUploadDefaultsMutation = useMutation({
    mutationFn: () => teamApi.updateConfig({ group_ids: groupIds, upload_defaults: uploadDefaultsState }),
    onSuccess: () => {
      toast.success('Team 上传默认配置已保存');
      queryClient.invalidateQueries({ queryKey: ['team', 'config'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>兑换服务</CardTitle>
          <CardDescription>30d.team 兑换 / 401 找回服务地址；sub2api 连接与代理 IP 一键更换复用「Sub2API」页配置</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>服务地址</Label>
            <Input value={redeemUrl} onChange={(e) => setRedeemUrl(e.target.value)} placeholder="https://30d.team" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoUpload} onCheckedChange={setAutoUpload} />
            凭据更新后自动上传 sub2api（含首次提取与 401 找回）
          </label>
          <Button onClick={() => saveRedeemMutation.mutate()} disabled={saveRedeemMutation.isPending}>
            {saveRedeemMutation.isPending && <Loader2 className="animate-spin" />}
            <Save className="h-4 w-4" />
            保存
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上传默认配置（仅 Team 号池）</CardTitle>
          <CardDescription>
            独立保存，不影响现有号池的上传默认配置；上传账号名使用简短名（team-月日-时分-序号），备注记录卡密
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>上传分组（留空 = 默认分组）</Label>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
              {!sub2apiConfig?.base_url && (
                <span className="text-xs text-muted-foreground">请先在「Sub2API」页配置连接后再选择分组</span>
              )}
              {sub2apiConfig?.base_url && (groups?.items ?? []).length === 0 && (
                <span className="text-xs text-muted-foreground">无可用分组（或连接不可用）</span>
              )}
              {(groups?.items ?? []).map((group) => (
                <label key={group.id} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={groupIds.includes(group.id)}
                    onCheckedChange={() =>
                      setGroupIds((prev) =>
                        prev.includes(group.id) ? prev.filter((g) => g !== group.id) : [...prev, group.id],
                      )
                    }
                  />
                  {group.name} (#{group.id})
                </label>
              ))}
            </div>
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
              <Label>优先级</Label>
              <Input value={priority} onChange={(e) => setPriority(e.target.value)} placeholder="1" />
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
                <SelectTrigger className="w-full" aria-label="指定默认上传代理">
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
          <Button onClick={() => saveUploadDefaultsMutation.mutate()} disabled={saveUploadDefaultsMutation.isPending}>
            {saveUploadDefaultsMutation.isPending && <Loader2 className="animate-spin" />}
            <Save className="h-4 w-4" />
            保存上传默认配置
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
