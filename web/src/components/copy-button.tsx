import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 复制到剪贴板 + 1.5s 成功反馈。复制失败（非安全上下文等）时回退到选中文本提示。 */
export function CopyButton({
  value,
  label = '复制',
  className,
  size = 'icon-sm',
  variant = 'ghost',
}: {
  value: string;
  label?: string;
  className?: string;
  size?: 'sm' | 'icon' | 'icon-sm';
  variant?: 'ghost' | 'outline' | 'secondary';
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（http 非 localhost / 权限被拒）时静默失败，不做假成功提示
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={cn('shrink-0', className)}
      onClick={copy}
      title={copied ? '已复制' : label}
      aria-label={label}
    >
      {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
    </Button>
  );
}
