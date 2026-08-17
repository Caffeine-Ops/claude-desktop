import type { ScenarioCase, ScenarioCaseGallery } from '@desktop-shared/ipc-channels'

/**
 * SkillCaseShowcase 的纯选择器（无 React / 无 store 依赖，便于单测）。
 */

/** 案例区一页几张卡（原型：一排 5 张）。 */
export const SHOWCASE_PAGE_SIZE = 5

/** value（可能带 plugin 命名空间）→ 裸名。与 stores/scenarioCatalog 同一规则。 */
function bareSkillName(value: string): string {
  return value.replace(/^\//, '').replace(/^[\w-]+:/, '')
}

/**
 * 某个技能的案例。按【裸名】匹配：composer 里的 chip 可能是命名空间形态
 * （`/cowork:ppt-creator`）也可能是裸名（`/ppt-creator`），后台配的也可能是
 * 任一形态，四种组合都该命中同一批案例。保持后台配置顺序（运营靠上下移排序）。
 */
export function casesForSkill(
  gallery: ScenarioCaseGallery | null,
  skillValue: string
): readonly ScenarioCase[] {
  if (!gallery) return []
  const bare = bareSkillName(skillValue)
  return gallery.cases.filter((c) => bareSkillName(c.skill) === bare)
}

/** 总页数；空列表 0 页。 */
export function pageCount(total: number, size: number): number {
  if (total <= 0 || size <= 0) return 0
  return Math.ceil(total / size)
}

/**
 * 「换一批」的顺序翻页：第 page 页的切片，page 越界按页数取模回头。
 * 不做随机——随机会让「刚才那张」找不回来，顺序轮换总能翻回去。
 */
export function pageSlice<T>(items: readonly T[], page: number, size: number): readonly T[] {
  const pages = pageCount(items.length, size)
  if (pages === 0) return []
  const p = ((page % pages) + pages) % pages
  return items.slice(p * size, p * size + size)
}
