/**
 * 列表页的「状态 ↔ URL」同步。
 *
 * 为什么需要：当前所有筛选/排序/分页都只存在组件 useState 里，刷新即丢失、
 * 无法分享链接、浏览器后退也回不到上一个筛选。这里把 URLSearchParams 作为唯一真相，
 * 用 history.replaceState 写入（不产生历史记录堆积，详情展开靠浏览器自身的返回）。
 *
 * 用 replaceState 而不是 router.navigate：
 *  - 不重挂路由组件，避免输入框失焦
 *  - 与页面卸载/挂载节奏无关，无需等 router 的异步状态
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type ListParamValues = Record<string, string | number | undefined | null>;

/** 解析当前 URL 的查询串为普通对象（不含 ? 前缀）。 */
export function readListParams(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(window.location.search)) {
    if (key === 'v') continue; // 版本戳（router 缓存失效用）不属于业务状态
    out[key] = value;
  }
  return out;
}

function writeListParams(params: ListParamValues, defaults: ListParamValues) {
  if (typeof window === 'undefined') return;
  const next = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(params)) {
    // 空串只有在默认值本身也为空时才算默认：默认值非空（如「废弃时间默认今天」）时，
    // 用户主动清空必须以 `key=` 留在 URL 里，否则刷新后会被默认值顶回去
    const isDefault = value === undefined || value === null || String(value) === String(defaults[key] ?? '');
    if (isDefault) next.delete(key);
    else next.set(key, String(value));
  }
  const query = next.toString();
  const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

export interface ListUrlStateOptions<T extends ListParamValues> {
  /**
   * 默认值：等于默认值的参数不会写进 URL，保持链接干净。
   * 默认值非空的参数被设为 '' 时会写成 `key=`，读回来仍是 ''（表示「用户清空了」而非「用默认」）。
   */
  defaults: T;
}

/**
 * 列表筛选状态。返回受控的 values 与 setter。
 *
 * @example
 * const filters = useListUrlState({ defaults: { q: '', status: '', page: 1 } });
 * filters.values.status    // 当前筛选
 * filters.set({ status: 'failed', page: 1 })
 * filters.reset()
 */
export function useListUrlState<T extends ListParamValues>({ defaults }: ListUrlStateOptions<T>) {
  // 默认值对象每次渲染都是新引用，用 ref 固定首次的键集合语义
  const defaultsRef = useRef(defaults);
  const keys = useMemo(() => Object.keys(defaultsRef.current), []);

  const [values, setValues] = useState<T>(() => {
    const params = readListParams();
    const initial = {} as ListParamValues;
    for (const key of Object.keys(defaultsRef.current)) {
      initial[key] = params[key] ?? defaultsRef.current[key];
    }
    return initial as T;
  });

  const set = useCallback(
    (patch: Partial<T>) => {
      setValues((prev) => {
        const next = { ...prev, ...patch } as T;
        writeListParams(patch as ListParamValues, defaultsRef.current);
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    const cleared = {} as ListParamValues;
    for (const key of keys) cleared[key] = defaultsRef.current[key];
    writeListParams(
      Object.fromEntries(keys.map((key) => [key, undefined])),
      defaultsRef.current,
    );
    setValues(cleared as T);
  }, [keys]);

  const hasActiveFilters = useMemo(
    () => keys.some((key) => String(values[key] ?? '') !== String(defaultsRef.current[key] ?? '')),
    [keys, values],
  );

  return { values, set, reset, hasActiveFilters, keys };
}

/**
 * 防抖输入：本地立即回显，延迟后才写回 URL/触发查询，避免每敲一个字打一次接口。
 */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
    // debounced 参与比较但不作为依赖：否则会自触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delay]);
  return debounced;
}

/**
 * 搜索框绑定：本地受控 + 防抖同步到 URL。
 * 返回的 inputProps 直接展开到 <input> 上。
 */
export function useSearchParam({ value, onChange, delay = 250 }: { value: string; onChange: (next: string) => void; delay?: number }) {
  const [local, setLocal] = useState(value);
  const debounced = useDebouncedValue(local, delay);
  const committed = useRef(value);
  // onChange 通常是内联箭头函数（每次渲染新引用）→ 存进 ref 避免把 effect 变成每次都跑
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // URL 被外部改变（如「清除筛选」）时回灌本地输入
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setLocal(value);
    }
  }, [value]);

  useEffect(() => {
    if (debounced === committed.current) return;
    committed.current = debounced;
    onChangeRef.current(debounced);
  }, [debounced]);

  const reset = useCallback(() => {
    committed.current = '';
    setLocal('');
  }, []);

  return { value: local, setValue: setLocal, reset };
}
