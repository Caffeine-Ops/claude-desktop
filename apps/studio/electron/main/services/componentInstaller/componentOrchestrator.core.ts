// componentOrchestrator 的纯核：electron-free、零 IO，可 bun test 直接单测（无需 mock.module
// 打桩 'electron'）。只放不碰 fs/子进程/electron 的纯函数；拆分理由见 componentOrchestrator.ts
// 头注释——把「纯核」和「electron 编排」焊在同一文件会导致单测这两个纯函数也得绕开顶层
// import 链里的 electron 依赖。对齐既有先例：kbStore.core.ts / kbLocalSync.core.ts /
// proposalRetrieve.core.ts / proposalSemantic.core.ts / proposalVerify.core.ts。
import {
  initialComponentState, type ComponentState, type ComponentStatus, type ComponentTable,
} from '../../../shared/componentDownload'
import type { KbToolingInstallResult } from '../../../shared/kbAdmin'

/** 不可变地更新一格；未知 id 先补初态。 */
export function applyComponentPatch(
  table: ComponentTable, id: string, patch: Partial<ComponentState>,
): ComponentTable {
  const cur = table[id] ?? initialComponentState(id)
  return { ...table, [id]: { ...cur, ...patch } }
}

/** pipx 安装结果 → 状态标签。unsupported=缺 python 前置（装不了）；普通失败带 log 摘要供排查。 */
export function mapPipxResult(r: KbToolingInstallResult): { status: ComponentStatus; errorMessage: string | null } {
  if (r.ok) return { status: 'ready', errorMessage: null }
  if (r.unsupported) return { status: 'unavailable', errorMessage: null }
  const tail = (r.log || '').trim().slice(-400) // 只留尾部摘要，别把整段日志塞状态
  return { status: 'error', errorMessage: tail || '安装失败' }
}

/** 按组件挑安装根目录(P1c 根目录分家)。embed 历史落点是 userData/kb-model(P1a 迁移时
 *  与 kbModelDir() 布局对齐,评审以「字节不变」为门,不能挪);其后一切新组件(python-runtime
 *  起)统一住 userData/components/——python 不是知识库的东西,落 kb-model 语义错乱。
 *  纯函数注入两个根路径,electron 依赖留在 orchestrator 侧(kbModelDir/componentsDir)。 */
export function componentInstallRootFor(id: string, roots: { kbModel: string; components: string }): string {
  return id === 'kb-embed' ? roots.kbModel : roots.components
}
