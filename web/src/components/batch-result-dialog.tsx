import { AlertTriangle, CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useState } from 'react';

export interface BatchFailureItem {
  /** 失败对象标识：邮箱优先，其次显示 id */
  label: string;
  reason: string;
  /** 重试时使用的 id（可选，缺省表示该项不可重试） */
  id?: number;
}

export interface BatchResult {
  /** 操作名，用于标题，如「加入主号池」「上传 sub2api」 */
  action: string;
  /** 成功数 */
  succeeded: number;
  /** 跳过的条目（附原因） */
  skipped?: { label: string; reason: string }[];
  /** 失败的条目 */
  failed?: BatchFailureItem[];
  /** 结果统计里的补充说明行 */
  notes?: string[];
}

/**
 * 批量操作结果汇总。
 *
 * 既有的做法是把结果拼成一条 toast（失败信息最多 3 行、8 秒后消失），
 * 用户既看不全也无法据此重试。这里把成功/跳过/失败分区展示，并支持只重试失败项。
 */
export function BatchResultDialog({
  result,
  onOpenChange,
  onRetryFailed,
  retrying,
}: {
  result: BatchResult | null;
  onOpenChange: (open: boolean) => void;
  /** 提供后显示「仅重试失败项」按钮 */
  onRetryFailed?: (ids: number[]) => void;
  retrying?: boolean;
}) {
  const [showAllSkipped, setShowAllSkipped] = useState(false);
  const retryableIds = (result?.failed ?? []).map((item) => item.id).filter((id): id is number => typeof id === 'number');

  return (
    <Dialog open={Boolean(result)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{result?.action}：执行结果</DialogTitle>
          <DialogDescription>
            成功 {result?.succeeded ?? 0}
            {(result?.skipped?.length ?? 0) > 0 && ` · 跳过 ${result?.skipped?.length}`}
            {(result?.failed?.length ?? 0) > 0 && ` · 失败 ${result?.failed?.length}`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border border-[var(--success)]/25 bg-[var(--success)]/10 px-3 py-2 text-sm text-[var(--success)]">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{result?.succeeded ?? 0} 条操作已提交</span>
          </div>

          {(result?.notes?.length ?? 0) > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {result?.notes?.map((note) => <li key={note}>{note}</li>)}
            </ul>
          )}

          {(result?.skipped?.length ?? 0) > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-[var(--warning)]">
                <AlertTriangle className="size-4 shrink-0" />
                跳过 {result?.skipped?.length} 条
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-2 text-xs">
                {(showAllSkipped ? result?.skipped : result?.skipped?.slice(0, 8))?.map((item, index) => (
                  <li key={`${item.label}-${index}`} className="flex justify-between gap-3">
                    <span className="truncate font-mono">{item.label}</span>
                    <span className="shrink-0 text-muted-foreground">{item.reason}</span>
                  </li>
                ))}
                {(result?.skipped?.length ?? 0) > 8 && !showAllSkipped && (
                  <li>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                      onClick={() => setShowAllSkipped(true)}
                    >
                      <ChevronRight className="size-3" />展开全部 {result?.skipped?.length} 条
                    </button>
                  </li>
                )}
              </ul>
            </section>
          )}

          {(result?.failed?.length ?? 0) > 0 && (
            <section className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <XCircle className="size-4 shrink-0" />
                失败 {result?.failed?.length} 条
              </div>
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs">
                {result?.failed?.map((item, index) => (
                  <li key={`${item.label}-${index}`} className="flex justify-between gap-3">
                    <span className="truncate font-mono">{item.label}</span>
                    <span className={cn('shrink-0 max-w-[60%] truncate text-destructive')} title={item.reason}>
                      {item.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {onRetryFailed && retryableIds.length > 0 && (
            <Button disabled={retrying} onClick={() => onRetryFailed(retryableIds)}>
              {retrying ? '重试中…' : `仅重试失败项（${retryableIds.length}）`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
