import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider, QueryCache } from '@tanstack/react-query';
import { Toaster, toast } from 'sonner';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { router } from './router';
import { Button } from '@/components/ui/button';
import './styles.css';

/**
 * 顶层错误边界：渲染期异常不再显示裸栈，而是给出可操作的界面，
 * 同时保留「复制错误详情」便于反馈问题。
 */
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('App crashed:', error, info.componentStack);
  }

  private copyDetails = async () => {
    const detail = `${String(this.state.error?.message)}\n\n${String(this.state.error?.stack)}`;
    try {
      await navigator.clipboard.writeText(detail);
      toast.success('错误详情已复制');
    } catch {
      toast.error('复制失败，请从控制台获取详情');
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <div className="app-surface w-full max-w-lg rounded-lg border bg-card p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-destructive/25 bg-destructive/10 text-destructive">
              <AlertTriangle className="size-4" />
            </div>
            <div className="min-w-0 space-y-1">
              <h1 className="text-base font-semibold">界面渲染出错</h1>
              <p className="text-sm text-muted-foreground">
                页面遇到未处理的异常。可以先重新加载；若反复出现，请把错误详情反馈给维护者。
              </p>
            </div>
          </div>

          <pre className="mt-4 max-h-40 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs text-muted-foreground">
            {String(this.state.error.message)}
          </pre>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw />
              重新加载
            </Button>
            <Button variant="outline" onClick={this.copyDetails}>
              复制错误详情
            </Button>
          </div>
        </div>
      </div>
    );
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      // 各列表页自行轮询；窗口聚焦再打一次纯属浪费请求
      refetchOnWindowFocus: false,
      staleTime: 2_000,
    },
  },
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof TypeError || /failed to fetch/i.test(String(error.message))) {
        toast.error('网络异常，请检查服务是否可达');
      }
    },
  }),
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AppErrorBoundary>
      <RouterProvider router={router} />
    </AppErrorBoundary>
    <Toaster richColors position="top-center" closeButton />
  </QueryClientProvider>,
);
