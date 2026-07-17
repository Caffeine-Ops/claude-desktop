import type { Metadata } from 'next'
import { Suspense, type ReactNode } from 'react'
import { AuthGate } from '@/src/components/AuthGate'
import { RailShell } from '@/src/components/RailShell'
import { SurfaceHost } from '@/src/components/SurfaceHost'
import { UpgradeScreen } from '@/src/components/UpgradeScreen'
import { TooltipProvider } from '@/src/components/ui/tooltip'
import './globals.css'
// canvas（迁移自 apps/web）的两个样式入口，沿用 web 原版 layout.tsx 的
// JS-import 方式——不能并进 globals.css 的 @import 链（位置违规会被静默
// 丢弃，见 globals.css 尾部注释）。顺序在 globals.css 之后：canvas 的
// 手写 CSS 要能覆盖 chat 链的 preflight。
import '@/src/canvas/index.css'
import '@/src/canvas/styles/home/index.css'
// 背景图换肤——必须排在 canvas 链之后：要覆盖 canvas 建立的 .shell-content-card
// 不透明底，顺序即级联（见该文件头注释）。
import './background-art.css'

export const metadata: Metadata = {
  title: 'Claude Studio',
  description: '统一前端：聊天 + 设计工具'
}

/**
 * Pre-hydration 主题脚本（2026-07-08 修「刷新先蓝后主题色」闪变）——
 * tokens.css 的默认 --primary 是 Apple 蓝，用户主题色要等 React 挂载后
 * appearance applier 才写进 inline token，中间几百 ms 整个外壳（rail
 * CTA、选中态）都是蓝的。此脚本作为 body 第一个子元素同步
 * 执行（首帧绘制前），从 chat appearance store 的 zustand persist 缓存
 * （localStorage 'claude-desktop:appearance'）读出用户主题，提前落：
 *   1. 明暗双标记（.dark 类 + data-theme，system 按 matchMedia 解析）；
 *   2. chat 系 token（--accent/--primary/--ring/--background/--card/
 *      --popover/--sidebar + 前景系）——换算逻辑与 appearance.applier.ts
 *      的 applyThemeOverrides 保持一致（card +3 / popover 亮+5 暗+6）；
 *   3. canvas 系 --od-accent 及派生（mix 比例与 canvas/state/appearance.ts
 *      的 accentVars 同步：strong 86 / soft 22 / tint 12 / hover 90）。
 * applier 挂载后会用同一份数据重写一遍（幂等），daemon hydrate 再校准。
 * 改 applier / accentVars 的任何比例都要同步这里。
 * 整段 try/catch：缓存缺失或格式变化时静默走 tokens.css 默认，绝不白屏。
 */
const THEME_BOOT_SCRIPT = `(function(){try{
var raw=localStorage.getItem('claude-desktop:appearance');if(!raw)return;
var st=(JSON.parse(raw)||{}).state;if(!st)return;
var mode=st.themeMode||'system';
var dark=mode==='dark'||(mode==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
var root=document.documentElement;
root.classList.toggle('dark',dark);
root.setAttribute('data-theme',dark?'dark':'light');
var o=dark?st.dark:st.light;if(!o||!o.accent)return;
function hsl(hex){var m=/^#?([0-9a-f]{6})$/i.exec(String(hex).trim());if(!m)return null;
var i=parseInt(m[1],16),r=(i>>16&255)/255,g=(i>>8&255)/255,b=(i&255)/255;
var mx=Math.max(r,g,b),mn=Math.min(r,g,b),l=(mx+mn)/2,h=0,s=0;
if(mx!==mn){var d=mx-mn;s=l>0.5?d/(2-mx-mn):d/(mx+mn);
h=mx===r?(g-b)/d+(g<b?6:0):mx===g?(b-r)/d+2:(r-g)/d+4;h*=60;}
return[Math.round(h),Math.round(s*100),Math.round(l*100)];}
function t(a){return a[0]+' '+a[1]+'% '+a[2]+'%';}
function set(k,v){root.style.setProperty(k,v);}
var acc=hsl(o.accent);if(!acc)return;
set('--accent',t(acc));set('--primary',t(acc));set('--ring',t(acc));
var bg=o.background&&hsl(o.background),fg=o.foreground&&hsl(o.foreground);
function lift(a,d){return[a[0],a[1],Math.max(0,Math.min(100,a[2]+d))];}
if(bg){set('--background',t(bg));set('--sidebar',t(bg));
set('--card',t(lift(bg,3)));set('--popover',t(lift(bg,dark?6:5)));}
if(fg){set('--foreground',t(fg));set('--card-foreground',t(fg));
set('--popover-foreground',t(fg));set('--sidebar-foreground',t(fg));}
if(typeof o.contrast==='number'&&o.contrast>=60)root.classList.add('high-contrast');
var a=o.accent;
set('--od-accent',a);
set('--accent-strong','color-mix(in srgb, '+a+' 86%, var(--text-strong))');
set('--accent-soft','color-mix(in srgb, '+a+' 22%, var(--bg-panel))');
set('--accent-tint','color-mix(in srgb, '+a+' 12%, var(--bg-panel))');
set('--accent-hover','color-mix(in srgb, '+a+' 90%, var(--text-strong))');
}catch(e){}})();`

