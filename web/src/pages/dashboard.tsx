import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Activity, CheckCircle2, Globe, Inbox, Users } from 'lucide-react';
import { dashboardApi } from '@/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/utils';

const EVENT_LABELS: Record<string, string> = {
  imported: '导入',
  mail_checked: '邮件检查',
  join_started: '开始加入主池',
  join_failed: '加入失败',
  join_succeeded: '加入主池成功',
  login_succeeded: '登录成功',
  login_failed: '登录失败',
  balance_refreshed: '余额刷新',
  uploaded_sub2api: '上传 sub2api',
  sub2api_replaced: '替换 sub2api 凭据',
  sub2api_linked: '关联远端账号',
  sub2api_unlinked: '远端账号已不存在',
  sub2api_duplicate: '远端存在重复账号',
  moved_to_discard: '移入废弃池',
  restored: '移回主池',
  auto_repair_started: '自动修复启动',
  totp_setup: '设置 2FA',
  deleted: '删除',
};

export function DashboardPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => dashboardApi.summary(),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  const totalProxies = data.proxies.alive + data.proxies.dead + data.proxies.cf_challenge + data.proxies.unknown;
  const poolsTotal = Math.max(1, data.pools.reserve + data.pools.main + data.pools.discard);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="备用池可用" value={data.reserve_available} sub={`共 ${data.pools.reserve} 个`} icon={Inbox} tone="info" />
        <StatCard
          title="主池可用"
          value={data.main_active}
          sub={`总余额 $${data.main_total_balance.toFixed(2)}`}
          icon={Users}
          tone="success"
        />
        <StatCard
          title="任务进行中"
          value={data.jobs.running}
          sub={`排队 ${data.jobs.queued} · 待输入 ${data.jobs.awaiting_input}`}
          icon={Activity}
          tone="warning"
        />
        <StatCard title="存活代理" value={data.proxies.alive} sub={`共 ${totalProxies} 条`} icon={Globe} tone="default" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">三池数量</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <PoolBar label="备用号池" value={data.pools.reserve} total={poolsTotal} colorClass="bg-primary" to="/pools/reserve" />
            <PoolBar label="主号池" value={data.pools.main} total={poolsTotal} colorClass="bg-[var(--success)]" to="/pools/main" />
            <PoolBar label="废弃号池" value={data.pools.discard} total={poolsTotal} colorClass="bg-destructive" to="/pools/discard" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-base">sub2api 监控</CardTitle>
            <Badge variant={data.monitor.enabled ? 'success' : 'muted'}>
              {data.monitor.enabled ? '已启用' : '未启用'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <div>上次巡检：{data.monitor.last_check_at ? formatRelativeTime(data.monitor.last_check_at) : '尚未巡检'}</div>
            {data.monitor.last_result && (
              <div>
                上轮结果：在途修复 {data.monitor.last_result.repair_pending ?? 0} · 废弃{' '}
                {data.monitor.last_result.discarded ?? 0} · 发起修复 {data.monitor.last_result.repairing ?? 0} · 修复成功{' '}
                {data.monitor.last_result.repair_ok ?? 0} · 修复失败 {data.monitor.last_result.repair_failed ?? 0} · 上传{' '}
                {data.monitor.last_result.uploaded ?? 0} · 补号 {data.monitor.last_result.replenished ?? 0}
              </div>
            )}
            {data.monitor.last_error && <div className="text-destructive">错误：{data.monitor.last_error}</div>}
            <Link to="/sub2api" className="inline-block pt-1 text-sm text-primary hover:underline">
              前往配置 →
            </Link>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">最近账号动态</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.recent_events.length === 0 ? (
            <div className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" /> 暂无动态，导入第一批邮箱开始使用
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.recent_events.map((event, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="w-40 px-6 py-2.5 text-muted-foreground">{formatRelativeTime(event.created_at)}</td>
                    <td className="py-2.5 font-mono text-xs">{event.email}</td>
                    <td className="py-2.5">{EVENT_LABELS[event.type] ?? event.type}</td>
                    <td className="max-w-[280px] truncate py-2.5 text-xs text-muted-foreground">
                      {event.detail ? JSON.stringify(event.detail).slice(0, 120) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PoolBar({
  label,
  value,
  total,
  colorClass,
  to,
}: {
  label: string;
  value: number;
  total: number;
  colorClass: string;
  to: string;
}) {
  const percent = Math.round((value / total) * 100);
  return (
    <Link to={to} className="block space-y-1.5 rounded-md p-1 transition-colors hover:bg-muted/50">
      <div className="flex items-center justify-between text-sm">
        <span>{label}</span>
        <span className="font-semibold">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${percent}%` }} />
      </div>
    </Link>
  );
}
