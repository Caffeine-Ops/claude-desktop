'use client'

/**
 * 订阅购买页（全屏 overlay）——账户菜单「升级订阅」的落点。
 *
 * 视觉是 docs/ui-prototype-subscription.html 的落地（2026-07-06 用户确认
 * 方向）：延续登录页科技感体系（--lg-* 双主题变量，定义在 login.css，
 * 作用域已扩展到 .upgrade-screen）；月付/年付用 shadcn Tabs、徽章用
 * Badge、CTA 用 Button。开关走 useUpgradeStore（内存态，理由见 store
 * 头注释），Esc / 右上 ✕ 关闭。
 *
 * ⚠️ 套餐名/价格/权益均为占位（PLANS 常量）——权益贴产品真实功能编写，
 * 价格档位等业务定稿后替换；CTA 的支付链路未接，点击给占位提示。
 * 「当前方案」由 auth user 的 plan.name 匹配（authService 占位实现固定
 * 发「基础版」，将来接真实套餐后端此处自动跟随）。
 *
 * 本组件在 .chat-app 之外，canvas 的裸元素 reset 会命中裸 <button>/<input>
 * ——交互元素一律 shadcn 原语（自带 data-slot 豁免），根层铁律同 AppRail。
 * 对比表的 <table> 系元素不在 reset 名单（button/input/select/textarea/
 * code），裸写安全。
 *
 * 顶部 48px 是窗口拖拽条：overlay 盖满全窗后墙后的 drag 区摸不到（同
 * 登录墙）；右上 ✕ 在 drag 区内，必须 no-drag 才点得动。
 * z-[9980]：压过 app 内容，但让给登录墙（z-[9999]）——登出时墙必须能
 * 盖住本页。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'

import { Badge } from '@/src/components/ui/badge'
import { Button } from '@/src/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/src/components/ui/tabs'
import { cn } from '@/src/lib/utils'
import { useUpgradeStore } from '@/src/stores/upgrade'
// --lg-* 主题变量与 login-* 背景/动效类（作用域含 .upgrade-screen）。
import './login.css'

const RISE = 'animate-[login-rise_.55s_cubic-bezier(0.32,0.72,0,1)_both]'

type BillingCycle = 'monthly' | 'yearly'

/** 一档套餐（占位数据，见文件头注释）。价格单位：元/月。 */
interface Plan {
  name: string
  desc: string
  /** 月付价；null = 免费档（价格区显示 ¥0 / 永久）。 */
  monthly: number | null
  /** 年付折合月价 + 年付一次性总价（免费档为 null）。 */
  yearly: { perMonth: number; total: number } | null
  hero?: boolean
  features: ReactNode[]
  cta: string
}

const PLANS: Plan[] = [
  {
    name: '基础版',
    desc: '个人轻度使用',
    monthly: null,
    yearly: null,
    features: [
      <>每天 <strong>30 次</strong>智能助手对话</>,
      <>标准模型</>,
      <>知识库 <strong>100</strong> 篇文档</>,
      <><strong>3</strong> 个工作画布项目</>,
      <>写方案基础模板</>
    ],
    cta: '当前方案'
  },
  {
    name: '专业版',
    desc: '高频使用的个人与自由职业者',
    monthly: 49,
    yearly: { perMonth: 39, total: 468 },
    hero: true,
    features: [
      <><strong>无限次</strong>智能助手对话</>,
      <><strong>高级模型全系</strong>（含最新旗舰模型）</>,
      <>知识库 <strong>10,000</strong> 篇文档 + 语义检索</>,
      <><strong>无限</strong>工作画布项目</>,
      <>写方案高级模板 + 引用核对</>,
      <>优先响应支持</>
    ],
    cta: '升级到专业版'
  },
  {
    name: '旗舰版',
    desc: '团队与重度生产力场景',
    monthly: 199,
    yearly: { perMonth: 159, total: 1908 },
    features: [
      <>专业版全部权益</>,
      <><strong>5</strong> 个成员席位，协作共享</>,
      <>专属算力通道，高峰不排队</>,
      <>知识库<strong>不限量</strong></>,
      <>专属客户成功经理</>
    ],
    cta: '升级到旗舰版'
  }
]

