import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  // 48 小时内统一按小时显示，避免出现「1 天前」；超过 48 小时才按天显示。
  if (hours < 48) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function formatBalance(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未查询';
  return `$${Number(value).toFixed(2)}`;
}

export function joinEmails(emails: string[], max = 5): string {
  if (emails.length <= max) return emails.join('、');
  return `${emails.slice(0, max).join('、')} 等 ${emails.length} 个账户`;
}
