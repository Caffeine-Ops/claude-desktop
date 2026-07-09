import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Check, Copy } from 'lucide-react'
import {
  CommandType,
  createUniver,
  CustomCommandExecutionError,
  LocaleType,
  mergeLocales,
  RANGE_TYPE,
  type IRange,
  type IWorkbookData
} from '@univerjs/presets'
// IRenderManagerService / ObjectType 实际来自 @univerjs/engine-render,
// 经 preset-sheets-core 重导出(studio 只直依赖 preset 五件,bun
// isolated linker 下传递依赖不可直接 import)。
import {
  CalculationMode,
  IRenderManagerService,
  ObjectType,
  UniverSheetsCorePreset
} from '@univerjs/preset-sheets-core'
import sheetsCoreZhCN from '@univerjs/preset-sheets-core/locales/zh-CN'
import sheetsCoreEnUS from '@univerjs/preset-sheets-core/locales/en-US'
import { UniverSheetsDrawingPreset } from '@univerjs/preset-sheets-drawing'
import sheetsDrawingZhCN from '@univerjs/preset-sheets-drawing/locales/zh-CN'
import sheetsDrawingEnUS from '@univerjs/preset-sheets-drawing/locales/en-US'
import {
  CFValueType,
  UniverSheetsConditionalFormattingPreset
} from '@univerjs/preset-sheets-conditional-formatting'
import sheetsCfZhCN from '@univerjs/preset-sheets-conditional-formatting/locales/zh-CN'
import sheetsCfEnUS from '@univerjs/preset-sheets-conditional-formatting/locales/en-US'
import '@univerjs/preset-sheets-core/lib/index.css'
import '@univerjs/preset-sheets-drawing/lib/index.css'
import '@univerjs/preset-sheets-conditional-formatting/lib/index.css'

import { useI18n, useT } from '../../../../i18n'
import { useChatStore } from '../../../../stores/chat'
import {
  SHEET_SELECTION_MARKER,
  type SheetSelectionMeta
} from '../../../../stores/filePreview'
import { dispatchChatTurn } from '../../../../lib/dispatchChatTurn'
import { Button } from '@/src/components/ui/button'
import {
  SheetMiniChart,
  type ChartSpec,
  type CondRule,
  type SheetImageSpec
} from '../sheetCharts'
import {
  SHEET_COL_HEADER_H,
  SHEET_MAX_SEND_ROWS,
  SHEET_ROW_HEADER_W,
  SHEET_ZOOM_MAX,
  SHEET_ZOOM_MIN
} from './constants'
import type { SheetExtras } from './buildSnapshot'

/* ─────────────── Univer 宿主(表格预览的渲染与交互面) ─────────────── */

/**
 * 一个组件实例 = 一个 Univer 实例 = 一份文件快照。换文件 / 点「刷新」
 * 由壳层换 key 整体重挂载——Univer 的 unit 生命周期与 React 状态一起
 * 清零,比在同一实例上 dispose/create unit 省掉一整类陈旧状态坑。
 *
 * 实例只用开源 preset(core + drawing + conditional-formatting):
 *   - 原生图表插件是 @univerjs-pro(无证书带水印),嵌入图表走开源的
 *     float DOM 挂自绘 SVG(SheetMiniChart),锚点像素在 buildSnapshot
 *     里按列宽/行高前缀和算好(initPosition 含表头偏移)。
 *   - 图片走 newOverGridImage(BASE64 data URL,buildSnapshot 已抽好)。
 *   - 条件格式(dataBar / cellIs / colorScale)经 facade builder 注入,
 *     由插件动态渲染——比迁移前烘焙进底色的做法多出 colorScale,且
 *     数值语义正确(min/max 按范围现算)。
 *
 * 只读模型(实现细节见 lockReadonly 处注释):mutation 闸门为底线 +
 * 编辑器/粘贴入口 cancel;注入(CF/筛选/图片/图表)按 sheet 懒执行,
 * 走闸门的 injecting 放行窗口。行高列宽拖拽与筛选是刻意保留的预览
 * 交互(只改视图不改数据)。
 *
 * 框选问 AI:SelectionMoveEnd(行头/列头/全选是「看一眼」动作不弹
 * 输入框,2026-07-08 用户反馈)→ FRange.attachPopup 把问答条锚到选
 * 区右下格(定位/滚动跟随全托管)。TSV 从 getDisplayValues 取——是
 * Univer 公式引擎算完、按 numfmt 格式化后的显示值,比迁移前的手写
 * 求值器覆盖全得多。
 */

type UniverSheetViewProps = {
  snapshot: Partial<IWorkbookData>
  sheets: SheetExtras[]
  /** 当前 sheet(壳层 tab 条驱动)。 */
  activeIndex: number
  /** 文件绝对路径(选区消息协议用)。 */
  path: string
  zoom: number
  /** Univer 侧缩放变化(ctrl+滚轮/触控板)回报壳层同步百分比显示。 */
  onZoomChange: (zoom: number) => void
}

type UniverBundle = ReturnType<typeof createUniver>

/** 只读闸门放行的 mutation(除 formula.* 前缀外的白名单):只改布局
 *  /视图态、不动单元格数据的操作。行高列宽拖拽是用户明确要保留的
 *  预览交互(2026-07-08 重申)。筛选四件已随真筛选一起退役
 *  (2026-07-09 用户定稿:筛选按钮改纯装饰,见 SheetDecorPos)。 */
