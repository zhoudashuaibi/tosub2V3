/**
 * 轮询列表的统一语义。
 *
 * 既有实现的问题：6 个页面各自手写 refetchInterval + useQuery，导致
 *  - 每次后台轮询返回都把整张表退回骨架屏（isLoading 在重新挂载/无 placeholder 时为 true）
 *  - 没有区分「首次加载」与「后台刷新」，用户看不出数据是否在更新
 *  - 窗口重新聚焦又触发一次完整请求（轮询已经覆盖，纯浪费）
 *
 * 这里把三件事固定下来：placeholderData、仅首次加载显示骨架、后台刷新标志位。
 */
import { keepPreviousData, useQuery, type UseQueryOptions, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export interface LiveListResult<T> {
  data: T | undefined;
  /** 首次加载（无任何数据可渲染）→ 调用方显示骨架 */
  isLoading: boolean;
  /** 后台刷新中（已有数据，正在取新一轮）→ 调用方显示轻量指示器 */
  isRefreshing: boolean;
  /** 请求失败时的错误对象 */
  error: unknown;
  /** 手动触发一次刷新 */
  refresh: () => void;
}

export function useLiveList<T>({
  queryKey,
  queryFn,
  /** 轮询间隔（ms）；传 false 关闭轮询 */
  interval,
  /** 为 true 时按间隔轮询，否则停止（例如列表里没有活跃项时） */
  enabled = true,
}: {
  queryKey: QueryKey;
  queryFn: () => Promise<T>;
  interval: number | false;
  enabled?: boolean;
}): LiveListResult<T> {
  const query = useQuery<T>({
    queryKey,
    queryFn,
    refetchInterval: interval === false || !enabled ? false : interval,
    // 轮询已经在跑，窗口聚焦再打一次纯属浪费
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  } as UseQueryOptions<T>);

  return {
    data: query.data,
    // isPending 在有 placeholderData 时不会因为后台刷新变 true
    isLoading: query.isPending && query.data === undefined,
    isRefreshing: query.isFetching && query.data !== undefined,
    error: query.error,
    refresh: () => void query.refetch(),
  };
}

/**
 * 记录「首次出现」的键集合，用于对新出现的项做一次性提醒（如待输入任务）。
 * 已提醒过的键持久化到 localStorage，刷新页面不会重复打扰。
 */
export function useFirstSeen(
  keys: string[],
  { storageKey, onFirstSeen }: { storageKey: string; onFirstSeen: (key: string) => void },
) {
  const seenRef = useRef<Set<string> | null>(null);
  const onFirstSeenRef = useRef(onFirstSeen);
  onFirstSeenRef.current = onFirstSeen;

  if (seenRef.current === null) {
    try {
      const raw = localStorage.getItem(storageKey);
      seenRef.current = new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      seenRef.current = new Set<string>();
    }
  }

  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  useEffect(() => {
    if (!ready || seenRef.current === null) return;
    const seen = seenRef.current;
    let changed = false;
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      changed = true;
      onFirstSeenRef.current(key);
    }
    if (changed) {
      // 只保留最近 500 条，避免无限增长
      const trimmed = [...seen].slice(-500);
      seenRef.current = new Set(trimmed);
      try {
        localStorage.setItem(storageKey, JSON.stringify(trimmed));
      } catch {
        /* 隐私模式下 localStorage 可能不可用 */
      }
    }
  }, [keys, ready, storageKey]);

  return ready;
}
