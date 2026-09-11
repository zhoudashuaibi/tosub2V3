/**
 * 表格行选择：支持跨页保留、整页全选、以及「选中全部筛选结果」的排除式全选。
 *
 * 解决的既有问题：
 *  1. 切筛选/排序/翻页后 selected 里残留上一批 id（用户以为选中的是当前列表）
 *  2. 表头勾选框没有半选态，整页全选后看不出「部分选中」
 *  3. 无法跨页选择：整页全选只对当前页生效，勾选后翻页就丢
 *  4. 单行操作（点行内删除）会把整个批量选择覆盖成单条
 */
import { useCallback, useMemo, useState } from 'react';

export interface RowSelection {
  /** 已选 id 列表。排除式全选（isAllMode）时为空，此时应走「按筛选」的批量接口 */
  selectedIds: number[];
  /** 已选条数：排除式全选时为「总数 - 排除数」 */
  count: number;
  /** 是否处于「选中全部筛选结果」模式 */
  isAllMode: boolean;
  isSelected: (id: number) => boolean;
  toggle: (id: number) => void;
  /** 表头勾选：整页未全选 → 全选当前页；整页已全选 → 取消当前页 */
  toggleAll: () => void;
  /** 切换到「选中全部筛选结果」 */
  selectAllMatching: () => void;
  /** 用一组明确的 id 替换当前选择（「选中全部 N 条」拿到后端 id 列表后回填） */
  replace: (ids: number[]) => void;
  clear: () => void;
  /** 被排除的 id（仅排除式全选时有值） */
  excludedIds: number[];
  /** 表头勾选框状态：false / true / 'indeterminate' */
  headerState: boolean | 'indeterminate';
}

interface SelectionState {
  selected: Set<number>;
  allMode: boolean;
  excluded: Set<number>;
}

const EMPTY: SelectionState = { selected: new Set(), allMode: false, excluded: new Set() };

/**
 * @param items 当前页数据（需含 id）
 * @param total 当前筛选下的总条数（后端返回的 total）
 * @param resetKey 筛选/排序/页码的序列化字符串；变化时清空选择
 */
export function useRowSelection<T extends { id: number }>({
  items,
  total,
  resetKey,
}: {
  items: T[];
  total: number;
  resetKey: string;
}): RowSelection {
  const [state, setState] = useState<SelectionState>(EMPTY);
  // 「随 key 变化而重置」用派生状态实现，避免在渲染中 setState 触发额外一轮渲染
  const [boundKey, setBoundKey] = useState(resetKey);
  if (resetKey !== boundKey) {
    setBoundKey(resetKey);
    if (state !== EMPTY) setState(EMPTY);
  }

  const pageIds = useMemo(() => items.map((item) => item.id), [items]);

  const isSelected = useCallback(
    (id: number) => (state.allMode ? !state.excluded.has(id) : state.selected.has(id)),
    [state],
  );

  const toggle = useCallback((id: number) => {
    setState((prev) => {
      if (prev.allMode) {
        const excluded = new Set(prev.excluded);
        if (excluded.has(id)) excluded.delete(id);
        else excluded.add(id);
        return { ...prev, excluded };
      }
      const selected = new Set(prev.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...prev, selected };
    });
  }, []);

  const toggleAll = useCallback(() => {
    setState((prev) => {
      const allInPage = pageIds.length > 0 && pageIds.every((id) => (prev.allMode ? !prev.excluded.has(id) : prev.selected.has(id)));
      if (prev.allMode) {
        // 排除式全选下点表头：把当前页整体取消（逐条加入排除集合）
        const excluded = new Set(prev.excluded);
        for (const id of pageIds) {
          if (allInPage) excluded.add(id);
          else excluded.delete(id);
        }
        return { ...prev, excluded };
      }
      const selected = new Set(prev.selected);
      for (const id of pageIds) {
        if (allInPage) selected.delete(id);
        else selected.add(id);
      }
      return { ...prev, selected };
    });
  }, [pageIds]);

  const selectAllMatching = useCallback(() => {
    setState({ selected: new Set(), allMode: true, excluded: new Set() });
  }, []);

  const replace = useCallback((ids: number[]) => {
    setState({ selected: new Set(ids), allMode: false, excluded: new Set() });
  }, []);

  const clear = useCallback(() => setState(EMPTY), []);

  const count = state.allMode ? Math.max(0, total - state.excluded.size) : state.selected.size;

  // 派生列表：重置发生时 state 还是旧值，用 allMode/selected 同源判断避免「已清空但列表非空」的中间态
  const isCleared = resetKey === boundKey ? state === EMPTY : true;
  const selectedIds = useMemo(() => (isCleared ? [] : [...state.selected]), [isCleared, state.selected]);
  const excludedIds = useMemo(() => (isCleared ? [] : [...state.excluded]), [isCleared, state.excluded]);
  const effectiveCount = isCleared ? 0 : count;
  const effectiveAllMode = isCleared ? false : state.allMode;
  // 保持引用稳定：行组件依赖它做渲染判断
  const isSelectedStable = useCallback((id: number) => (isCleared ? false : isSelected(id)), [isCleared, isSelected]);

  const headerState = useMemo((): boolean | 'indeterminate' => {
    if (pageIds.length === 0) return false;
    const selectedInPage = pageIds.filter((id) => (state.allMode ? !state.excluded.has(id) : state.selected.has(id))).length;
    if (selectedInPage === 0) return false;
    if (selectedInPage === pageIds.length) return true;
    return 'indeterminate';
  }, [pageIds, state]);

  return {
    selectedIds,
    count: effectiveCount,
    isAllMode: effectiveAllMode,
    isSelected: isSelectedStable,
    toggle,
    toggleAll,
    selectAllMatching,
    replace,
    clear,
    excludedIds,
    headerState,
  };
}
