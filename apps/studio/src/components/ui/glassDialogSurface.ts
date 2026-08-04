/**
 * 「毛玻璃精修档」弹窗面板的共享 className（2026-07-31 抽出）。
 *
 * 用在 4 处同规格弹窗上，作为 DialogContent / AlertDialogContent 的局部覆盖：
 *   - ThreadView.tsx      顶栏重命名对话
 *   - RailSessionList.tsx 会话行重命名对话 / 删除会话确认
 *   - AppRail.tsx         退出登录确认
 *
 * **为什么是常量而不是改 DialogContent 基件**：这套玻璃质感是这几处的专属
 * 精修档，设置页/其它弹窗刻意保持朴素实心底——把它塞进共享基件会波及全 app
 * （2026-07-19 定下的边界，原注释「className 局部覆盖，不动共享 DialogContent
 * 基件」）。但四份逐字复制的 300 字符串同样不可维护：2026-07-19 就发生过
 * 「两处重命名弹窗保存按钮迁色漏改一份拷贝」的事故，而 AppRail 的注释已经在
 * 声称「全 app 共用这一份视觉规格」——意图本来就是共享的，只是代码没表达出来。
 * 抽成常量既守住 opt-in 边界，又让四处真正是同一个字符串。
 *
 * **放 src/components/ui/ 而不是 src/lib/**：Tailwind v4 的 @source 清单
 * （src/chat/styles/index.css）只扫 `src/chat/**` 与 `src/components/**`，
 * src/lib 不在其中——类名字符串放那儿不会被编译进产物，静默失效。
 *
 * ── 亮/暗两档为什么不是同一套值（2026-07-31 修「亮档很丑」）──
 *
 * 弹窗身后永远压着一层 `bg-black/50` 的 Overlay（dialog.tsx:44、
 * alert-dialog.tsx:41），backdrop-filter 采样到的是**那层黑幕**，不是页面内容。
 * 亮档 --background 近纯白，`bg-background/55` 让 45% 的黑幕透上来：
 *   0.55 × 247 + 0.45 × (0.5 × 247) ≈ 191 → #bfbfbf，卡片糊成中灰（用户实锤「很丑」）。
 * 暗档身后本就是深色，同一配方混出来反而正好，所以暗档整套原样保留。
 *
 * 历史修法为什么没治好：2026-07-20 把亮档的 backdrop-brightness 从 125 改成
 * 100，但 brightness(1) 是恒等变换——那次只是把「漂白」换成了「发灰」，没碰
 * 真正的成因（黑幕）。而黑幕在共享基件里、DialogContent 不透传 Overlay 的
 * className，压不下去；于是亮档只剩不透明度这一个杠杆，「干净卡片」与「看得见
 * 的毛玻璃」在亮档无法兼得。取干净：
 *
 *   - `bg-card/92`      0.92 × 255 + 0.08 × 123 ≈ 244，读作白卡片而非灰板
 *   - `border-border`   亮档描边改语义 token；`border-white/15` 白描边压在
 *                       浅色上等于没有，正是截图里卡片边缘糊掉的原因
 *   - 阴影减淡、去掉 inset 顶部高光：两者都是为暗档玻璃调的，亮档下高光看不见
 *                       而重阴影显脏
 *
 * `backdrop-brightness-100` 是亮档的显式恒等占位，别删：它保证 backdrop-filter
 * 链在两档都完整声明，避免 Tailwind 变量组合出意外（同 2026-07-20 的结论）。
 */
export const GLASS_DIALOG_SURFACE =
  'rounded-2xl border border-border bg-card/92 shadow-[0_24px_70px_-18px_rgba(0,0,0,0.18),0_8px_24px_-12px_rgba(0,0,0,0.10)] backdrop-blur-xl backdrop-saturate-150 backdrop-brightness-100 dark:border-white/15 dark:bg-background/55 dark:shadow-[0_24px_70px_-18px_rgba(0,0,0,0.4),0_8px_24px_-12px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.15)] dark:backdrop-brightness-125 sm:max-w-[440px]'