const READONLY_ALLOWED_MUTATIONS = new Set([
  // wrap 文本渲染的自动行高回写(引擎自发)。
  'sheet.mutation.set-worksheet-row-auto-height',
  // 用户拖拽调行高列宽(含双击边缘自适应行高的 is-auto-height 标记)。
  'sheet.mutation.set-worksheet-col-width',
  'sheet.mutation.set-worksheet-row-height',
  'sheet.mutation.set-worksheet-row-is-auto-height',
  // 注入自身的落地 mutation。⚠️ 必须走白名单而不能只靠 injecting
  // 窗口:facade 的注入 API 内部 executeCommand 是 fire-and-forget
  // 的 async,派生 mutation 落在我们同步注入段结束之后(2026-07-08
  // 真机:float DOM 图片被自家闸门拦没)。add-conditional-rule 放行
  // 安全:toolbar/右键全关,用户无入口。set-drawing-apply 不在这里
  // ——它按 params.type 细分(INSERT 放行、REMOVE/UPDATE 拦,见闸门
  // 内特判):全量放行时用户点选 float DOM 后按 Delete 能真删掉装饰
  // /图表(2026-07-09 真机,筛选装饰被删)。
  'sheet.mutation.add-conditional-rule'
])

/** set-drawing-apply 的 params.type(DrawingApplyType 枚举)里唯一
 *  放行的值:INSERT=0。懒注入(float DOM 图表/图片/装饰)只做插入;
 *  REMOVE(Delete 删除)/UPDATE(拖拽变形)是用户破坏预览的路径。 */
const DRAWING_APPLY_INSERT = 0

/** 只读闸门在 COMMAND 层额外拦的名单。auto-fill 一族只拦 mutation 不
 *  够:数据虽然不变,但 auto-fill 控制器以为填充成功,会弹「复制单元
 *  格/填充序列/仅格式」的残留选项菜单(2026-07-08 真机)——在 command
 *  层拦掉,拖填充柄整体变成无操作。
 *  drawing 选中 operation 也在此拦:eventPassThrough 的实现是把
 *  pointer 事件【转发回 canvas】,canvas 命中测试又选中 float DOM 自
 *  己——筛选装饰/图表/图片被点出八点变形手柄(2026-07-09 真机)。
 *  拦掉选中,手柄/Delete 删除的入口整个不存在;float DOM 全是纯展示,
 *  没有任何合法的选中场景。 */
const READONLY_BLOCKED_COMMANDS = new Set([
  'sheet.command.auto-fill',
  'sheet.command.refill',
  'sheet.command.auto-clear-content',
  'drawing.operation.set-drawing-selected'
])

/** 定稿选区(问答条经 Univer popup 服务锚到选区右下格,坐标不归我
 *  们管)。 */
type AskAnchor = {
  range: IRange
  label: string
}

/** 0 → A, 25 → Z, 26 → AA … Excel 列字母。 */
function colLetter(i: number): string {
  let s = ''
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s
  }
  return s
}

function rangeLabelOf(range: IRange): string {
  const a = `${colLetter(range.startColumn)}${range.startRow + 1}`
  const b = `${colLetter(range.endColumn)}${range.endRow + 1}`
  return a === b ? a : `${a}:${b}`
}

const clampZoom = (z: number): number =>
  Math.min(SHEET_ZOOM_MAX, Math.max(SHEET_ZOOM_MIN, Math.round(z * 100) / 100))

/** float DOM 里的嵌入图片:纯展示(不可选中/拖拽,点击穿透)。 */
function FloatImageCard(props: { data?: SheetImageSpec }): React.JSX.Element | null {
  if (!props.data) return null
  return (
    <img
      src={props.data.dataUrl}
      alt=""
      draggable={false}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'fill',
        display: 'block',
        userSelect: 'none'
      }}
    />
  )
}

/** float DOM 里的格子角落装饰(盒子=角标本身,见 SheetDecorPos 注释;
 *  组件画满盒子,纯观感):
 *  - filter:Excel 同款表头筛选下拉按钮的【装饰】——带边框小方块▼。
 *    刻意不可点击(2026-07-09 用户定稿):预览是只读的"文件的样子",
 *    真筛选会改变显示状态;Univer 原生筛选按钮随 preset-sheets-filter
 *    一起退役。
 *  - comment:批注标记,Excel 同款右上角红三角(tip=批注文本,悬浮
 *    可见)。
 *  装饰的 float DOM 关掉了 eventPassThrough(否则事件转发回 canvas
 *  命中 drawing 对象,会被 transformer 拖走/点选出手柄,2026-07-09
 *  真机两连)——角标区域的事件被 wrapper 吞掉,天然不可拖不可选;
 *  盒子只有十几像素,不挡格子交互。 */
