import { create } from 'zustand'
import type {
  ScenarioCatalog,
  ScenarioCatalogCategory,
  ScenarioCatalogPrompt
} from '@desktop-shared/ipc-channels'

import { DEFAULT_SCENARIO_CATALOG } from '../lib/scenarioCatalogDefaults'
import {
  FALLBACK_SKILL_ICON,
  applyRemoteSkillChipSpecs,
  findBuiltinSkillChipSpec,
  type SkillChipSpec
} from '../composer/skillChipRegistry'
import { applyRemoteScenarioSlashNames } from '../lib/scenarioSlash'

/**
 * 空态场景导航的配置源（2026-07-29）。分类 tab、技能 chip 的文案图标、
 * 每个技能的推荐 prompt，从「三个源码文件里的硬编码常量」改成「后台下发
 * 的一份 JSON + 内置默认表兜底」。
 *
 * 数据流：
 *
 *   sub2api 管理端配 JSON
 *     → main 的 scenarioCatalogService 在 login/冷启动时拉取、校验、落盘缓存
 *     → 本 store 经 SCENARIO_CATALOG_GET **读那份缓存**（不是发网络请求）
 *     → 分发到三个消费点：本 store 的 categories（rail 结构）、
 *       skillChipRegistry 的覆盖层（chip 长相）、scenarioSlash 的伪命令名单（发送前剥离）
 *
 * 为什么在模块加载时就 hydrate，而不是等 ScenarioRail 的 useEffect：空态
 * 是用户进 app 后最先看到的东西之一，等组件挂载再发 IPC，rail 会先用内置
 * 表画一遍、再跳变成远端表。模块加载远早于空态渲染，这次 IPC（进程内往返，
 * 无网络）通常在首帧前就 resolve 了。**即便没赶上也不会白屏**——初始 state
 * 就是内置默认表，最坏情况是一次内容切换，而不是一段空白。
 *
 * SSR 安全：初始 state 恒为内置表，与服务端渲染结果一致；hydrate 只在
 * 浏览器侧发生（`window.chatApi` 守卫），不会造成 hydration mismatch。
 */

interface ScenarioCatalogState {
  /** 当前生效的目录：远端拉到过就是远端那份，否则内置默认表。 */
  catalog: ScenarioCatalog
  /** 是否已被远端配置覆盖（调试/埋点用，UI 不依赖它分支）。 */
  isRemote: boolean
  /** 整体替换（内部用，广播与首次 hydrate 共用一条路径）。 */
  setCatalog: (catalog: ScenarioCatalog, isRemote: boolean) => void
}

export const useScenarioCatalogStore = create<ScenarioCatalogState>()((set) => ({
  catalog: DEFAULT_SCENARIO_CATALOG,
  isRemote: false,
  setCatalog: (catalog, isRemote) => {
    applyOverlays(catalog)
    set({ catalog, isRemote })
  }
}))

/**
 * 把目录里的 chip 外观与伪命令名单分发给两个模块级注册表。
 *
 * **必须在 set() 之前调用**：ScenarioRail 重渲染时会立刻 `findSkillChipSpec`
 * 查每个 chip 的图标文案，覆盖层晚一步就会用旧数据画一帧。
 */
