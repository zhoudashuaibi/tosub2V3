import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LogOut, Moon, RefreshCw, Sun } from 'lucide-react';
import { toast } from 'sonner';
import { authApi } from '@/api';
import { errorMessage } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useUiStore } from '@/stores/ui';

export function Header({ title }: { title: string }) {
  const { theme, toggleTheme } = useUiStore();
  const queryClient = useQueryClient();

  const logout = useMutation({
    mutationFn: () => authApi.logout(),
    onSuccess: () => {
      queryClient.clear();
      window.location.href = '/login';
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const refreshAll = useMutation({
    mutationFn: () => queryClient.invalidateQueries(),
    onSuccess: () => toast.success('已刷新全部数据'),
  });

  return (
    <header className="app-header sticky top-0 z-20 border-b px-4 lg:px-8">
      <div className="flex h-14 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground lg:hidden">
            S2
          </div>
          <div className="min-w-0">
            <div className="hidden text-xs text-muted-foreground sm:block">账号池管理</div>
            <h1 className="truncate text-base font-semibold">{title}</h1>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => refreshAll.mutate()}
                aria-label="刷新全部数据"
                disabled={refreshAll.isPending}
              >
                <RefreshCw className={refreshAll.isPending ? 'animate-spin' : undefined} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>刷新全部数据</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题">
                {theme === 'dark' ? <Sun /> : <Moon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{theme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={() => logout.mutate()} aria-label="退出登录" disabled={logout.isPending}>
                <LogOut />
              </Button>
            </TooltipTrigger>
            <TooltipContent>退出登录</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
