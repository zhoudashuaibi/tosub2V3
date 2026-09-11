import { lazy, Suspense } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
} from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { authApi } from '@/api';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { AuthLayout } from '@/components/layout/auth-layout';
import { LoginPage } from '@/pages/login';

/**
 * 路由级代码分割。
 *
 * 原先是单 chunk 全量加载（约 685 KB），首屏必须解析完 team/sub2api 这些重页面才能渲染。
 * 拆开后首屏只加载概览与登录所需的代码，其余页面按导航命中时再取。
 */
const DashboardPage = lazy(() => import('@/pages/dashboard').then((m) => ({ default: m.DashboardPage })));
const ReservePoolPage = lazy(() => import('@/pages/pools/reserve').then((m) => ({ default: m.ReservePoolPage })));
const MainPoolPage = lazy(() => import('@/pages/pools/main').then((m) => ({ default: m.MainPoolPage })));
const DiscardPoolPage = lazy(() => import('@/pages/pools/discard').then((m) => ({ default: m.DiscardPoolPage })));
const TeamPoolPage = lazy(() => import('@/pages/pools/team').then((m) => ({ default: m.TeamPoolPage })));
const JobsPage = lazy(() => import('@/pages/jobs').then((m) => ({ default: m.JobsPage })));
const ProxiesPage = lazy(() => import('@/pages/proxies').then((m) => ({ default: m.ProxiesPage })));
const Sub2ApiPage = lazy(() => import('@/pages/sub2api').then((m) => ({ default: m.Sub2ApiPage })));
const SettingsPage = lazy(() => import('@/pages/settings').then((m) => ({ default: m.SettingsPage })));

/** 页面级骨架：与列表页加载态视觉一致，避免切换时闪白。 */
function PageSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-6 w-20" />
        ))}
      </div>
      <div className="table-shell space-y-2 rounded-lg border bg-card p-4">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
      </div>
    </div>
  );
}

/** 根路由：只挂全局 Provider，不做认证守卫（login 页必须在守卫之外）。 */
function RootLayout() {
  return (
    <TooltipProvider delayDuration={200}>
      <Outlet />
    </TooltipProvider>
  );
}

/** 认证守卫布局：session 探测 + 未登录跳转。所有受保护页面挂在这下面。 */
function AuthGuardLayout() {
  const { data: session, isLoading } = useQuery({
    queryKey: ['session'],
    queryFn: () => authApi.session(),
    staleTime: 60_000,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 animate-pulse items-center justify-center rounded-lg bg-primary font-bold text-primary-foreground">
            S2
          </div>
          <div className="text-sm text-muted-foreground">toSub2 控制台加载中…</div>
        </div>
      </div>
    );
  }

  if (!session?.authenticated) {
    return <Navigate to="/login" />;
  }

  return <Outlet />;
}

const rootRoute = createRootRoute({ component: RootLayout });

const authLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_auth',
  component: AuthGuardLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

/** 列表页的 URL 查询参数：宽松解析，非法值回退默认，保证手改 URL 不炸。 */
function listSearch(search: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'page' || key === 'page_size') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) out[key] = parsed;
      continue;
    }
    out[key] = String(value);
  }
  return out;
}

const indexRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/',
  component: withLayout('概览', DashboardPage),
});

const reserveRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/reserve',
  validateSearch: listSearch,
  component: withLayout('备用号池', ReservePoolPage),
});

const mainRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/main',
  validateSearch: listSearch,
  component: withLayout('主号池', MainPoolPage),
});

const discardRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/discard',
  validateSearch: listSearch,
  component: withLayout('废弃号池', DiscardPoolPage),
});

const teamRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/pools/team',
  component: withLayout('Team号池', TeamPoolPage),
});

const jobsRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/jobs',
  validateSearch: listSearch,
  component: withLayout('任务中心', JobsPage),
});

const proxiesRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/proxies',
  validateSearch: listSearch,
  component: withLayout('代理列表', ProxiesPage),
});

const sub2apiRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/sub2api',
  component: withLayout('Sub2API 管理', Sub2ApiPage),
});

const settingsRoute = createRoute({
  getParentRoute: () => authLayoutRoute,
  path: '/settings',
  component: withLayout('设置', SettingsPage),
});

function withLayout(title: string, Page: React.LazyExoticComponent<React.ComponentType>) {
  function Wrapped() {
    return (
      <AuthLayout title={title}>
        <Suspense fallback={<PageSkeleton />}>
          <Page />
        </Suspense>
      </AuthLayout>
    );
  }
  Wrapped.displayName = `Page(${title})`;
  return Wrapped;
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  authLayoutRoute.addChildren([
    indexRoute,
    reserveRoute,
    mainRoute,
    discardRoute,
    teamRoute,
    jobsRoute,
    proxiesRoute,
    sub2apiRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// client.ts 触发的 401 事件 → 回登录页
if (typeof window !== 'undefined') {
  window.addEventListener('tosub2:unauthorized', () => {
    if (window.location.pathname !== '/login') window.location.href = '/login';
  });
}