function applyOverlays(catalog: ScenarioCatalog): void {
  const specs: SkillChipSpec[] = []
  const pseudoNames: string[] = []

  for (const cat of catalog.categories) {
    for (const item of cat.items) {
      if (item.kind !== 'skill') continue
      // 伪命令名单：漏登记会导致发送时剥不掉、原样发给 fusion-code
      // 被当未知命令（见 scenarioSlash.ts 的注释）。
      if (item.pseudo) pseudoNames.push(item.value.replace(/^\//, ''))

      // **每个远端 skill 条目都要注册**，哪怕它一个外观字段都没给。
      // ScenarioRail 渲染时 `findSkillChipSpec` 返回 null 的 chip 会被整条
      // 跳过（那是给「registry 里被移除的技能」准备的静默降级），所以后台
      // 新配一个内置表里没有的技能、又没写 label/icon 时，若这里因为
      // 「没给字段」而不注册，那个 chip 就人间蒸发了——配了却看不见，最难查。
      // 逐字段回落内置表，所以「只想调 prompts、外观沿用内置」的常见场景
      // 注册出来的 spec 与内置完全等价，不会抹掉任何东西。
      const builtin = findBuiltinSkillChipSpec(item.value)
      specs.push({
        match: item.value,
        // 图标三级回落：后台上传的 data URI > 内置切片名 > registry 内置图 >
        // 通用兜底。上传的排第一，是因为它是「后台明确指定过的东西」——配了
        // 却被打包资源盖住，会让人以为上传没生效。data URI 与静态路径在下游
        // 完全等价（两处消费方都是直接赋 <img src>），无需分支处理。
        image: item.iconData
          ? item.iconData
          : item.icon
            ? `/skill-icons/${item.icon}.png`
            : (builtin?.image ?? FALLBACK_SKILL_ICON),
        label: item.label ?? builtin?.label,
        description: item.description ?? builtin?.description
      })
    }
  }

  applyRemoteSkillChipSpecs(specs)
  applyRemoteScenarioSlashNames(pseudoNames)
}

/** value（可能带 plugin 命名空间）→ 裸名。 */
function bareSkillName(value: string): string {
  return value.replace(/^\//, '').replace(/^[\w-]+:/, '')
}

/**
 * 某个技能的推荐 prompt。按【裸名】索引：composer 里的 chip 可能是命名空间
 * 形态（`/claude-desktop:spreadsheets`，bundled 后端）也可能是裸名
 * （`/ppt-creator`，用户自装的同名 skill），两者共享同一份推荐 prompt。
 *
 * 同一个技能出现在多个分类里（ppt-creator 同时在「日常办公」和「设计创意」）
 * 时取第一次出现的那份——它们本就该是同一份配置，后台若配了两份不同的，
 * 取谁都是错的，不值得为这种误配加合并逻辑。
 */
export function scenarioPromptsFor(
  catalog: ScenarioCatalog,
  value: string
): readonly ScenarioCatalogPrompt[] | undefined {
  const bare = bareSkillName(value)
  for (const cat of catalog.categories) {
    for (const item of cat.items) {
      if (item.kind !== 'skill') continue
      if (bareSkillName(item.value) !== bare) continue
      if (item.prompts && item.prompts.length > 0) return item.prompts
    }
  }
  return undefined
}

/** 当前分类列表（rail 渲染直接用）。 */
export function useScenarioCategories(): readonly ScenarioCatalogCategory[] {
  return useScenarioCatalogStore((s) => s.catalog.categories)
}

/* ───────────────────────── hydrate ───────────────────────── */

let hydrated = false

/**
 * 读一次 main 侧缓存并订阅后续刷新。模块加载时自动跑一次（见文件末尾），
 * 幂等——重复调用只会命中 `hydrated` 守卫直接返回。
 */
export function hydrateScenarioCatalog(): void {
  if (hydrated) return
  const api = typeof window !== 'undefined' ? window.chatApi : undefined
  if (!api?.getScenarioCatalog) return
  hydrated = true

  void api
    .getScenarioCatalog()
    .then((res) => {
      if (res?.catalog) useScenarioCatalogStore.getState().setCatalog(res.catalog, true)
    })
    .catch((err: unknown) => {
      // 读缓存失败＝继续用内置表，没有任何补救动作可做（main 侧已经打过
      // 日志）。这里吞掉是为了不让一个 UI 配置问题冒泡成未处理 rejection。
      console.error('[scenarioCatalog] hydrate failed', err)
    })

  api.onScenarioCatalogChanged?.((catalog) => {
    if (catalog) useScenarioCatalogStore.getState().setCatalog(catalog, true)
  })
}

hydrateScenarioCatalog()
