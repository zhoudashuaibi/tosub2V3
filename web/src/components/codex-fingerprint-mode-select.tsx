import type { CodexFingerprintMode } from '@/api/types';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * Codex 指纹收敛选项：取值与 sub2api 账号 extra.codex_fingerprint_mode 一一对应
 * （sub2api 账号编辑页同款四档）。off = 不写该 extra 键，原样透传客户端设备/会话标识。
 */
export const CODEX_FINGERPRINT_MODE_OPTIONS: ReadonlyArray<{ value: CodexFingerprintMode; label: string }> = [
  { value: 'off', label: '关闭（透传，默认）' },
  { value: 'device', label: '仅设备' },
  { value: 'session', label: '设备+会话' },
  { value: 'full', label: '完全收敛' },
];

/**
 * 说明文案：把「为什么默认关」与「开了有什么风险」写清楚，避免顺手开满档导致额度缩水。
 * 末句交代生效范围：extra 与其它同类选项一样只在「新增」路径写入，替换凭据分支不覆盖远端 extra。
 */
export const CODEX_FINGERPRINT_MODE_HINT =
  '多人共享同一 OAuth 账号时，将各用户的设备/会话标识收敛为账号级恒定值，减少上游可见的设备数和会话数。默认关闭（原样透传客户端标识），需要时再显式开启；部分账号开启收敛后出现过额度缩水，请按自己的实测结果选择。新增账号时写入 sub2api extra，已有账号走「替换凭据」分支不改动该项（与禁用 5h/7d 暂停等同口径）。';

/** 归一化：仅接受四档合法值，其余（含 undefined/空串）一律按 off */
export function normalizeCodexFingerprintMode(value: unknown): CodexFingerprintMode {
  return CODEX_FINGERPRINT_MODE_OPTIONS.some((option) => option.value === value)
    ? (value as CodexFingerprintMode)
    : 'off';
}

export function CodexFingerprintModeSelect({
  value,
  onValueChange,
  label = 'Codex 指纹收敛',
  className = 'w-full',
}: {
  value: CodexFingerprintMode;
  onValueChange: (value: CodexFingerprintMode) => void;
  label?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(normalizeCodexFingerprintMode(next))}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {CODEX_FINGERPRINT_MODE_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