function FloatDecorBadge(props: {
  data?: { kind: 'filter' | 'comment'; tip?: string }
}): React.JSX.Element | null {
  const kind = props.data?.kind
  if (!kind) return null
  if (kind === 'comment') {
    return (
      <div
        title={props.data?.tip || undefined}
        style={{ width: '100%', height: '100%', position: 'relative' }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            width: 0,
            height: 0,
            borderTop: '8px solid #e03e2d',
            borderLeft: '8px solid transparent'
          }}
        />
      </div>
    )
  }
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: '#f6f7f8',
        border: '1px solid #9aa0a6',
        borderRadius: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      {/* ▼:SVG 画,不吃字体行高,像素级尺寸稳定。 */}
      <svg width={7} height={5} viewBox="0 0 7 5" aria-hidden>
        <path d="M0 0 L7 0 L3.5 5 Z" fill="#3c4043" />
      </svg>
    </div>
  )
}

/** float DOM 里的图表卡片:盒子由 Univer 按锚点/缩放定位,SVG 100%
 *  填充自适应。样式对齐迁移前的浮层卡(白底细边圆角投影)。 */
function FloatChartCard(props: { data?: ChartSpec }): React.JSX.Element | null {
  if (!props.data) return null
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#ffffff',
        border: '1px solid #dfe3e8',
        borderRadius: 8,
        overflow: 'hidden',
        boxShadow: '0 2px 10px -2px rgba(0,0,0,0.12)'
      }}
    >
      <SheetMiniChart spec={props.data} />
    </div>
  )
}

