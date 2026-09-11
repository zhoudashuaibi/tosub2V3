import { useCallback, useState } from 'react';
import type { UploadOrder } from '@/api/types';
import { FilterSelect } from '@/components/filter-select';

/** 批量「加入主号池 / 上传 sub2api」顺序选项，取值与后端 UPLOAD_ORDERS 一一对应 */
export const UPLOAD_ORDER_OPTIONS = [
  { value: 'balance_desc', label: '金额从大到小' },
  { value: 'balance_asc', label: '金额从小到大' },
  { value: 'time_desc', label: '加入号池时间从近到远' },
  { value: 'time_asc', label: '加入号池时间从远到近' },
];

/** 顺序偏好记忆：各页面用独立 key，空串 = 按勾选顺序（默认） */
export function useOrderPreference(storageKey: string): [UploadOrder | '', (value: UploadOrder | '') => void] {
  const [order, setOrder] = useState<UploadOrder | ''>(() => (localStorage.getItem(storageKey) as UploadOrder) ?? '');
  const change = useCallback(
    (value: UploadOrder | '') => {
      setOrder(value);
      localStorage.setItem(storageKey, value);
    },
    [storageKey],
  );
  return [order, change];
}

export function UploadOrderSelect({
  value,
  onValueChange,
  size = 'default',
}: {
  value: UploadOrder | '';
  onValueChange: (value: UploadOrder | '') => void;
  size?: 'sm' | 'default';
}) {
  return (
    <FilterSelect
      value={value}
      onValueChange={(next) => onValueChange(next === '' ? '' : (next as UploadOrder))}
      label="按选择顺序（默认）"
      className={size === 'sm' ? 'w-[200px]' : 'w-full'}
      size={size}
      options={UPLOAD_ORDER_OPTIONS}
    />
  );
}
