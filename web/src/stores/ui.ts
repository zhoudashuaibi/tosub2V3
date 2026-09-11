import { create } from 'zustand';

interface UiState {
  theme: 'light' | 'dark';
  sidebarCollapsed: boolean;
  /** 「待输入提醒」被手动忽略的时刻（epoch ms），5 分钟内不再显示 */
  alertDismissedAt: number;
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
  toggleSidebar: () => void;
  setAlertDismissedAt: (at: number) => void;
}

const THEME_KEY = 'tosub2-theme';
const SIDEBAR_KEY = 'tosub2-sidebar-collapsed';

/**
 * 主题用裸字符串读写，且初始值以 DOM class 为准。
 *
 * index.html 的首屏防闪脚本写的是裸字符串（`localStorage.setItem('tosub2-theme', 'dark')`），
 * 如果这里改用 JSON.parse 读同一个 key 会抛错并静默回退，主题记忆就失效了。
 * 以 DOM class 为初始来源同时也保证了与防闪脚本的结果一致。
 */
function readRaw(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下不可用，忽略 */
  }
}

function applyTheme(theme: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export const useUiStore = create<UiState>((set) => ({
  theme: typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  // 侧栏折叠状态此前不持久化，每次刷新都展开
  sidebarCollapsed: readRaw(SIDEBAR_KEY) === '1',
  alertDismissedAt: 0,
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      writeRaw(THEME_KEY, next);
      return { theme: next };
    }),
  setTheme: (theme) =>
    set(() => {
      applyTheme(theme);
      writeRaw(THEME_KEY, theme);
      return { theme };
    }),
  toggleSidebar: () =>
    set((state) => {
      const next = !state.sidebarCollapsed;
      writeRaw(SIDEBAR_KEY, next ? '1' : '0');
      return { sidebarCollapsed: next };
    }),
  setAlertDismissedAt: (at) => set(() => ({ alertDismissedAt: at })),
}));
