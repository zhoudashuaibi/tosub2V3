import type { LucideIcon } from 'lucide-react';
import { Loader2, RefreshCw, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** 可点击的筛选徽章（替代散落在 4 个页面里的 aria-pressed + ring-2 复制粘贴）。 */
export function ToolbarChip({
  label,
  count,
  variant = 'muted',
  active,
  onClick,
  title,
}: {
  label: string;
  count?: number;
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'muted' | 'secondary';
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const badge = (
    <Badge
      variant={variant}
      className={cn(
        'tabular-nums',
        active ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'opacity-80',
        onClick && 'group-hover:opacity-100',
      )}
    >
      {label}
      {count !== undefined && ` ${count}`}
    </Badge>
  );
  if (!onClick) return badge;
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className="group cursor-pointer rounded-full focus-visible:outline-none"
    >
      {badge}
    </button>
  );
}

/**
 * 工具栏搜索框：统一图标、清空按钮与 `/` 聚焦快捷键。
 * `data-search-input` 供 use-hotkeys 定位。
 */
export function ToolbarSearch({
  value,
  onChange,
  placeholder = '搜索…',
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        data-search-input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="pl-8 pr-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="清空搜索"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** 列表页工具栏：统一换行与间距。 */
export function ListToolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>;
}

/** 工具栏里把内容推到右侧的弹性占位。 */
export function ToolbarSpacer() {
  return <div className="flex-1" />;
}

/** 表格右上角的刷新按钮（后台轮询之外的显式刷新入口）。 */
export function RefreshButton({ isRefreshing, onRefresh }: { isRefreshing?: boolean; onRefresh: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onRefresh} title="立即刷新" aria-label="立即刷新">
      {isRefreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
    </Button>
  );
}

/**
 * 列表容器：统一「骨架 / 空态 / 表格」三态。
 *
 * 既有实现每个页面各写一遍 `isLoading ? 骨架 : items.length===0 ? EmptyState : Table`，
 * 且后台轮询会把整表退回骨架 —— 这里按「首次加载」判定骨架，
 * 后台刷新只体现在调用方自己渲染的刷新按钮上。
 */
export function ListShell<T>({
  items,
  isLoading,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  emptyActionLabel,
  onEmptyAction,
  filtersActive,
  onClearFilters,
  skeletonRows = 6,
  header,
  footer,
  children,
  className,
}: {
  items: T[];
  isLoading: boolean;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  /** 有筛选条件时，空态应提示「清除筛选」而不是「导入第一批」 */
  filtersActive?: boolean;
  onClearFilters?: () => void;
  skeletonRows?: number;
  /** 表头行内容 */
  header?: React.ReactNode;
  /** 表尾（如统计行） */
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  if (isLoading) {
    return (
      <div className={cn('table-shell rounded-lg border bg-card', className)}>
        <div className="space-y-2 p-4">
          {Array.from({ length: skeletonRows }).map((_, index) => (
            <Skeleton key={index} className="h-10" />
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={cn('table-shell rounded-lg border bg-card', className)}>
        {filtersActive && onClearFilters ? (
          <EmptyState
            icon={emptyIcon}
            title="没有符合条件的结果"
            description="换个筛选条件，或清除全部筛选查看完整列表"
            actionLabel="清除筛选"
            onAction={onClearFilters}
          />
        ) : (
          <EmptyState
            icon={emptyIcon}
            title={emptyTitle}
            description={emptyDescription}
            actionLabel={emptyActionLabel}
            onAction={onEmptyAction}
          />
        )}
      </div>
    );
  }

  return (
    <div className={cn('table-shell overflow-hidden rounded-lg border bg-card', className)}>
      <Table>
        {header && (
          <TableHeader>
            <TableRow>{header}</TableRow>
          </TableHeader>
        )}
        <TableBody>{children}</TableBody>
      </Table>
      {footer}
    </div>
  );
}
