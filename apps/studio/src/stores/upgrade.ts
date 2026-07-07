import { create } from 'zustand'

/**
 * 订阅购买页（UpgradeScreen）的开关。
 *
 * 放 src/stores（根层）而非 chat/stores：入口在 AppRail 账户菜单（根层
 * 外壳，chat/canvas 共享），页面本身也是 app 级 overlay——同 rail 折叠
 * 态的归属逻辑。刻意用内存 store 而非 URL query（?settings=1 模式）：
 * 订阅页无需 URL 直达，query 驱动还要处理「导航保留 query 关不掉」的
 * 剥参问题（2026-07-04 settings-overlay 的坑），store 一个布尔最稳。
 */
interface UpgradeState {
  open: boolean
  setOpen: (v: boolean) => void
}

export const useUpgradeStore = create<UpgradeState>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v })
}))
