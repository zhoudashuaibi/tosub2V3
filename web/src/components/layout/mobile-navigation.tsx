import { Link, useMatchRoute } from '@tanstack/react-router';
import { Archive, Ellipsis, Globe, Inbox, LayoutDashboard, ListChecks, Server, Settings, Users, UsersRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/** 底部导航只放 4 个高频入口，其余进「更多」；图标与桌面侧边栏同源。 */
const ICONS: Record<string, LucideIcon> = {
  '/': LayoutDashboard,
  '/pools/reserve': Inbox,
  '/pools/main': Users,
  '/pools/discard': Archive,
  '/pools/team': UsersRound,
  '/jobs': ListChecks,
  '/proxies': Globe,
  '/sub2api': Server,
  '/settings': Settings,
};

const PRIMARY_NAV = [
  { label: '概览', to: '/', exact: true },
  { label: '备用池', to: '/pools/reserve' },
  { label: '主号池', to: '/pools/main' },
  { label: '任务', to: '/jobs' },
] as const;

const MORE_NAV = [
  { label: '废弃号池', to: '/pools/discard' },
  { label: 'Team号池', to: '/pools/team' },
  { label: '代理列表', to: '/proxies' },
  { label: 'Sub2API', to: '/sub2api' },
  { label: '设置', to: '/settings' },
] as const;

export function MobileNavigation() {
  const matchRoute = useMatchRoute();
  const moreActive = MORE_NAV.some((item) => matchRoute({ to: item.to, fuzzy: true }));

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur lg:hidden"
      aria-label="移动端导航"
    >
      <div className="grid grid-cols-5 gap-1">
        {PRIMARY_NAV.map((item) => {
          const active = matchRoute({ to: item.to, fuzzy: !('exact' in item && item.exact) });
          const Icon = ICONS[item.to] ?? Globe;
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex min-h-12 flex-col items-center justify-center gap-1 rounded-md text-[11px] text-muted-foreground',
                active && 'bg-accent font-medium text-primary',
              )}
            >
              <Icon className="size-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className={cn(
                'h-auto min-h-12 flex-col gap-1 px-1 text-[11px] text-muted-foreground',
                moreActive && 'bg-accent text-primary',
              )}
              aria-label="更多导航"
            >
              <Ellipsis />
              更多
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>更多功能</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {MORE_NAV.map((item) => {
                const Icon = ICONS[item.to] ?? Globe;
                return (
                  <DropdownMenuItem key={item.to} asChild>
                    <Link to={item.to} className="flex items-center gap-2">
                      <Icon />
                      {item.label}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