/** 功能对比表（占位，与 PLANS 权益同源人工对齐）。 */
const COMPARE_ROWS: Array<[string, string, string, string]> = [
  ['智能助手对话', '30 次/天', '无限', '无限'],
  ['高级模型（旗舰系列）', '—', '✓', '✓'],
  ['知识库容量', '100 篇', '10,000 篇', '不限量'],
  ['语义检索', '—', '✓', '✓'],
  ['工作画布项目', '3 个', '无限', '无限'],
  ['写方案高级模板', '—', '✓', '✓'],
  ['成员席位', '1', '1', '5'],
  ['专属算力通道', '—', '—', '✓']
]

function PlanCard({
  plan,
  cycle,
  isCurrent,
  onBuy
}: {
  plan: Plan
  cycle: BillingCycle
  isCurrent: boolean
  onBuy: (plan: Plan) => void
}) {
  const price =
    plan.monthly === null
      ? 0
      : cycle === 'yearly' && plan.yearly
        ? plan.yearly.perMonth
        : plan.monthly
  return (
    <div
      className={cn(
        'relative flex flex-col rounded-2xl border p-6 pb-5 transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5',
        plan.hero
          ? 'border-[color:var(--lg-hero-border)] bg-[color:var(--lg-card-bg)] shadow-[var(--lg-hero-glow)]'
          : 'border-[color:var(--lg-card-border)] bg-[color:var(--lg-card-bg)] shadow-[var(--lg-card-shadow)]'
      )}
    >
      {plan.hero ? (
        <Badge className="absolute -top-2.5 left-1/2 -translate-x-1/2 border-none bg-gradient-to-br from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)] px-3 text-[11px] font-bold tracking-wide text-[color:var(--lg-green-fg)] shadow-[0_2px_12px_var(--lg-green-soft)]">
          最受欢迎
        </Badge>
      ) : null}

      <div className="flex items-center gap-2 text-[15px] font-semibold text-[color:var(--lg-ink)]">
        {plan.name}
        {isCurrent ? (
          <Badge
            variant="outline"
            className="border-[color:var(--lg-line)] px-2 text-[10.5px] font-semibold text-[color:var(--lg-ink-3)]"
          >
            当前方案
          </Badge>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-[color:var(--lg-ink-3)]">{plan.desc}</p>

      {/* 价格区。key=cycle：月/年切换时数字小幅淡入（login-fade）。 */}
      <div className="mb-1 mt-4 flex items-baseline gap-1">
        <span className="text-[15px] font-semibold text-[color:var(--lg-ink-2)]">¥</span>
        <span
          key={cycle}
          className="animate-[login-fade_.25s_ease_both] text-[38px] font-bold leading-none tracking-[-1px] text-[color:var(--lg-ink)]"
        >
          {price}
        </span>
        <span className="text-[13px] text-[color:var(--lg-ink-3)]">
          {plan.monthly === null ? '/ 永久' : '/ 月'}
        </span>
      </div>
      {/* 年付折算行：固定高占位，切月付不塌 */}
      <div className="mb-3.5 h-[17px] text-[11.5px] text-[color:var(--lg-ink-3)]">
        {cycle === 'yearly' && plan.yearly ? (
          <>
            <span className="mr-1.5 line-through">¥{plan.monthly}</span>
            <span className="font-semibold text-[color:var(--lg-green)]">
              年付折合 ¥{plan.yearly.perMonth}/月，一次性 ¥{plan.yearly.total}
            </span>
          </>
        ) : null}
      </div>

      <ul className="mb-5 flex flex-col gap-2.5">
        {plan.features.map((f, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[12.5px] leading-[1.45] text-[color:var(--lg-ink-2)] [&_strong]:font-semibold [&_strong]:text-[color:var(--lg-ink)]"
          >
            <span className="mt-0.5 inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-[color:var(--lg-green-soft)] text-[color:var(--lg-green)]">
              <Check className="size-2.5" strokeWidth={3.5} />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      {isCurrent || plan.monthly === null ? (
        // 当前方案 / 免费档：静默不可点，但不置灰到不可读（同账户菜单
        // 占位项的观感原则）。免费档无论 auth 状态如何都不可「购买」——
        // 浏览器直开等拿不到 auth 的场景下也不能出现可点的「当前方案」。
        <Button
          disabled
          className="mt-auto h-10 rounded-[10px] border-none bg-[color:var(--lg-green-soft)] text-[13.5px] font-semibold text-[color:var(--lg-ink-3)] shadow-none disabled:opacity-100"
        >
          {plan.cta}
        </Button>
      ) : plan.hero ? (
        <Button
          onClick={() => onBuy(plan)}
          className="login-sheen relative mt-auto h-10 overflow-hidden rounded-[10px] bg-gradient-to-br from-[color:var(--lg-green)] to-[color:var(--lg-green-deep)] text-[13.5px] font-semibold text-[color:var(--lg-green-fg)] shadow-[var(--lg-btn-shadow)] hover:brightness-[1.07] active:scale-[.985]"
        >
          {plan.cta}
        </Button>
      ) : (
        <Button
          variant="outline"
          onClick={() => onBuy(plan)}
          className="mt-auto h-10 rounded-[10px] border-[color:var(--lg-line)] bg-transparent text-[13.5px] font-semibold text-[color:var(--lg-ink)] hover:border-[color:var(--lg-hero-border)] hover:bg-transparent hover:text-[color:var(--lg-green)]"
        >
          {plan.cta}
        </Button>
      )}
    </div>
  )
}

export function UpgradeScreen() {
  const open = useUpgradeStore((s) => s.open)
  const setOpen = useUpgradeStore((s) => s.setOpen)
  const [cycle, setCycle] = useState<BillingCycle>('monthly')
  const [showCompare, setShowCompare] = useState(false)
  const [currentPlan, setCurrentPlan] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  /* 打开时拉一次登录用户的套餐名，标记「当前方案」。authService 占位
   * 实现固定「基础版」；接真实套餐后端后这里自动跟随。 */
  useEffect(() => {
    if (!open) return
    let alive = true
    void window.chatApi
      ?.getAuthState?.()
      .then((s) => {
        if (alive) setCurrentPlan(s.user?.plan.name ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [open])

  /* Esc 关闭（overlay 惯例）。 */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  /* toast 自动消失。 */
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(t)
  }, [toast])

  if (!open) return null

  const handleBuy = (plan: Plan) => {
    // 支付链路未接（支付方式待定）——先给诚实的占位反馈。
    setToast(`「${plan.name} · ${cycle === 'yearly' ? '年付' : '月付'}」支付功能即将上线`)
  }

  return (
    <div className="upgrade-screen fixed inset-0 z-[9980] overflow-hidden bg-[color:var(--lg-bg)]">
      {/* 背景：光晕（顶部，静态）+ 网格。复用 login.css 的类。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[40%] left-1/2 h-[560px] w-[900px] -translate-x-1/2 bg-[radial-gradient(ellipse_at_center,var(--lg-glow-a)_0%,var(--lg-glow-a2)_45%,transparent_70%)]"
      />
      <div
        aria-hidden
        className="login-grid pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_95%_80%_at_50%_30%,#000_20%,transparent_80%)]"
      />

      {/* 窗口拖拽条 + 关闭钮（在 drag 区内，no-drag 才点得动） */}
      <div className="absolute inset-x-0 top-0 z-10 h-12 [-webkit-app-region:drag]" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="关闭"
        onClick={() => setOpen(false)}
        className="fixed right-4 top-2.5 z-20 rounded-lg border border-[color:var(--lg-line)] text-[color:var(--lg-ink-2)] [-webkit-app-region:no-drag] hover:bg-[color:var(--lg-green-soft)] hover:text-[color:var(--lg-ink)]"
      >
        <X className="size-4" />
      </Button>

      <div className="relative z-[1] h-full overflow-y-auto px-12 pb-10 pt-12">
        {/* 标题区 */}
        <div className="mb-6 mt-2 text-center">
          <span
            className={cn(
              RISE,
              'inline-flex items-center gap-2 font-mono text-[10.5px] font-medium uppercase tracking-[3px] text-[color:var(--lg-green)] before:h-px before:w-[22px] before:bg-gradient-to-r before:from-transparent before:to-[color:var(--lg-green)]/50 after:h-px after:w-[22px] after:bg-gradient-to-r after:from-[color:var(--lg-green)]/50 after:to-transparent'
            )}
          >
            Upgrade
          </span>
          <h1
            className={cn(
              RISE,
              '[animation-delay:.06s]',
              'mt-3 text-[30px] font-semibold leading-[1.15] tracking-[-0.5px] text-[color:var(--lg-ink)]'
            )}
          >
            升级订阅
          </h1>
          <p className={cn(RISE, '[animation-delay:.12s]', 'mt-2 text-sm text-[color:var(--lg-ink-2)]')}>
            解锁更强的模型与更高的用量，让智能体替你做更多
          </p>
        </div>

        {/* 计费周期（shadcn Tabs 作 segmented） */}
        <div className={cn(RISE, '[animation-delay:.18s]', 'mb-7 flex justify-center')}>
          <Tabs value={cycle} onValueChange={(v) => setCycle(v as BillingCycle)}>
            <TabsList>
              <TabsTrigger value="monthly">按月付费</TabsTrigger>
              <TabsTrigger value="yearly" className="gap-1.5">
                按年付费
                <Badge className="border-[color:var(--lg-hero-border)] bg-[color:var(--lg-green-soft)] px-1.5 text-[10.5px] font-bold text-[color:var(--lg-green)]">
                  省 20%
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* 套餐三栏 */}
        <div className="mx-auto grid w-full max-w-[920px] grid-cols-1 items-stretch gap-4 md:grid-cols-3">
          {PLANS.map((plan, i) => (
            <div key={plan.name} className={cn(RISE)} style={{ animationDelay: `${0.22 + i * 0.07}s` }}>
              <PlanCard
                plan={plan}
                cycle={cycle}
                isCurrent={currentPlan === plan.name}
                onBuy={handleBuy}
              />
            </div>
          ))}
        </div>

        {/* 功能对比表（默认收起） */}
        <div className="mx-auto mt-8 w-full max-w-[920px]">
          <div className="flex justify-center">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCompare((v) => !v)}
              className="gap-1.5 text-[13px] text-[color:var(--lg-ink-2)] hover:text-[color:var(--lg-ink)]"
            >
              功能对比
              <ChevronDown
                className={cn('size-3.5 transition-transform duration-200', showCompare && 'rotate-180')}
              />
            </Button>
          </div>
          {showCompare ? (
            <div className="mt-4 animate-[login-fade_.25s_ease_both] overflow-hidden rounded-xl border border-[color:var(--lg-card-border)] bg-[color:var(--lg-card-bg)]">
              <table className="w-full border-collapse text-[12.5px]">
                <thead>
                  <tr className="bg-[color:var(--lg-green-soft)]">
                    {['功能', ...PLANS.map((p) => p.name)].map((h, i) => (
                      <th
                        key={h}
                        className={cn(
                          'px-3.5 py-2.5 font-semibold text-[color:var(--lg-ink)]',
                          i === 0 ? 'text-left' : 'text-center'
                        )}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map(([feature, ...cells], r) => (
                    <tr key={feature} className={cn(r < COMPARE_ROWS.length - 1 && 'border-b border-[color:var(--lg-line)]')}>
                      <td className="px-3.5 py-2.5 text-left text-[color:var(--lg-ink)]">{feature}</td>
                      {cells.map((cell, c) => (
                        <td
                          key={c}
                          className={cn(
                            'px-3.5 py-2.5 text-center',
                            cell === '✓'
                              ? 'font-bold text-[color:var(--lg-green)]'
                              : cell === '—'
                                ? 'text-[color:var(--lg-ink-3)]'
                                : 'text-[color:var(--lg-ink-2)]'
                          )}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>

      {/* 支付占位 toast */}
      {toast ? (
        <div
          role="status"
          className="fixed bottom-7 left-1/2 z-30 -translate-x-1/2 animate-[login-fade_.25s_ease_both] rounded-[10px] border border-[color:var(--lg-line)] bg-[color:var(--lg-surface)] px-4 py-2.5 text-[12.5px] text-[color:var(--lg-ink)] shadow-[0_8px_30px_rgba(0,0,0,.25)]"
        >
          {toast}
        </div>
      ) : null}
    </div>
  )
}
