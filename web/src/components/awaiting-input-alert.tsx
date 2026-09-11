import { useEffect, useMemo, useState } from 'react';
import { Link, useMatchRoute } from '@tanstack/react-router';
import { Bell, X } from 'lucide-react';
import { toast } from 'sonner';
import { jobsApi } from '@/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useLiveList, useFirstSeen } from '@/hooks/use-live-list';
import { useUiStore } from '@/stores/ui';
import { cn } from '@/lib/utils';

/**
 * 全局「待输入」提醒。
 *
 * 既有问题：登录任务卡在验证码/密码输入时只体现在任务中心那一行的高亮上，
 * 用户切到号池页就完全感知不到，任务会一直挂到超时。
 *
 * 这里挂在侧边栏与顶栏上，用轻量计数接口轮询（stats_only=1，不拉任务行），
 * 新出现的待输入任务弹一次常驻 toast，已提醒过的 task id 记在 localStorage。
 */
export function AwaitingInputAlert() {
  const matchRoute = useMatchRoute();
  const { alertDismissedAt, setAlertDismissedAt } = useUiStore();

  const { data } = useLiveList({
    queryKey: ['jobs', 'awaiting-stats'],
    queryFn: () => jobsApi.stats(),
    interval: 10_000,
  });

  const awaiting = data?.stats.awaiting_input ?? 0;

  // 只对「新出现」的待输入任务弹一次：每条任务的 id 作为 key
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  useEffect(() => {
    if (awaiting === 0) {
      setPendingIds([]);
      return;
    }
    // 计数变了就重新拉一次 id（只在有待输入任务时才发生，代价很小）
    if (awaiting > pendingIds.length) {
      jobsApi
        .list({ status: 'awaiting_input', page_size: 20, items_only: '1' })
        .then((result) => setPendingIds(result.items.map((job) => job.id)))
        .catch(() => {});
    }
  }, [awaiting, pendingIds.length]);

  const seenKeys = useMemo(() => pendingIds, [pendingIds]);
  useFirstSeen(seenKeys, {
    storageKey: 'tosub2-awaiting-alerted',
    onFirstSeen: () => {
      // 一次批量提醒即可：toast 里说明清楚，不做逐条刷屏
      toast.warning('有账号登录任务在等待输入（验证码/密码/手机号）', {
        id: 'awaiting-input',
        duration: 12_000,
        description: '任务会一直等待到超时，请尽快处理',
        action: { label: '去处理', onClick: () => { window.location.href = '/jobs?status=awaiting_input'; } },
      });
    },
  });

  // 已进入任务中心时不必再占用顶栏视觉
  const onJobsPage = Boolean(matchRoute({ to: '/jobs', fuzzy: true }));
  const dismissedRecently = alertDismissedAt > 0 && Date.now() - alertDismissedAt < 5 * 60_000;

  if (awaiting === 0 || onJobsPage || dismissedRecently) return null;

  return (
    <div className="flex items-center gap-1">
      <Link
        to="/jobs"
        search={{ status: 'awaiting_input' }}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-2.5 py-1 text-xs font-medium text-[var(--warning)]',
          'transition-colors hover:bg-[var(--warning)]/20',
        )}
        title="有任务在等待人工输入"
      >
        <Bell className="size-3.5 animate-pulse" />
        <span className="tabular-nums">待输入 {awaiting}</span>
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="暂时忽略待输入提醒"
        title="5 分钟内不再显示"
        onClick={() => setAlertDismissedAt(Date.now())}
      >
        <X />
      </Button>
    </div>
  );
}
