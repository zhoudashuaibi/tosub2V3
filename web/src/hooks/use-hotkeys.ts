/**
 * 全局快捷键。
 *
 * 刻意只用修饰键与「g 前缀序列」两种形式，避开中文输入法的直接字符冲突
 * （例如单独按 j/k 在拼音输入中会被吞掉）。
 *
 *   Alt+1..9        跳转对应页面
 *   /               聚焦当前页搜索框
 *   Esc             关闭最上层对话框（Radix 自身处理，这里不重复接管）
 *   g 然后 j/p/s    跳任务中心 / 代理 / 设置（1.5s 内完成）
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { NAV_ROUTES } from '@/lib/nav';

const G_SEQUENCES: Record<string, string> = {
  j: '/jobs',
  p: '/proxies',
  r: '/pools/reserve',
  m: '/pools/main',
  d: '/pools/discard',
  t: '/pools/team',
  u: '/sub2api',
  s: '/settings',
  h: '/',
};

/** 正在输入时不应劫持按键。 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** 聚焦当前页面里的第一个搜索框（工具栏搜索统一带 data-search-input）。 */
export function focusPageSearch(): boolean {
  const input = document.querySelector<HTMLInputElement>('input[data-search-input]');
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

export function useHotkeys() {
  const navigate = useNavigate();
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Alt+数字：跨平台都可用的页面跳转
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const target = NAV_ROUTES[Number(event.key) - 1];
        if (!target) return;
        event.preventDefault();
        void navigate({ to: target.to });
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === '/') {
        if (focusPageSearch()) event.preventDefault();
        return;
      }

      // g 前缀序列
      if (event.key === 'g') {
        pendingG.current = Date.now();
        return;
      }
      if (pendingG.current !== null && Date.now() - pendingG.current < 1500) {
        const to = G_SEQUENCES[event.key.toLowerCase()];
        pendingG.current = null;
        if (to) {
          event.preventDefault();
          void navigate({ to });
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}
