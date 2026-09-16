/**
 * 受保护页面的唯一导航清单。
 *
 * Alt+数字 的序号、侧边栏顺序、快捷键提示三者必须一致，
 * 因此共用这一份定义，避免三处各写一遍后互相漂移。
 */
export interface NavRoute {
  to: string;
  label: string;
  /** 侧边栏分组标题 */
  section: string;
  /** 精确匹配（仅概览页需要，否则 / 会匹配所有路由） */
  exact?: boolean;
  /** 侧边栏角标：awaiting = 显示待输入任务数 */
  /** 是否出现在手机端底部「更多」菜单 */
  mobile?: boolean;
}

export const NAV_ROUTES: readonly NavRoute[] = [
  { to: '/', label: '概览', section: '工作台', exact: true, mobile: true },
  { to: '/pools/reserve', label: '备用号池', section: '账号号池', mobile: true },
  { to: '/pools/main', label: '主号池', section: '账号号池', mobile: true },
  { to: '/pools/discard', label: '废弃号池', section: '账号号池', mobile: true },
  { to: '/pools/team', label: 'Team号池', section: 'TEAM号池', mobile: true },
  { to: '/jobs', label: '任务中心', section: '系统管理', mobile: true },
  { to: '/proxies', label: '代理列表', section: '系统管理', mobile: true },
  { to: '/sub2api', label: 'Sub2API', section: '系统管理', mobile: true },
  { to: '/settings', label: '设置', section: '系统管理', mobile: true },
] as const;

/** Alt+N 的提示文案（序号从 1 开始）。 */
export function hotkeyHint(to: string): string | undefined {
  const index = NAV_ROUTES.findIndex((route) => route.to === to);
  return index >= 0 && index < 9 ? `Alt+${index + 1}` : undefined;
}

/** 按分组聚合，保持声明顺序（侧边栏渲染用）。 */
export function navSections(): { label: string; items: NavRoute[] }[] {
  const sections: { label: string; items: NavRoute[] }[] = [];
  for (const route of NAV_ROUTES) {
    let section = sections.find((item) => item.label === route.section);
    if (!section) {
      section = { label: route.section, items: [] };
      sections.push(section);
    }
    section.items.push(route);
  }
  return sections;
}
