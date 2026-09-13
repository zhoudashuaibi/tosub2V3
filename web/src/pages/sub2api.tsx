import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, ChevronRight, Loader2, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import { sub2apiApi } from '@/api';
import { errorMessage } from '@/api/client';
import type { CodexFingerprintMode, Sub2ApiMonitorLog, Sub2ApiMonitorLogItem, Sub2ApiProxyReplaceResult } from '@/api/types';
import {
  CODEX_FINGERPRINT_MODE_HINT,
  CodexFingerprintModeSelect,
  normalizeCodexFingerprintMode,
} from '@/components/codex-fingerprint-mode-select';
import { UPLOAD_ORDER_OPTIONS } from '@/components/upload-order-select';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn, formatDateTime, formatRelativeTime } from '@/lib/utils';

export function Sub2ApiPage() {
  const queryClient = useQueryClient();
  const { data: config } = useQuery({
    queryKey: ['sub2api', 'config'],
    queryFn: () => sub2apiApi.config(),
  });
  const { data: monitor } = useQuery({
    queryKey: ['sub2api', 'monitor'],
    queryFn: () => sub2apiApi.monitor(),
    refetchInterval: 30_000,
  });
  const { data: monitorLogs } = useQuery({
    queryKey: ['sub2api', 'monitor', 'logs'],
    queryFn: () => sub2apiApi.monitorLogs(20),
    refetchInterval: monitor?.running ? 5_000 : 15_000,
  });

  const [baseUrl, setBaseUrl] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [joinAutoUpload, setJoinAutoUpload] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // ---- 上传默认配置（自动上传链路使用，手动上传弹窗以此为默认值） ----
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

  const { data: groups } = useQuery({
    queryKey: ['sub2api', 'groups'],
    queryFn: () => sub2apiApi.groups(),
    enabled: Boolean(config?.base_url),
    retry: false,
  });
  const { data: remoteProxies } = useQuery({
    queryKey: ['sub2api', 'proxies'],
    queryFn: () => sub2apiApi.proxies(),
    enabled: Boolean(config?.base_url),
    retry: false,
  });

  const [replaceOpen, setReplaceOpen] = useState(false);

  useEffect(() => {
    if (config && !loaded) {
      setBaseUrl(config.base_url);
      setJoinAutoUpload(Boolean(config.join_auto_upload));
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

  const saveMutation = useMutation({
    mutationFn: () =>
      sub2apiApi.updateConfig({
        base_url: baseUrl,
        admin_key: adminKey,
        join_auto_upload: joinAutoUpload,
        group_ids: config?.group_ids ?? [],
        upload_defaults: config?.upload_defaults ?? {},
        monitor: monitorConfigState,
      }),
    onSuccess: () => {
      toast.success('配置已保存');
      setAdminKey('');
      queryClient.invalidateQueries({ queryKey: ['sub2api'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const saveUploadDefaultsMutation = useMutation({
    mutationFn: () =>
      sub2apiApi.updateConfig({
        group_ids: groupIds,
        upload_defaults: uploadDefaultsState,
      }),
    onSuccess: () => {
      toast.success('上传默认配置已保存');
      queryClient.invalidateQueries({ queryKey: ['sub2api'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  // ---- 监控配置（独立卡片） ----
  const [monitorEnabled, setMonitorEnabled] = useState(false);
  const [intervalMin, setIntervalMin] = useState('5');
  const [autoRepair, setAutoRepair] = useState(true);
  const [maxRepair, setMaxRepair] = useState('2');
  const [autoReplenish, setAutoReplenish] = useState(false);
  const [refreshBalance, setRefreshBalance] = useState(false);
  const [replenishUploadOrder, setReplenishUploadOrder] = useState('balance_asc');
  const [replenishJoinOrder, setReplenishJoinOrder] = useState('balance_desc');
  const [reserveThreshold, setReserveThreshold] = useState('10');
  const [mainStockThreshold, setMainStockThreshold] = useState('');
  const [replenishMode, setReplenishMode] = useState<'count' | 'resource'>('count');
  const [concurrencyTarget, setConcurrencyTarget] = useState('0');
  const [initialBalanceTarget, setInitialBalanceTarget] = useState('0');
  const [balanceRefreshInterval, setBalanceRefreshInterval] = useState('60');
  const [cooldownMin, setCooldownMin] = useState('5');
  const [rateLimitThreshold, setRateLimitThreshold] = useState('12');
  const [bannedPatterns, setBannedPatterns] = useState('');
  const [rateLimitPatterns, setRateLimitPatterns] = useState('');

  useEffect(() => {
    if (config?.monitor && !loaded) {
      const m = config.monitor;
      setMonitorEnabled(Boolean(m.enabled));
      setIntervalMin(String(m.interval_minutes ?? 5));
      setAutoRepair(m.auto_repair !== false);
      setMaxRepair(String(m.max_repair_attempts ?? 2));
      setAutoReplenish(Boolean(m.auto_replenish));
      setRefreshBalance(Boolean(m.refresh_balance));
      setReplenishUploadOrder(m.replenish_upload_order ?? 'balance_asc');
      setReplenishJoinOrder(m.replenish_join_order ?? 'balance_desc');
      setReserveThreshold(String(m.reserve_threshold ?? 10));
      setMainStockThreshold(m.main_stock_threshold != null ? String(m.main_stock_threshold) : '');
      setReplenishMode(m.replenish_mode === 'resource' ? 'resource' : 'count');
      setConcurrencyTarget(String(m.concurrency_target ?? 0));
      setInitialBalanceTarget(String(m.initial_balance_target ?? 0));
      setBalanceRefreshInterval(String(m.balance_refresh_interval_minutes ?? 60));
      setCooldownMin(String(m.cooldown_minutes ?? 5));
      setRateLimitThreshold(String(m.rate_limit_reset_threshold_hours ?? 12));
      setBannedPatterns((m.banned_patterns ?? []).join('\n'));
      setRateLimitPatterns((m.rate_limit_patterns ?? []).join('\n'));
    }
  }, [config, loaded]);

  const monitorConfigState = {
    enabled: monitorEnabled,
    interval_minutes: Number(intervalMin) || 5,
    cooldown_minutes: Number(cooldownMin) || 5,
    auto_repair: autoRepair,
    max_repair_attempts: Number(maxRepair) || 2,
    auto_replenish: autoReplenish,
    refresh_balance: refreshBalance,
    balance_refresh_interval_minutes: Number(balanceRefreshInterval) || 0,
    reserve_threshold: Number(reserveThreshold) || 10,
    main_stock_threshold: mainStockThreshold === '' ? null : Math.max(0, Number(mainStockThreshold) || 0),
    replenish_mode: replenishMode,
    concurrency_target: Number(concurrencyTarget) || 0,
    initial_balance_target: Number(initialBalanceTarget) || 0,
    replenish_upload_order: replenishUploadOrder,
    replenish_join_order: replenishJoinOrder,
    pause_on_discard: true,
    rate_limit_reset_threshold_hours: Number(rateLimitThreshold) || 12,
    banned_patterns: bannedPatterns.split('\n').map((s) => s.trim()).filter(Boolean),
    rate_limit_patterns: rateLimitPatterns.split('\n').map((s) => s.trim()).filter(Boolean),
  };

  const saveMonitorMutation = useMutation({
    mutationFn: () => sub2apiApi.updateMonitor(monitorConfigState),
    onSuccess: () => {
      toast.success(monitorEnabled ? '监控已启用' : '监控已停用');
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'monitor'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const checkMutation = useMutation({
    mutationFn: () => sub2apiApi.checkNow(),
    onSuccess: ({ monitor: view }) => {
      const r = view?.last_result;
      toast.success(
        r
          ? `巡检完成：扫描 ${r.scanned ?? 0} · 异常 ${r.error_accounts} · 限流中 ${r.rate_limited ?? 0} · 待辅证 ${r.ban_unconfirmed ?? 0} · 在途修复 ${r.repair_pending ?? 0} · 废弃 ${r.discarded} · 发起修复 ${r.repairing} · 修复成功 ${r.repair_ok ?? 0} · 修复失败 ${r.repair_failed ?? 0} · 上传 ${r.uploaded ?? 0} · 补号 ${r.replenished} · 余额 ${r.balance_queued ?? 0}${r.available_count != null ? ` · 可用 ${r.available_count}` : ''}`
          : '巡检完成',
      );
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'monitor'] });
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'monitor', 'logs'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const testMutation = useMutation({
    mutationFn: () => sub2apiApi.test(baseUrl ? { base_url: baseUrl, admin_key: adminKey || undefined } : {}),
    onSuccess: (result) => toast.success(`连接正常（${result.groups} 个分组，${result.latency_ms}ms）`),
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <div className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>连接配置</CardTitle>
          <CardDescription>管理密钥加密存储，保存后不再回显</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>后端地址</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8080" />
          </div>
          <div className="space-y-1.5">
            <Label>管理员密钥</Label>
            <Input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder={config?.has_admin_key ? config.admin_key_masked : 'sk-…（保存时留空 = 不修改）'}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={joinAutoUpload} onCheckedChange={setJoinAutoUpload} />
            加入主号池成功后自动上传 sub2api（默认关闭）
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
              {testMutation.isPending ? <Loader2 className="animate-spin" /> : <Play className="h-4 w-4" />}
              测试连接
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="animate-spin" />}
              <Save className="h-4 w-4" />
              保存配置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>代理 IP 一键更换</CardTitle>
          <CardDescription>
            批量粘贴新代理（ip:端口:用户名:密码）自动换批：绑定在现有代理上的账号将随机均分改绑到新代理，改绑完成后删除旧代理
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm text-muted-foreground">
            当前 sub2api 内 {(remoteProxies?.items ?? []).length} 个代理 · 绑定账号合计{' '}
            {(remoteProxies?.items ?? []).reduce((sum, proxy) => sum + (proxy.account_count ?? 0), 0)} 个
          </div>
          <Button onClick={() => setReplaceOpen(true)} disabled={!config?.base_url}>
            <ArrowRightLeft className="h-4 w-4" />
            一键更换 IP
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>上传默认配置</CardTitle>
          <CardDescription>
            自动上传（加入主池自动上传 / 监控自动补号）使用这里的配置；手动批量上传时弹窗会以此为默认值
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>上传分组（留空 = 默认分组）</Label>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto rounded-md border p-2">
              {!config?.base_url && <span className="text-xs text-muted-foreground">请先保存连接配置后再选择分组</span>}
              {config?.base_url && (groups?.items ?? []).length === 0 && (
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
          <p className="text-xs text-muted-foreground">
            API 长上下文计费：账号超过 272K 上下文的请求按官方长上下文倍率计费（sub2api 账号级开关，默认开启）
          </p>
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

      <Card>
        <CardHeader>
          <CardTitle>号池监控</CardTitle>
          <CardDescription>
            {monitor?.running
              ? '巡检进行中…'
              : monitor?.last_check_at
                ? `上次巡检 ${formatRelativeTime(monitor.last_check_at)} · ${
                    monitor.last_result
                      ? `上轮：扫描 ${monitor.last_result.scanned ?? 0} / 异常 ${monitor.last_result.error_accounts} / 限流中 ${monitor.last_result.rate_limited ?? 0} / 待辅证 ${monitor.last_result.ban_unconfirmed ?? 0} / 在途修复 ${monitor.last_result.repair_pending ?? 0} / 废弃 ${monitor.last_result.discarded} / 发起修复 ${monitor.last_result.repairing} / 修复成功 ${monitor.last_result.repair_ok ?? 0} / 修复失败 ${monitor.last_result.repair_failed ?? 0} / 上传 ${monitor.last_result.uploaded ?? 0} / 补号 ${monitor.last_result.replenished}${monitor.last_result.available_count != null ? ` / 可用 ${monitor.last_result.available_count}` : ''}${monitor.last_result.stock_count != null ? ` / 主池库存 ${monitor.last_result.stock_count}` : ''}${monitor.last_result.fleet_concurrency != null ? ` / 在架并发 ${monitor.last_result.fleet_concurrency}` : ''}${monitor.last_result.fleet_initial_balance != null ? ` / 初始余额 $${monitor.last_result.fleet_initial_balance}` : ''}`
                      : '暂无结果'
                  }`
                : '尚未巡检'}
            {monitor?.next_check_at && monitor.enabled ? ` · 下次 ${formatRelativeTime(monitor.next_check_at)}` : ''}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch
              checked={monitorEnabled}
              onCheckedChange={(v) => {
                setMonitorEnabled(v);
              }}
            />
            启用监控巡检
          </label>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
            <div className="space-y-1.5">
              <Label>巡检间隔（分钟）</Label>
              <Input value={intervalMin} onChange={(e) => setIntervalMin(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>修复冷却（分钟）</Label>
              <Input value={cooldownMin} onChange={(e) => setCooldownMin(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>修复失败上限</Label>
              <Input value={maxRepair} onChange={(e) => setMaxRepair(e.target.value)} />
            </div>
            {replenishMode !== 'resource' && (
              <div className="space-y-1.5">
                <Label>sub2api 保底数量</Label>
                <Input value={reserveThreshold} onChange={(e) => setReserveThreshold(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>主池库存保底（备用池 → 主池）</Label>
              <Input
                value={mainStockThreshold}
                onChange={(e) => setMainStockThreshold(e.target.value)}
                placeholder="沿用 sub2api 保底"
              />
            </div>
            <div className="space-y-1.5">
              <Label>限流废弃阈值（小时）</Label>
              <Input value={rateLimitThreshold} onChange={(e) => setRateLimitThreshold(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            sub2api 保底管在架水位：低于先上传主池库存；主池库存保底管备用池登录补入水位（已登录未上传的号放久了会死，建议设小值）：0=
            不从备用池自动补入，留空 = 沿用 sub2api 保底数量
          </p>
          <p className="text-xs text-muted-foreground">
            远端限流（rate limit）重置时间距今超过阈值才移废弃池；短期限流（如 5h 窗口）保留主池等待自动恢复
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoRepair} onCheckedChange={setAutoRepair} />
            临时错误自动重登修复
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={refreshBalance} onCheckedChange={setRefreshBalance} />
            巡检时刷新已上传号的余额（优先经 sub2api 绑定代理查询）
          </label>
          {refreshBalance && (
            <div className="ml-6 max-w-[240px] space-y-1.5">
              <Label>余额刷新间隔（分钟，0=每轮）</Label>
              <Input value={balanceRefreshInterval} onChange={(e) => setBalanceRefreshInterval(e.target.value)} />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={autoReplenish} onCheckedChange={setAutoReplenish} />
            {replenishMode === 'resource'
              ? '低于保底自动补号（并发+余额口径）：总并发或初始总余额不达标先上传主池库存，主池库存数量低于「主池库存保底」再从备用池登录补入'
              : '低于保底自动补号：sub2api 缺号优先上传主池库存，主池库存低于「主池库存保底」再从备用池登录补入'}
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>补号口径</Label>
              <Select value={replenishMode} onValueChange={(v) => setReplenishMode(v === 'resource' ? 'resource' : 'count')}>
                <SelectTrigger className="w-full" aria-label="补号口径">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="count">按账号数量</SelectItem>
                    <SelectItem value="resource">按并发 + 余额</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            {replenishMode === 'resource' && (
              <>
                <div className="space-y-1.5">
                  <Label>总并发保底（在架号并发之和）</Label>
                  <Input value={concurrencyTarget} onChange={(e) => setConcurrencyTarget(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>初始总余额保底（$，登录时初始余额之和）</Label>
                  <Input value={initialBalanceTarget} onChange={(e) => setInitialBalanceTarget(e.target.value)} />
                </div>
                <p className="text-xs text-muted-foreground md:col-span-2">
                  统计范围为 sub2api 在架的本系统主池号（远端非 error，限流/暂停调度/待重授均计入），两项任一不达标即触发补号；
                  初始余额不随使用减少，只有号被废弃才会拉低总和。使用总并发保底需先在「上传默认」中配置每号并发。
                </p>
              </>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>上传顺序（主池库存 → sub2api）</Label>
              <Select value={replenishUploadOrder} onValueChange={setReplenishUploadOrder}>
                <SelectTrigger className="w-full" aria-label="补号上传顺序">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {UPLOAD_ORDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>补号顺序（备用池 → 主号池）</Label>
              <Select value={replenishJoinOrder} onValueChange={setReplenishJoinOrder}>
                <SelectTrigger className="w-full" aria-label="补号登录顺序">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {UPLOAD_ORDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm text-muted-foreground">分类正则（高级）</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>封禁关键词（一行一条）</Label>
                <Textarea value={bannedPatterns} onChange={(e) => setBannedPatterns(e.target.value)} className="font-mono text-xs" />
              </div>
              <div className="space-y-1.5">
                <Label>限流关键词（一行一条）</Label>
                <Textarea value={rateLimitPatterns} onChange={(e) => setRateLimitPatterns(e.target.value)} className="font-mono text-xs" />
              </div>
            </div>
          </details>
          {monitor?.last_error && <div className="text-sm text-destructive">上轮错误：{monitor.last_error}</div>}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => checkMutation.mutate()} disabled={checkMutation.isPending}>
              {checkMutation.isPending && <Loader2 className="animate-spin" />}
              立即巡检
            </Button>
            <Button onClick={() => saveMonitorMutation.mutate()} disabled={saveMonitorMutation.isPending}>
              {saveMonitorMutation.isPending && <Loader2 className="animate-spin" />}
              保存监控设置
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>巡检日志</CardTitle>
          <CardDescription>
            仅监控本系统上传的 OAuth 授权号（oauth---邮箱 命名的 free 号），API Key 账号与非本系统账号忽略 ·
            最近巡检记录与每个账号的处理动作（服务端保留最近 100 轮）
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(monitorLogs?.items ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground">暂无巡检记录，点击「立即巡检」或等待定时巡检</div>
          )}
          {(monitorLogs?.items ?? []).map((log) => (
            <details
              key={log.id}
              className="group rounded-lg border transition-colors open:bg-muted/30 hover:border-muted-foreground/30"
              open={log.status === 'running' || log.status === 'failed'}
            >
              <summary className="cursor-pointer select-none space-y-2 p-3 [&::-webkit-details-marker]:hidden">
                <div className="flex flex-wrap items-center gap-2">
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                  <span className="text-sm font-semibold tabular-nums">{formatDateTime(log.started_at)}</span>
                  <Badge variant="muted">{log.source === 'timer' ? '定时' : '手动'}</Badge>
                  <MonitorLogStatusBadge status={log.status} />
                  {durationSeconds(log) != null && (
                    <span className="text-xs tabular-nums text-muted-foreground">{durationSeconds(log)}s</span>
                  )}
                </div>
                {log.status === 'done' && <MonitorSummaryChips summary={log.summary} />}
                {log.status === 'failed' && log.error && (
                  <div className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{log.error}</div>
                )}
              </summary>
              <div className="px-3 pb-3">
                {log.items.length > 0 ? (
                  <div className="space-y-1.5">
                    {log.items.map((item, index) => (
                      <MonitorLogItemRow key={index} item={item} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
                    本轮无需处理的账号
                  </div>
                )}
              </div>
            </details>
          ))}
        </CardContent>
      </Card>

      <ReplaceProxyDialog open={replaceOpen} onOpenChange={setReplaceOpen} />
    </div>
  );
}

function ReplaceProxyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [protocol, setProtocol] = useState('http');
  const [deleteOld, setDeleteOld] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<Sub2ApiProxyReplaceResult | null>(null);

  const replaceMutation = useMutation({
    mutationFn: () => sub2apiApi.replaceProxies({ text, protocol, delete_old: deleteOld }),
    onSuccess: (data) => {
      setResult(data);
      setConfirming(false);
      const failed = data.create_failed.length + data.rebound.failed_groups.length;
      const skipped = data.old_proxies.skipped.length;
      const summary =
        `更换完成：新建 ${data.created.length} · 复用 ${data.reused.length} · 改绑账号 ${data.rebound.total}` +
        (data.rebound.failed_groups.length > 0 ? `（失败组 ${data.rebound.failed_groups.length}）` : '') +
        ` · 删除旧代理 ${data.old_proxies.deleted}` +
        (skipped > 0 ? `（跳过 ${skipped}）` : '');
      if (failed > 0 || skipped > 0) toast.warning(summary);
      else toast.success(summary);
      queryClient.invalidateQueries({ queryKey: ['sub2api', 'proxies'] });
    },
    onError: (error) => {
      setConfirming(false);
      toast.error(errorMessage(error));
    },
  });

  const busy = replaceMutation.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (busy) return;
          onOpenChange(next);
          if (!next) {
            setText('');
            setResult(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>一键更换代理 IP</DialogTitle>
            <DialogDescription>
              每行一条，格式 ip:端口:用户名:密码（无认证代理可只写 ip:端口），支持 # 注释行；与现有代理完全相同的行将复用而不重建
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'198.23.128.39:5667:cxzoljuy:cefn2yq3q0vn\n198.23.128.40:5667:cxzoljuy:cefn2yq3q0vn'}
              className="min-h-[160px] font-mono text-xs"
              spellCheck={false}
              disabled={busy}
            />
            <div className="grid grid-cols-2 items-end gap-3">
              <div className="space-y-1.5">
                <Label>代理协议</Label>
                <Select value={protocol} onValueChange={setProtocol} disabled={busy}>
                  <SelectTrigger aria-label="代理协议">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {['http', 'https', 'socks5', 'socks5h'].map((value) => (
                        <SelectItem key={value} value={value}>
                          {value}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <label className="flex items-center gap-2 pb-1 text-sm">
                <Switch checked={deleteOld} onCheckedChange={setDeleteOld} disabled={busy} />
                改绑完成后删除旧代理
              </label>
            </div>
            {result && <ReplaceResultView result={result} />}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              关闭
            </Button>
            <Button onClick={() => setConfirming(true)} disabled={busy || !text.trim()}>
              {busy && <Loader2 className="animate-spin" />}
              开始替换
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="确认一键更换代理 IP？"
        description="将创建新代理（名字自动续接编号），并把绑定在现有代理上的全部账号随机改绑到新代理；改绑完成后删除旧代理（仍有账号绑定的会自动跳过，不会误删）。此操作不可撤销。"
        confirmText="确认替换"
        onConfirm={() => replaceMutation.mutate()}
        busy={busy}
      />
    </>
  );
}

function ReplaceResultView({ result }: { result: Sub2ApiProxyReplaceResult }) {
  const problems = [
    ...result.create_failed.map((item) => `创建失败 ${item.proxy}：${item.reason}`),
    ...result.rebound.failed_groups.map((group) => `改绑失败 ${group.name || `#${group.proxy_id}`}（${group.count} 个账号）：${group.reason}`),
    ...result.old_proxies.skipped.map((item) => `旧代理 #${item.id} ${item.name} 未删除：${item.reason}`),
    ...result.invalid_lines.map((item) => `第 ${item.line} 行：${item.reason}`),
  ];
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>新建 {result.created.length}（编号 {result.name_start} 起）</span>
        <span>复用 {result.reused.length}</span>
        {result.duplicates_in_input > 0 && <span>输入重复 {result.duplicates_in_input}</span>}
        <span>改绑账号 {result.rebound.total}</span>
        <span>删除旧代理 {result.old_proxies.deleted}</span>
      </div>
      {result.rebound.groups.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {result.rebound.groups.map((group) => (
            <span key={group.proxy_id}>
              {group.name || `#${group.proxy_id}`} × {group.count}
            </span>
          ))}
        </div>
      )}
      {problems.length > 0 && (
        <div className="space-y-1 text-xs text-destructive">
          {problems.slice(0, 8).map((problem, index) => (
            <div key={index}>{problem}</div>
          ))}
          {problems.length > 8 && <div>…共 {problems.length} 条</div>}
        </div>
      )}
    </div>
  );
}

const MONITOR_ACTION_META: Record<string, { label: string; variant: 'danger' | 'warning' | 'info' | 'success' | 'muted' }> = {
  discarded: { label: '移入废弃池', variant: 'danger' },
  discard_failed: { label: '废弃失败', variant: 'danger' },
  ban_unconfirmed: { label: '待邮件辅证', variant: 'warning' },
  rate_limited_waiting: { label: '限流观察', variant: 'warning' },
  repairing: { label: '已发起修复', variant: 'info' },
  repair_pending: { label: '修复中·任务在途', variant: 'info' },
  repair_cooldown: { label: '修复冷却中', variant: 'muted' },
  repair_parked: { label: '已暂停·待重授', variant: 'warning' },
  repair_no_credentials: { label: '缺凭据·无法修复', variant: 'warning' },
  uploaded: { label: '已上传', variant: 'success' },
  upload_failed: { label: '上传失败', variant: 'danger' },
  ignored: { label: '未处理', variant: 'muted' },
};

/** 修复终态回执徽章：让「已发起修复」这一行有下文，能看出修好了还是修废了 */
const MONITOR_OUTCOME_META: Record<string, { label: string; variant: 'danger' | 'warning' | 'info' | 'success' | 'muted' }> = {
  ok: { label: '修复成功', variant: 'success' },
  failed: { label: '修复失败', variant: 'danger' },
  parked: { label: '转待重授', variant: 'warning' },
  followup: { label: '已转完整登录', variant: 'info' },
};

const MONITOR_REASON_LABELS: Record<string, string> = {
  banned_401: '封禁·邮件证实',
  banned_pattern: '封禁关键词',
  permanent_pattern: '永久封禁词',
  rate_limited_429: '限流/429',
  auto_repair: '临时错误',
  temp_error: '临时错误',
  auto_repair_off: '未开启自动修复',
  state_changed: '状态已变',
  repair_in_flight: '修复任务在途',
  repair_cooldown: '修复冷却',
  repair_parked: '连败熔断',
  repair_no_credentials: '缺凭据',
  replenish: '补号上传',
};

/** 摘要指标：状态量每轮都会重复出现，动作量只记本轮真正发生的事，chip 上标注清楚免得误读 */
function MonitorSummaryChips({ summary }: { summary: Sub2ApiMonitorLog['summary'] }) {
  type Tone = 'neutral' | 'warn' | 'danger' | 'info' | 'success';
  const chips: { label: string; value: number | null | undefined; tone: Tone; hint: string }[] = [
    { label: '扫描', value: summary.scanned, tone: 'neutral', hint: '本轮跟踪的号数（主池/备用池中在远端监控分组内的 OAuth 号）' },
    { label: '异常', value: summary.error_accounts, tone: 'warn', hint: '状态量：远端 status=error 的号数（可能正在修复中）' },
    { label: '限流中', value: summary.rate_limited, tone: 'warn', hint: '状态量：本轮观察到限流的号数；超过阈值会被废弃，同时计入「废弃」' },
    { label: '待辅证', value: summary.ban_unconfirmed, tone: 'warn', hint: '状态量：疑似封禁但未获邮件辅证，保留观察' },
    { label: '在途修复', value: summary.repair_pending, tone: 'info', hint: '状态量：修复任务在途、还没回执的号数' },
    { label: '废弃', value: summary.discarded, tone: 'danger', hint: '动作量：本轮真正移入废弃池的号数' },
    { label: '发起修复', value: summary.repairing, tone: 'info', hint: '动作量：本轮新提交的自动修复任务数（结果异步回执，见明细行）' },
    { label: '修复成功', value: summary.repair_ok, tone: 'success', hint: '动作量：距上轮以来回执成功的修复数' },
    { label: '修复失败', value: summary.repair_failed, tone: 'danger', hint: '动作量：距上轮以来回执失败的修复数（未达上限会冷却后重试）' },
    { label: '上传', value: summary.uploaded, tone: 'success', hint: '动作量：本轮从主池库存上传到远端的号数' },
    { label: '补号', value: summary.replenished, tone: 'success', hint: '动作量：本轮从备用池发起登录补入主池的号数' },
    { label: '可用', value: summary.available_count, tone: 'neutral', hint: '主池在远端非 error/非限流的号数 + 在途补号' },
    { label: '库存', value: summary.stock_count, tone: 'neutral', hint: '主池库存：未上传远端的 active 号数' },
  ];
  const toneClass = (tone: Tone, value: number) => {
    if (tone === 'neutral' || value <= 0) return 'text-muted-foreground';
    if (tone === 'warn') return 'text-amber-600';
    if (tone === 'danger') return 'text-destructive';
    if (tone === 'info') return 'text-blue-600';
    return 'text-emerald-600';
  };
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 pl-6">
      {chips
        .filter((chip) => chip.value != null)
        .map((chip) => (
          <span key={chip.label} className="inline-flex items-baseline gap-1" title={chip.hint}>
            <span className="text-xs text-muted-foreground">{chip.label}</span>
            <span className={cn('text-sm font-semibold tabular-nums', toneClass(chip.tone, chip.value ?? 0))}>
              {chip.value}
            </span>
          </span>
        ))}
    </div>
  );
}

function MonitorLogStatusBadge({ status }: { status: string }) {
  if (status === 'running') return <Badge variant="info">进行中…</Badge>;
  if (status === 'failed') return <Badge variant="danger">失败</Badge>;
  return <Badge variant="success">完成</Badge>;
}

function MonitorLogItemRow({ item }: { item: Sub2ApiMonitorLogItem }) {
  const meta = MONITOR_ACTION_META[item.action] ?? { label: item.action, variant: 'muted' as const };
  const outcome = item.outcome ? MONITOR_OUTCOME_META[item.outcome] : null;
  // 有回执时优先展示结论（修复成功/失败），触发原因留在 title 里
  const text = item.outcome_detail || item.detail;
  const tip = item.outcome_detail && item.detail ? `${item.detail}\n→ ${item.outcome_detail}` : text;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 px-2.5 py-1.5">
      <Badge variant={meta.variant}>{meta.label}</Badge>
      {outcome && <Badge variant={outcome.variant}>{outcome.label}</Badge>}
      <span className="font-mono text-xs">{item.email ?? `远端#${item.remote_id ?? '?'}`}</span>
      {item.reason && (
        <span className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {MONITOR_REASON_LABELS[item.reason] ?? item.reason}
        </span>
      )}
      {text && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={tip}>
          {text}
        </span>
      )}
    </div>
  );
}

function durationSeconds(log: Sub2ApiMonitorLog): number | null {
  if (!log.finished_at) return null;
  const ms = Date.parse(log.finished_at) - Date.parse(log.started_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.max(1, Math.round(ms / 1000));
}