export default function UniverSheetView({
  snapshot,
  sheets,
  activeIndex,
  path,
  zoom,
  onZoomChange
}: UniverSheetViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bundleRef = useRef<UniverBundle | null>(null)
  /** 最新 zoom / activeIndex 的同步镜像(原生 handler 闭包跨 render)。 */
  const zoomRef = useRef(zoom)
  const activeIndexRef = useRef(activeIndex)
  const onZoomChangeRef = useRef(onZoomChange)
  onZoomChangeRef.current = onZoomChange

  /** 当前定稿选区(不驱动渲染——问答条由 Univer popup 服务渲染)。 */
  const askRef = useRef<AskAnchor | null>(null)
  /** 已挂的问答条 popup(重挂/清除前先 dispose)。 */
  const popupRef = useRef<{ dispose: () => void } | null>(null)
  /** 按 sheet 懒注入 CF/图片/图表的入口(boot 时装配;切 sheet 补插)。 */
  const injectSheetRef = useRef<((index: number) => void) | null>(null)

  /** 当前激活 FWorksheet(facade;实例未就绪时 null)。 */
  const activeSheet = (): FWorksheetLike | null => {
    const wb = bundleRef.current?.univerAPI.getActiveWorkbook() ?? null
    return wb ? wb.getActiveSheet() : null
  }

  const clearAsk = (): void => {
    askRef.current = null
    popupRef.current?.dispose()
    popupRef.current = null
  }

  /** 数据区框选定稿 → 在选区右下格挂浮动问答条。定位交给 Univer 的
   *  popup 服务(attachPopup):滚动跟随/缩放/空间不足翻转全托管。
   *  ⚠️ 别回到手算坐标的路线——getCellRect 返回的是 skeleton 内容
   *  坐标(首格、不含滚动缩放换算),当视口坐标用问答条会飘到天边
   *  (2026-07-08 真机实测)。 */
  const showAskFor = (range: IRange): void => {
    clearAsk()
    const fws = activeSheet()
    if (!fws) return
    const label = rangeLabelOf(range)
    askRef.current = { range, label }
    try {
      const anchor = fws.getRange(range.endRow, range.endColumn, 1, 1)
      popupRef.current =
        anchor.attachPopup({
          componentKey: AskBarPopup,
          direction: 'vertical-center',
          offset: [0, 6],
          extraProps: {
            label,
            getTsv: () => selectionTsv(),
            onSend: (q: string) => void askAI(q)
          }
        }) ?? null
    } catch {
      askRef.current = null
    }
  }

  /* ── 实例生命周期(挂载一次;换文件/刷新由壳层换 key 重挂载) ── */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let disposed = false
    let created: UniverBundle | null = null
    const disposables: Array<{ dispose: () => void } | null | undefined> = []

    // ⚠️ 创建与销毁都必须推迟出 React 渲染周期(setTimeout 0):Univer
    // 内部持有自己的 React root,渲染期内同步 mount/unmount 它会触发
    // 「Attempted to synchronously unmount a root while React was
    // already rendering」(2026-07-08 dev 实测,cleanup 里同步
    // univer.dispose() 命中)。推迟创建还顺带解决 StrictMode 的
    // mount→unmount→mount 双跑:第一次 mount 的创建被 cleanup 取消,
    // 两个实例不会同时抢一个 container。
    const boot = (): void => {
    // locale 取创建时刻的应用语言;预览期间切语言不追(Univer 的
    // locale 是实例级配置,而本面板的 Univer 自带 UI 已裁到只剩右键
    // 都没有的画布,可见文案几乎为零)。
    const lang = useI18n.getState().lang
    const { univer, univerAPI } = createUniver({
      locale: lang === 'zh' ? LocaleType.ZH_CN : LocaleType.EN_US,
      locales: {
        [LocaleType.ZH_CN]: mergeLocales(sheetsCoreZhCN, sheetsDrawingZhCN, sheetsCfZhCN),
        [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS, sheetsDrawingEnUS, sheetsCfEnUS)
      },
      presets: [
        UniverSheetsCorePreset({
          container: el,
          // 预览面:壳层自带顶栏/tab 条,Univer 的应用壳全关,只留
          // 画布 + 行列头 + 滚动条。
          header: false,
          toolbar: false,
          footer: false,
          contextMenu: false,
          formulaBar: false,
          statusBarStatistic: false,
          // 别抢焦点:面板在聊天旁边分栏打开,焦点留给聊天输入框。
          disableAutoFocus: true,
          // openpyxl 不写公式缓存值:有缓存直接显示,空值由引擎现算。
          formula: { initialFormulaComputing: CalculationMode.WHEN_EMPTY }
        }),
        UniverSheetsDrawingPreset(),
        UniverSheetsConditionalFormattingPreset()
      ]
    })
    created = { univer, univerAPI }
    bundleRef.current = created

    const fWorkbook = univerAPI.createWorkbook(snapshot)

    /**
     * 只读锁(注入完成后上锁,幂等)。两层:
     *   1. mutation 闸门(真正的底线):onBeforeCommandExecute 里对
     *      MUTATION 型命令抛 CustomCommandExecutionError——commandService
     *      对这个错误类静默取消执行(return false),编辑提交/自动填充
     *      /粘贴/Delete 一网打尽。BeforeSheetEditStart 拦不住填充柄
     *      拖拽(2026-07-08 真机:B 列被 fill handle 批量填成「韩国」)。
     *      白名单放行不动用户数据的操作:formula.*(公式结果回填,拦
     *      了 openpyxl 无缓存值的公式永远算不出)、自动行高(wrap 文
     *      本渲染)、行高列宽拖拽、筛选。zoom/滚动/选区/切 sheet 是
     *      OPERATION,不经此门。
     *   2. BeforeSheetEditStart/BeforeClipboardPaste cancel:入口级,
     *      免得编辑器 UI 先弹出来再被闸门打回。
     */
    // ⚠️ 刻意不调 fWorkbook.setEditable(false):权限系统对编辑入口的
    // 拦截不可靠(双击照进编辑器),真正兜底的是 mutation 闸门;而它
    // 唯一稳定的表现反而是用户每次误触时弹「该范围已被保护,请联系
    // 创建者」dialog——协作语境的文案,对只读预览纯属打扰(2026-07-08
    // 真机)。预览的正确观感:编辑尝试静默无反应。
    let locked = false
    const lockReadonly = (): void => {
      if (locked || disposed) return
      locked = true
      disposables.push(
        univerAPI.onBeforeCommandExecute((command, options) => {
          // 懒注入窗口(切 sheet 补插 CF/图片/图表)放行——窗口内只
          // 跑我们自己的注入代码。
          if (injecting) return
          if (READONLY_BLOCKED_COMMANDS.has(command.id)) {
            throw new CustomCommandExecutionError('sheet preview is read-only')
          }
          if (command.type !== CommandType.MUTATION) return
          if (
            command.id.startsWith('formula.') ||
            READONLY_ALLOWED_MUTATIONS.has(command.id)
          ) {
            return
          }
          // drawing 落地按 op 类型细分:懒注入只 INSERT;REMOVE/UPDATE
          // 只可能来自用户(Delete/拖拽),拦。
          if (command.id === 'sheet.mutation.set-drawing-apply') {
            if (
              (command.params as { type?: number } | undefined)?.type ===
              DRAWING_APPLY_INSERT
            ) {
              return
            }
            throw new CustomCommandExecutionError('sheet preview is read-only')
          }
          // 公式引擎把计算结果回写 cellData 走的也是 set-range-values
          // (CalculateResultApplyController 监听 formula 的 result
          // mutation 后 sequenceExecute 转发),但执行 options 带
          // fromFormula/applyFormulaCalculationResult 标记——放行,
          // 否则 WHEN_EMPTY 现算的结果永远上不了屏(生成器写空 <v/>
          // 又 fullCalcOnLoad 的文件整表公式格全空,2026-07-09 销售
          // 透视示例实拍)。用户编辑路径的 set-range-values 不带该
          // 标记,只读边界不受影响。
          if (
            command.id === 'sheet.mutation.set-range-values' &&
            ((options as { fromFormula?: boolean; applyFormulaCalculationResult?: boolean } | undefined)
              ?.fromFormula ||
              (options as { applyFormulaCalculationResult?: boolean } | undefined)
                ?.applyFormulaCalculationResult)
          ) {
            return
          }
          throw new CustomCommandExecutionError('sheet preview is read-only')
        })
      )
    }

    // 壳层在实例就绪前设定的 sheet/zoom(彼时对应 effect 是 no-op)
    // 在此补齐;boot 被推迟了一拍,首帧的 activeIndex 可能非 0。
    const initIdx = activeIndexRef.current
    if (initIdx > 0) {
      const target = fWorkbook.getSheets()[initIdx]
      if (target) fWorkbook.setActiveSheet(target)
    }
    if (Math.abs(zoomRef.current - 1) > 0.001) {
      try {
        fWorkbook.getActiveSheet().zoom(zoomRef.current)
      } catch {
        /* ignore */
      }
    }

    /**
     * 注入(条件格式/图片/图表)按 sheet【懒执行】:激活哪个注入哪个
     * (boot 注当前,切 sheet 补插,injectedSheets 防重)。两个原因:
     *   - float DOM 对【非激活 sheet】插入不可靠(渲染器未就绪,
     *     2026-07-08 真机:图表看板的 9 张图全空);插入时目标必须是
     *     激活 sheet。
     *   - 图片 buildAsync 是异步的,整段 async 串行。
     * 与只读闸门的配合:首个 sheet 注入完就 lockReadonly();后续懒
     * 注入经 injecting 窗口放行(闸门回调首行检查)——窗口内只跑我
     * 们自己的注入代码,用户操作插不进同步段。
     */
    /**
     * float DOM 插入的按帧重试。addFloatDomToPosition 内部要经
     * 渲染层(selectionRenderService/skeleton)把坐标反算成 cell 锚,
     * 而渲染层在 createWorkbook 之后【异步】就绪——同步紧跟的注入会
     * 拿到 null 被静默丢弃(2026-07-08 真机:图表/图片全灭的真正根
     * 因;切 sheet 后新 sheet 的 skeleton 同样要等)。失败按 rAF 重
     * 试到就绪为止;set-drawing-apply 已在白名单,时序不再敏感。
     */
    /**
     * float DOM 渲染对象加固:全部 evented=false——引擎 pick(命中
     * 测试)直接跳过它们。这是「浮层可被拖拽/点选」的总闸:
     * eventPassThrough 转发回 canvas 的事件命中 drawing 对象后,
     * transformer 的拖拽是【对象级订阅】,不发 command,mutation 闸门
     * 只能保数据、拦不住视觉被拖走(2026-07-09 真机:装饰被拖进数据
     * 区)。evented=false 后事件穿过浮层命中底下的网格——图表/图片
     * 上方框选问 AI 正是靠这个。幂等全扫,每次插入成功后补跑。
     */
    const hardenFloatDoms = (): void => {
      if (disposed) return
      try {
        const injector = univer.__getInjector()
        const render = injector.get(IRenderManagerService).getRenderById('sheet-preview')
        if (!render) return
        for (const obj of render.scene.getAllObjects()) {
          if (
            obj.objectType === ObjectType.DRAWING_DOM ||
            obj.objectType === ObjectType.CHART
          ) {
            obj.evented = false
          }
        }
      } catch {
        // 加固失败只是回到"可被拖拽"的旧行为,不损内容。
      }
    }

    const addFloatDomWithRetry = (make: () => unknown, tries = 60): void => {
      const attempt = (): void => {
        if (disposed) return
        let ok = false
        try {
          ok = make() != null
        } catch {
          ok = false
        }
        if (ok) {
          // 插入的落地 mutation 是 fire-and-forget,渲染对象在下一帧
          // 才有——rAF 后全扫加固(幂等)。
          requestAnimationFrame(hardenFloatDoms)
        } else if (tries-- > 0) {
          requestAnimationFrame(attempt)
        }
      }
      attempt()
    }

    const injectedSheets = new Set<number>()
    let injecting = false
    const injectSheet = async (index: number): Promise<void> => {
      if (disposed || injectedSheets.has(index)) return
      injectedSheets.add(index)
      const meta = sheets[index]
      const fws = fWorkbook.getSheets()[index]
      if (!meta || !fws) return
      injecting = true
      try {
        for (const { rule, ranges } of meta.cf) {
          if (disposed) return
          try {
            injectCondFmt(fws, rule, ranges)
          } catch {
            // 单条规则失败不连坐(colorScale 停靠点形态千奇百怪)。
          }
        }

        // 格子角落装饰(筛选按钮装饰 / 批注红三角):float DOM 纯展示。
        // ⚠️ eventPassThrough 必须 false:它的实现是把 pointer 事件
        // 【转发回 canvas】,引擎 pick 又命中这个 drawing 对象——
        // transformer 直接进入拖拽(对象级订阅,不经 command,闸门
        // 拦不到视觉层;UPDATE mutation 被拦只保数据,拖走的视觉不
        // 回滚),2026-07-09 真机装饰被拖进数据区。false 时 wrapper
        // 吞掉事件,不可拖不可选;盒子已收窄成角标本身(十几像素),
        // 不挡格子交互(框选/点选照常)。
        for (const dc of meta.decors) {
          if (disposed) return
          addFloatDomWithRetry(() =>
            fws.addFloatDomToPosition({
              componentKey: FloatDecorBadge,
              initPosition: {
                startX: SHEET_ROW_HEADER_W + dc.x,
                endX: SHEET_ROW_HEADER_W + dc.x + dc.w,
                startY: SHEET_COL_HEADER_H + dc.y,
                endY: SHEET_COL_HEADER_H + dc.y + dc.h
              },
              allowTransform: false,
              eventPassThrough: false,
              // data 要求 Serializable,undefined 字段不收。
              data: dc.tip !== undefined ? { kind: dc.kind, tip: dc.tip } : { kind: dc.kind }
            })
          )
        }

        // 图片与图表同走 float DOM 纯展示——刻意不用真 drawing
        // (newOverGridImage/insertImages):drawing 体系自带选中手柄/
        // 拖拽/旋转/裁剪/翻转功能菜单,allowTransform 也压不干净
        // (2026-07-08 真机:图片被旋转出 15°)。float DOM 不是
        // drawing 对象,这些交互从根上不存在;eventPassThrough 让
        // 点击穿透,图片下方照样框选问 AI——预览的修改路径只有 AI。
        // initPosition 是画布坐标(scroll=0、zoom=1 时 = 内容坐标 +
        // 表头偏移);插入后 Univer 把它换算成 cell 锚定的 transform,
        // 滚动缩放自动跟随。
        for (const img of meta.images) {
          if (disposed) return
          addFloatDomWithRetry(() =>
            fws.addFloatDomToPosition({
              componentKey: FloatImageCard,
              initPosition: {
                startX: SHEET_ROW_HEADER_W + img.x,
                endX: SHEET_ROW_HEADER_W + img.x + img.spec.wPx,
                startY: SHEET_COL_HEADER_H + img.y,
                endY: SHEET_COL_HEADER_H + img.y + img.spec.hPx
              },
              allowTransform: false,
              eventPassThrough: true,
              data: img.spec
            })
          )
        }

        for (const ch of meta.charts) {
          if (disposed) return
          addFloatDomWithRetry(() =>
            fws.addFloatDomToPosition({
              componentKey: FloatChartCard,
              initPosition: {
                startX: SHEET_ROW_HEADER_W + ch.x,
                endX: SHEET_ROW_HEADER_W + ch.x + ch.spec.wPx,
                startY: SHEET_COL_HEADER_H + ch.y,
                endY: SHEET_COL_HEADER_H + ch.y + ch.spec.hPx
              },
              allowTransform: false,
              eventPassThrough: true,
              data: ch.spec
            })
          )
        }
      } finally {
        injecting = false
        // 兜底再扫一轮:成批注入时个别 rect 可能晚于最后一次 rAF 才
        // 建出来(fire-and-forget 链)。
        setTimeout(hardenFloatDoms, 200)
      }
    }
    injectSheetRef.current = (index) => {
      void injectSheet(index).catch(() => {
        /* 注入是增强不是底线 */
      })
    }

    ;(async () => {
      await injectSheet(activeIndexRef.current)
      // 首个 sheet 注入完就上锁(注入自身要走 mutation,先锁会拦掉);
      // 之后的懒注入靠 injecting 窗口过闸门。
      lockReadonly()
    })().catch(() => {
      // 注入是增强不是底线;失败也要把只读锁上。
      lockReadonly()
    })

    /* 事件:只读闸门 + 选区定稿 → 问答条 + 缩放同步壳层。 */
    disposables.push(
      // 只读的确定性闸门:setEditable(false) 走权限系统,但 0.25.1
      // 实测双击仍能拉起单元格编辑器(2026-07-08 真机)——不赌权限
      // 点对各入口的覆盖,编辑器启动/粘贴一律 cancel。复制不拦
      // (问答条的复制按钮之外,⌘C 也是合法读操作)。
      univerAPI.addEvent(univerAPI.Event.BeforeSheetEditStart, (params) => {
        ;(params as { cancel?: boolean }).cancel = true
      }),
      univerAPI.addEvent(univerAPI.Event.BeforeClipboardPaste, (params) => {
        ;(params as { cancel?: boolean }).cancel = true
      }),
      univerAPI.addEvent(univerAPI.Event.SelectionMoveEnd, (params) => {
        const ranges = (params as { selections?: IRange[] }).selections
        const last = ranges?.[ranges.length - 1]
        if (!last) {
          clearAsk()
          return
        }
        // 行头/列头/全选是「看一眼范围」的轻量动作,弹输入框读作打扰
        // (迁移前逻辑,2026-07-08 用户重申);仅数据区框选出条。
        // rangeType 不保证随事件带出来(点列头可能给 undefined),
        // 按几何兜底:铺满整列高度/整行宽度的选区一律不弹。
        const wsSnap =
          snapshot.sheets?.[snapshot.sheetOrder?.[activeIndexRef.current] ?? '']
        const rowCount = wsSnap?.rowCount ?? 0
        const colCount = wsSnap?.columnCount ?? 0
        const headerDriven =
          (last.rangeType !== undefined && last.rangeType !== RANGE_TYPE.NORMAL) ||
          (rowCount > 0 && last.startRow <= 0 && last.endRow >= rowCount - 1) ||
          (colCount > 0 && last.startColumn <= 0 && last.endColumn >= colCount - 1)
        if (headerDriven) {
          clearAsk()
          return
        }
        showAskFor(last)
      }),
      univerAPI.addEvent(univerAPI.Event.SheetZoomChanged, (params) => {
        const z = (params as { zoom?: number }).zoom
        if (typeof z === 'number' && Number.isFinite(z)) {
          zoomRef.current = z
          onZoomChangeRef.current(z)
        }
      })
    )
    }

    const bootTimer = window.setTimeout(() => {
      if (!disposed) boot()
    }, 0)

    return () => {
      disposed = true
      window.clearTimeout(bootTimer)
      bundleRef.current = null
      injectSheetRef.current = null
      clearAsk()
      for (const d of disposables) {
        try {
          d?.dispose()
        } catch {
          /* ignore */
        }
      }
      // dispose 同样推迟出渲染周期(见 boot 前注释);实例引用的
      // container 此刻已随组件树离场,晚一拍释放无副作用。
      const b = created
      if (b) {
        window.setTimeout(() => {
          try {
            b.univer.dispose()
          } catch {
            /* ignore */
          }
        }, 0)
      }
    }
    // 实例生命周期 = 组件生命周期(壳层 key 保证 props 快照稳定)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── sheet 切换(壳层 tab 条驱动) ── */
  useEffect(() => {
    activeIndexRef.current = activeIndex
    const wb = bundleRef.current?.univerAPI.getActiveWorkbook()
    if (!wb) return
    const target = wb.getSheets()[activeIndex]
    if (target && wb.getActiveSheet()?.getSheetId() !== target.getSheetId()) {
      wb.setActiveSheet(target)
      // 激活后补插该 sheet 的 CF/图片/图表(懒注入,见 mount effect)。
      injectSheetRef.current?.(activeIndex)
      // zoom 是 per-sheet 状态,切过去补齐到当前档。
      try {
        target.zoom(zoomRef.current)
      } catch {
        /* ignore */
      }
    }
    clearAsk()
  }, [activeIndex])

  /* ── 缩放:壳层按钮驱动(ctrl+滚轮在下面的原生 handler 里) ── */
  useEffect(() => {
    zoomRef.current = zoom
    const fws = activeSheet()
    if (!fws) return
    try {
      if (Math.abs(fws.getZoom() - zoom) > 0.001) fws.zoom(zoom)
    } catch {
      /* 实例尚未就绪等瞬态,下一次 effect 会补上 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom])

  // ⌘/Ctrl+滚轮缩放(触控板捏合在 Chromium 里就是 ctrl+wheel)。挂
  // capture 阶段 + 非 passive:要在 Univer 自己的 wheel(滚动)之前
  // 截胡并 preventDefault,否则缩放手势会同时触发画布滚动。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let pending: number | null = null
    let raf = 0
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      // 指数缩放,系数沿用迁移前多轮调校的 0.015(每 -100 deltaY ≈
      // ×4.5);rAF 合帧后一次 zoom() ——Univer 的 canvas 缩放本身廉价,
      // 但别让高频触控板事件逐条打命令系统。
      const cur = pending ?? zoomRef.current
      pending = clampZoom(cur * Math.exp(-e.deltaY * 0.015))
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          if (pending === null) return
          const z = pending
          pending = null
          zoomRef.current = z
          try {
            activeSheet()?.zoom(z)
          } catch {
            /* ignore */
          }
          onZoomChangeRef.current(z)
        })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true })
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc 收起问答条(选区高亮留着,与 Excel 行为一致)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') clearAsk()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ── 选区 → TSV / AI ── */

  const selectionTsv = (maxRows?: number): string => {
    const cur = askRef.current
    const wb = bundleRef.current?.univerAPI.getActiveWorkbook()
    if (!cur || !wb) return ''
    const { range } = cur
    const numRows = range.endRow - range.startRow + 1
    const rows = maxRows ? Math.min(numRows, maxRows) : numRows
    try {
      const fws = wb.getActiveSheet()
      return fws
        .getRange(range.startRow, range.startColumn, rows, range.endColumn - range.startColumn + 1)
        .getDisplayValues()
        .map((row) => row.join('\t'))
        .join('\n')
    } catch {
      return ''
    }
  }

  const askAI = async (q: string): Promise<void> => {
    const cur = askRef.current
    const meta = sheets[activeIndexRef.current]
    // 会话状态取发送时刻的最新值(popup 的 onSend 闭包可能捕获陈旧
    // render,别信 hook 闭包)。
    const { sessionId, streaming } = useChatStore.getState()
    if (!cur || !meta || !q || streaming || !sessionId) return
    // 截断标注按【实际有数据的行数】判断——拖到空白区的 endRow 不该
    // 对着几十行数据谎报「仅附前 300 行」。
    const effRows =
      Math.min(cur.range.endRow + 1, meta.totalRows) - cur.range.startRow
    const truncated = effRows > SHEET_MAX_SEND_ROWS
    const tsv = selectionTsv(SHEET_MAX_SEND_ROWS)
    const fname = path.split('/').pop() ?? path
    // 首行协议标记:UserMessage 识别后把这条消息渲染成注释胶囊卡片
    // (文件名/范围/问题)。CLI 文本与气泡 display 都带——transcript
    // 存的是 CLI 侧文本,历史恢复同样卡片化。
    const metaJson: SheetSelectionMeta = {
      name: fname,
      path,
      sheet: meta.name,
      range: cur.label,
      q
    }
    const marker = SHEET_SELECTION_MARKER + JSON.stringify(metaJson)
    const text =
      `${marker}\n我正在查看表格文件 ${path} 的工作表「${meta.name}」,选中了 ${cur.label} 区域,内容如下(制表符分隔,首行行号 ${cur.range.startRow + 1}${truncated ? `,数据较多仅附前 ${SHEET_MAX_SEND_ROWS} 行` : ''}):\n\n` +
      '```\n' +
      tsv +
      '\n```\n\n' +
      q
    const display = `${marker}\n${q}`
    clearAsk()
    await dispatchChatTurn({
      sessionId,
      storeContent: [{ type: 'text', text: display }],
      logTag: '[sheet-preview]',
      payload: { sessionId, text }
    })
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* Univer 容器:实例把画布/滚动条/问答条 popup 都渲染进来。表格
          画布是「文件的纸面」——Univer 默认浅色主题,不吃应用的暗档
          token,暗色主题花斑问题结构性消失(迁移前要靠写死浅色硬顶)。 */}
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  )
}

