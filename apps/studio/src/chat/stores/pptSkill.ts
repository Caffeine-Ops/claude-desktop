import { create } from 'zustand'
import type { PptSkillStatus } from '@desktop-shared/pptSkillStatus'

/**
 * ppt-creator skill 的安装状态（renderer 侧镜像）。
 *
 * 这个 skill 不再随安装包发布（99MB / 12167 个文件），首次用到时才从远端下载。
 * 应用启动**不受影响**（照常秒开，main 侧后台预热）；只有点「制作PPT」这类
 * PPT 入口时，若尚未就绪才弹全屏进度层挡住——用户拍板的范围，2026-07-29。
 *
 * 状态的唯一真相在 main（它才知道磁盘上装没装、装的哪个版本），这里只是镜像：
 * 挂载时拉一次 + 订阅推送，不自己推导任何状态。
 */

interface PptSkillState {
  status: PptSkillStatus | null
  /** 进度层是否可见。与 status 分开：用户可以关掉进度层让下载在后台继续。 */
  overlayOpen: boolean
  setStatus: (s: PptSkillStatus) => void
  openOverlay: () => void
  closeOverlay: () => void
}

export const usePptSkillStore = create<PptSkillState>()((set) => ({
  status: null,
  overlayOpen: false,
  setStatus: (status) => set({ status }),
  openOverlay: () => set({ overlayOpen: true }),
  closeOverlay: () => set({ overlayOpen: false })
}))

let hydrated = false

/** 拉一次当前状态并订阅推送。模块加载时自动跑，幂等。 */
export function hydratePptSkill(): void {
  if (hydrated) return
  const api = typeof window !== 'undefined' ? window.chatApi : undefined
  if (!api?.getPptSkillStatus) return
  hydrated = true

  void api
    .getPptSkillStatus()
    .then((s) => {
      if (s) usePptSkillStore.getState().setStatus(s)
    })
    .catch(() => {
      // 拿不到状态就当未就绪：点 PPT 入口时会走 ensure，那条路会给出真实结论。
    })

  api.onPptSkillStatus?.((s) => {
    if (!s) return
    usePptSkillStore.getState().setStatus(s)
    // 装好了就自动收起进度层——用户不需要再点一次「完成」。
    if (s.phase === 'ready') usePptSkillStore.getState().closeOverlay()
  })
}

hydratePptSkill()

/**
 * 这个 slash 命令是不是 PPT 技能——凡是命中的入口都要先过 {@link ensurePptSkillReady}。
 *
 * 四种形态都要认：`/cowork:ppt-creator`（下载安装后的正式形态）、裸名
 * `/ppt-creator`，以及历史的 `/claude-desktop:ppt-master` 与 `/ppt-master`
 * ——老会话里存着旧命令，配置目录里也可能还挂着旧 value，认漏了就会绕过
 * 守卫、让用户带着一个不存在的技能发消息（CLI 报「未知命令」，最难自查）。
 */
export function isPptSkillCommand(value: string): boolean {
  const bare = value.replace(/^\//, '').replace(/^[\w-]+:/, '')
  return bare === 'ppt-creator' || bare === 'ppt-creator'
}

/**
 * PPT 入口的统一守卫：就绪则直接放行，否则弹进度层并触发安装，返回 false
 * 让调用方中止本次动作（用户在进度层里等，装好后再自己点一次）。
 *
 * 为什么不「装好后自动替用户执行原动作」：那会让用户在几分钟的等待后被动
 * 跳进一个自己已经忘了的流程里。装好后进度层自动关闭，用户看到熟悉的界面
 * 再点一次，控制权始终在他手上。
 */
export function ensurePptSkillReady(): boolean {
  const { status, openOverlay } = usePptSkillStore.getState()
  if (status?.phase === 'ready') return true

  openOverlay()
  void window.chatApi?.ensurePptSkill?.().then((s) => {
    if (s) usePptSkillStore.getState().setStatus(s)
  })
  return false
}