/**
 * Pre-hydration 背景图（壁纸）脚本——同一防闪变套路，独立的第二个 IIFE 而非
 * 塞进上面那个：上面那段有好几处 `if(!x)return`（缺 accent 就整段跳过），本
 * 段读的是完全独立的 localStorage key（'claude-desktop:bg-art'，由
 * backgroundArt.applier.ts 写），两个缓存互不依赖对方存在——合并进同一个
 * try 块会让「有壁纸缓存但主题色缓存这次恰好读失败」这种边缘情况被上面的
 * 提前 return 误伤，跳过本该照常生效的壁纸。写入的字段（url/posX/posY/
 * weak/mid/strong）与 backgroundArt.applier.ts 的 BgArtCache 是同一份契约，
 * 改一个要同步改另一个。
 */
const BG_ART_BOOT_SCRIPT = `(function(){try{
var raw=localStorage.getItem('claude-desktop:bg-art');if(!raw)return;
var c=JSON.parse(raw);if(!c||!c.url)return;
var root=document.documentElement;
root.setAttribute('data-bg-art',c.id||'1');
root.style.setProperty('--bg-art-url',c.url);
root.style.setProperty('--bg-art-pos-x',c.posX+'%');
root.style.setProperty('--bg-art-pos-y',c.posY+'%');
root.style.setProperty('--bg-art-veil-weak',String(c.weak));
root.style.setProperty('--bg-art-veil-mid',String(c.mid));
root.style.setProperty('--bg-art-veil-strong',String(c.strong));
}catch(e){}})();`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      {/* rail + 内容区的持久两栏骨架。overflow-hidden 让各路由自己管滚动
       *（聊天页的 .app 自带全高布局，canvas 是全高 iframe）。
       * bg-sidebar：rail 与窗口背景同面（原型 --rail-bg == shell root），
       * 右侧内容面平铺其上、靠左缘 hairline 分隔（2026-07-08 平铺化，
       * 见 globals.css .shell-content-card 注释）。 */}
      <body className="flex h-screen overflow-hidden bg-sidebar">
        {/* 主题 boot 脚本：必须是 body 第一个子元素——HTML 流式解析到这里
         * 同步执行，此时 rail/内容面还没绘制，首帧即用户主题色（脚本体
         * 与原理见 THEME_BOOT_SCRIPT 注释）。html 已有
         * suppressHydrationWarning，脚本改 documentElement 不打架。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {/* 背景图（壁纸）boot 脚本：独立缓存/独立 IIFE（理由见
         * BG_ART_BOOT_SCRIPT 注释），但同样必须先于 rail/内容面渲染同步执行，
         * 紧跟在主题脚本后面。 */}
        <script dangerouslySetInnerHTML={{ __html: BG_ART_BOOT_SCRIPT }} />
        {/* 全局 TooltipProvider：Radix 的 Tooltip.Root 没有 Provider 祖先会
         * 直接 throw（"Tooltip must be used within TooltipProvider"），
         * 挂在这里一次覆盖 rail + 两面内容——不渲染任何 DOM（纯 context），
         * 包住谁都零副作用。首个消费方是消息操作栏的复制/喜欢/不喜欢
         * tooltip（AssistantMessage.tsx），未来别处用 Tooltip 不用再各自
         * 补 Provider。 */}
        <TooltipProvider>
          {/* 窗口拖拽条：整个 app 唯一的常驻 app-region:drag 写手（fixed
           * 全宽 46px，顶部标题栏带）。组件顶栏一律不再声明 drag，顶部 46px
           * 内的交互元素各自 no-drag 挖洞；本条兼任 region-refresh 脉冲的
           * 探针。必须早于一切内容渲染（矩形按树序注册、后者覆盖前者——
           * 后面所有子树的 no-drag 洞都依赖排在本条之后）。语义与纪律见
           * globals.css 的 .window-drag-strip 注释。 */}
          <div aria-hidden className="window-drag-strip" />
          {/* rail 外壳：展开态放回 w-61 常驻列，收起态宽度收成 0（内容面
           * flex-1 补满）+ hover 左边缘浮出。见 RailShell 头注释。 */}
          <RailShell />
          {/* 右侧舞台（原型 .stage）：平铺无 gutter（2026-07-08 去浮卡化，
           * 旧版上/右/下各 10px 呼吸 + 圆角阴影浮卡）。内容面样式在
           * globals.css 的 .shell-content-card。chat 与 canvas 两棵重型树
           * 常驻面内的 SurfaceHost（layout 跨路由保活，切换只翻显隐——见其
           * 头注释），面是两面共用的壳层元素，切面时本身纹丝不动。children
           * 是空壳 page（仅承担路由命中，chat-probe 除外）。 */}
          <div className="shell-stage">
            <div className="shell-content-card">
              {children}
              {/* Suspense：SurfaceHost 用 useSearchParams（settings=1 判定），
               * 静态预渲染要求它在 Suspense 边界内（否则 _not-found 等页的
               * prerender 直接报错）。fallback null——SurfaceHost 本来就是
               * 纯客户端表面。 */}
              <Suspense fallback={null}>
                <SurfaceHost />
              </Suspense>
            </div>
          </div>
          {/* 订阅购买页 overlay（z-9980）：账户菜单「升级订阅」打开，
           * 开关在 src/stores/upgrade.ts。挂在 AuthGate 之前——登出时
           * 登录墙（z-9999 + DOM 更靠后）必须盖得住它。 */}
          <UpgradeScreen />
          {/* 登录墙：body 最后一个子元素——未登录时全屏盖住 rail + 舞台
           * （两棵树照常挂载，墙只是视觉+交互门禁，见 AuthGate 头注释）。 */}
          <AuthGate />
        </TooltipProvider>
      </body>
    </html>
  )
}
