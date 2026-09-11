import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FilterSelect } from '@/components/filter-select';
import { cn } from '@/lib/utils';

export const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;

/**
 * 列表分页条。
 *
 * 既有问题：号池页写死 page_size=200 且完全没有分页控件，
 * 第 201 条之后的账号在界面上「不存在」，而 total 其实早就拿到了。
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  className,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  className?: string;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground', className)}>
      <span className="tabular-nums">
        共 {total} 条{total > 0 && ` · 当前显示 ${from}-${to}`}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {onPageSizeChange && (
          <FilterSelect
            value={String(pageSize)}
            onValueChange={(next) => onPageSizeChange(Number(next) || pageSize)}
            label="每页条数"
            className="w-[112px]"
            options={PAGE_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `每页 ${size}` }))}
          />
        )}
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft />
          上一页
        </Button>
        <span className="tabular-nums px-1">
          第 {page} / {totalPages} 页
        </span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          下一页
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
