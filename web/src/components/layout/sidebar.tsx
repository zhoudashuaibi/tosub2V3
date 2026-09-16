import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Archive,
  Globe,
  Inbox,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Users,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';
import { hotkeyHint, navSections } from '@/lib/nav';

/** 路由 → 图标。nav.ts 保持纯数据（无 React 依赖），图标映射放在这里。 */
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

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUiStore();
  const matchRoute = useMatchRoute();
  return (
    <aside
      className={cn(
        'app-sidebar hidden h-dvh flex-col text-sidebar-foreground transition-[width] duration-300 lg:flex',
        sidebarCollapsed ? 'w-[72px]' : 'w-[252px]',
      )}
    >
      <div className="flex h-14 items-center gap-2.5 px-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
          S2
        </div>
        {!sidebarCollapsed && (
          <div className="min-w-0">
            <span className="block truncate text-sm font-semibold text-sidebar-foreground">toSub2</span>
            <span className="block truncate text-[11px] text-sidebar-foreground/55">账号池控制台</span>
          </div>
        )}
      </div>
      <Separator className="bg-sidebar-border" />
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="flex flex-col gap-5">
          {navSections().map((section) => (
            <div key={section.label} className="flex flex-col gap-1">
              {!sidebarCollapsed && (
                <span className="px-2 text-[11px] font-medium text-sidebar-foreground/45">{section.label}</span>
              )}
              {section.items.map((item) => {
                const active = matchRoute({ to: item.to, fuzzy: !item.exact });
                const Icon = ICONS[item.to] ?? Globe;
                const hint = hotkeyHint(item.to);

                const link = (
                  <Link
                    to={item.to}
                    className={cn(
                      'group flex h-10 items-center gap-3 rounded-md px-2.5 text-sm transition-colors',
                      active
                        ? 'bg-sidebar-accent font-medium text-sidebar-foreground'
                        : 'text-sidebar-foreground/72 hover:bg-sidebar-accent hover:text-sidebar-foreground',
                      sidebarCollapsed && 'justify-center px-0',
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    {!sidebarCollapsed && hint && (
                      <kbd className="ml-auto hidden text-[10px] text-sidebar-foreground/40 group-hover:inline">{hint}</kbd>
                    )}
                  </Link>
                );

                if (!sidebarCollapsed) return <span key={item.to}>{link}</span>;
                return (
                  <Tooltip key={item.to}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">
                      {item.label}
                      {hint ? `（${hint}）` : ''}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </nav>
      </ScrollArea>
      <div className="p-3">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'w-full text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground',
            sidebarCollapsed ? 'justify-center px-0' : 'justify-start',
          )}
          onClick={toggleSidebar}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          {!sidebarCollapsed && '收起侧边栏'}
        </Button>
      </div>
    </aside>
  );
}