/* ── 浮动问答条(Univer popup 服务渲染,锚在选区右下格) ── */

type AskPopupExtra = {
  label: string
  getTsv: () => string
  onSend: (q: string) => void
}

/**
 * Univer 的 popup 组件收到的是整个 popup 对象,业务数据在 extraProps
 * 里(它家 CellAlert 等自有弹层同此约定)。zustand 的 hook 跨 React
 * 树可用,i18n/会话状态直接取。
 * ⚠️ popup 挂载点可能在 .chat-app 之外——裸交互元素必须带 data-slot
 * 逃逸 canvas 的裸元素 reset(portal 老坑,2026-07-04 三连踩)。
 */
function AskBarPopup(props: {
  popup: { extraProps?: Partial<AskPopupExtra> }
}): React.JSX.Element | null {
  const t = useT()
  const sessionId = useChatStore((s) => s.sessionId)
  const streaming = useChatStore((s) => s.streaming)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const extra = props.popup.extraProps
  if (!extra?.label || !extra.onSend || !extra.getTsv) return null
  const send = (): void => {
    const q = text.trim()
    if (q) extra.onSend!(q)
  }
  const copy = (): void => {
    const tsv = extra.getTsv!()
    if (!tsv) return
    void navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div
      data-slot="sheet-ask"
      className="flex items-center gap-1 rounded-full border border-border/70 bg-popover py-1 pl-3 pr-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.35),0_2px_8px_rgba(0,0,0,0.1)]"
    >
      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
        {extra.label}
      </span>
      <input
        data-slot="sheet-ask-input"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={t('sheetPreviewAskPlaceholder')}
        className="w-52 select-text bg-transparent px-1.5 text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
      />
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('sheetPreviewCopy')}
        title={t('sheetPreviewCopy')}
        className="size-6 text-muted-foreground hover:text-foreground"
        onClick={copy}
      >
        {copied ? (
          <Check className="size-3.5 text-brand" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      <Button
        size="icon"
        aria-label={t('sheetPreviewSend')}
        title={t('sheetPreviewSend')}
        disabled={!text.trim() || streaming || !sessionId}
        className="size-6 rounded-full"
        onClick={send}
      >
        <ArrowUp className="size-3.5" />
      </Button>
    </div>
  )
}

/* ── 条件格式注入:CondRule → Univer builder ── */

type FWorksheetLike = ReturnType<
  NonNullable<ReturnType<UniverBundle['univerAPI']['getActiveWorkbook']>>['getSheets']
>[number]

/** OOXML cfvo type → Univer CFValueType(formula 型停靠点降级按数值)。 */
function cfValueTypeOf(ooxml: string): CFValueType {
  switch (ooxml) {
    case 'min':
      return CFValueType.min
    case 'max':
      return CFValueType.max
    case 'percent':
      return CFValueType.percent
    case 'percentile':
      return CFValueType.percentile
    default:
      return CFValueType.num
  }
}

function injectCondFmt(fws: FWorksheetLike, rule: CondRule, ranges: IRange[]): void {
  const builder = fws.newConditionalFormattingRule()
  if (rule.kind === 'dataBar') {
    // OOXML 经典 dataBar 默认渐变填充;负值红是 Excel 缺省。
    fws.addConditionalFormattingRule(
      builder
        .setDataBar({
          min: { type: CFValueType.min },
          max: { type: CFValueType.max },
          positiveColor: rule.color,
          nativeColor: '#d64550',
          isGradient: true,
          isShowValue: true
        })
        .setRanges(ranges)
        .build()
    )
    return
  }
  if (rule.kind === 'colorScale') {
    fws.addConditionalFormattingRule(
      builder
        .setColorScale(
          rule.stops.map((s, index) => ({
            index,
            color: s.color,
            value: { type: cfValueTypeOf(s.type), value: s.value }
          }))
        )
        .setRanges(ranges)
        .build()
    )
    return
  }
  // cellIs:数值比较 → 高亮(dxf 的字色/底色)。
  let hb
  switch (rule.op) {
    case 'lessThan':
      hb = builder.whenNumberLessThan(rule.value)
      break
    case 'lessThanOrEqual':
      hb = builder.whenNumberLessThanOrEqualTo(rule.value)
      break
    case 'greaterThan':
      hb = builder.whenNumberGreaterThan(rule.value)
      break
    case 'greaterThanOrEqual':
      hb = builder.whenNumberGreaterThanOrEqualTo(rule.value)
      break
    case 'equal':
      hb = builder.whenNumberEqualTo(rule.value)
      break
    case 'notEqual':
      hb = builder.whenNumberNotEqualTo(rule.value)
      break
    default:
      return
  }
  if (rule.bg) hb = hb.setBackground(rule.bg)
  if (rule.color) hb = hb.setFontColor(rule.color)
  fws.addConditionalFormattingRule(hb.setRanges(ranges).build())
}
