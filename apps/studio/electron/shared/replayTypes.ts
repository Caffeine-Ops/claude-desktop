/**
 * 会话录像包（.claudereplay）的数据契约——main 侧导出/导入编译器与
 * renderer 侧回放 driver 共用。
 *
 * 包 = 单文件 zip：
 *   manifest.json   —— ReplayManifest（版本、meta、资产清单）
 *   timeline.json   —— ReplayTimeline（多轨时间线）
 *   assets/<sha1前8>.<ext> —— 从导出机收集的图片资产
 *
 * 时间粒度约定（为什么是「块级 item + durMs」而不是 token 级事件）：
 * transcript 只有消息级 timestamp，token 级节奏本来就要合成；把合成留到
 * 播放期（driver 按虚拟时钟切片）意味着倍速/seek 只操作时钟，不用重编译
 * timeline，且同一份录像在任何倍速下都平滑。item.t 一律是【真实】毫秒
 * 偏移（相对录制起点）；长空窗（生图 2 分钟）的压缩（gap-cap）也是播放期
 * 预计算，录像保留真实节奏以便将来做「原速回放」。
 */
import type { WorkflowTask } from './types'

export const REPLAY_FORMAT_VERSION = 1

/** 录像包文件扩展名（保存/打开对话框的 filter 共用）。 */
export const REPLAY_FILE_EXT = 'claudereplay'

export interface ReplayManifest {
  version: typeof REPLAY_FORMAT_VERSION
  /** ISO 时间串，导出时刻。 */
  createdAt: string
  /** 导出方 app 版本（排查跨版本回放问题用，不参与校验）。 */
  appVersion: string
  meta: ReplayMeta
  assets: ReplayAsset[]
}

export interface ReplayMeta {
  /** 会话标题（导出时的 rail 标题快照）。 */
  title: string
  sourceSessionId: string
  /** 真实总时长（最后一个 item 的 t + durMs）；播放端权威时长仍自算。 */
  realDurationMs: number
  messageCount: number
  /**
   * 演示卡描述（可选）——导出流程不收集，内置演示手工编辑 manifest 补充；
   * 缺省时首页卡片用「N 轮对话」兜底文案。
   */
  description?: string
  /**
   * 虚拟播放时长（gap-cap/块 cap 后，shared/replayTiming 同源预算）。
   * 首页演示卡的时长角标直接读它，免得列表时解开整个 timeline 重算；
   * 旧包缺此字段时列表侧现算兜底。
   */
  virtualDurationMs?: number
  /**
   * 会话的工作区模式。'slides' = 制作 PPT 会话（渲染层是 per-session 的
   * slidesSessions 标记，见 stores/composerMode）——回放时给 replay slot
   * 打同款标记撑开双分栏，右侧渲染 SlidesWorkspace 的回放形态（预览 tab
   * 换静态查看器，见 ReplaySlidesViewer）。导出入口从 slidesSessions 读出
   * 后随 payload 传入（renderer 状态，main 无从推断）。
   */
  mode?: 'slides'
  /**
   * mode='slides' 时的【权威】幻灯片清单（导出机 svg_output 目录的最终
   * 状态，按文件名数字序）。为什么不能让播放端从消息里扫 svg 路径自推：
   * ① 消息里混着 ppt-master 的模板参考图（templates/charts/*.svg），会把
   * 13 页扫成 17 页；② 导入时路径被重写成 assets/<sha1>.svg，按文件名
   * 排序退化成按哈希排序，页序全靠运气。清单在导出时落定（deriveSlides，
   * 见 replayPackage.ts），播放端只用消息扫描做「播到第几页」的揭示判定。
   */
  slides?: ReplaySlideEntry[]
  /**
   * ppt-master 八项确认（confirm_ui）的选择快照，按命中顺序排列——tier1
   * 一份、final（tier2）一份，同一轮 confirm 流程正常产出两份。落定在导出
   * 时刻（collectConfirmSnapshots，见 replayPackage.ts），不是播放时去读
   * 项目目录：confirm_ui/recommendations.json 会被 tier2 原地覆盖、项目目
   * 录也可能被后续会话删除或复用，只有 confirm_ui/server.py 在命中当下打进
   * Bash 工具输出的 `[[confirm-result]]` 日志行（见该文件同名注释）还留着
   * 「当时页面上有什么、用户选了什么」的一致快照。播放端（compileReplay 的
   * buildConfirmPerformance）按 toolUseId 把 Bash 工具调用与这里的快照一一
   * 对应。旧版（此字段落地前）导出的包没有它，回放会跳过 confirm 表演——
   * 聊天轨不受影响，见 replayTypes 头部 ui 轨注释。
   */
  confirmSnapshots?: ReplayConfirmSnapshot[]
}

export interface ReplayConfirmSnapshot {
  /** 产出这份快照的 Bash 工具调用——compileReplay 靠它把快照与 tool item 对上。 */
  toolUseId: string
  stage: 'tier1' | 'final'
  /** confirm_ui/server.py 写的 result.json 全文（用户这一段的最终选择）。 */
  result: Record<string, unknown>
  /**
   * confirm_ui/server.py 写的 recommendations.json 全文（AI 生成的候选，
   * 该 stage 命中那一刻的快照）——CanvasConfirm 离线渲染需要它才能画出选项
   * 列表/推荐星标/色板候选，只有 result 里的最终选择不够摆出整页 UI。
   * server.py 读取失败时为 null（best-effort，不影响 result 本身落地）。
   */
  recommendations: Record<string, unknown> | null
  /**
   * confirm_ui/static/catalogs.json 全文（静态选项universe——画布格式/风格/
   * icons 等枚举字段的候选来自它，不是 recommendations）。虽然是随 skill
   * 打包的静态配置，仍然跟着这份快照走：这样回放侧永远不用在运行时定位
   * skill 安装目录（dev/prod 路径不同，是个真实的跨环境坑），一份自包含
   * 快照打完收工。server.py 读取失败时为 null（best-effort）。
   */
  catalogs: Record<string, unknown> | null
}

export interface ReplaySlideEntry {
  /** 包内相对路径（与 ReplayAsset.rel 同一空间）。 */
  rel: string
  /** 展示名 = 原文件名去扩展名（如 '13_closing课堂讨论框架'）。 */
  title: string
  /**
   * 解包后的绝对路径——【导入时】由 openReplayPackage 注入，包内 manifest
   * 不含此字段（导出机路径无意义）。播放端用它 readImageFile + 与重写后
   * 消息文本里的路径做揭示匹配（重写让两者字符串相等）。
   */
  path?: string
}

export interface ReplayAsset {
  /** 内容 sha1 前 8 位（也是包内文件名主体）。 */
  id: string
  /** 包内相对路径，如 'assets/a1b2c3d4.png'。 */
  rel: string
  /**
   * 导出机上的绝对路径。导入侧解包后对 timeline 原始文本做
   * originalPath → 解包后绝对路径 的整体重写（详见 replayPackage.ts），
   * 使 ImageEditPanel/ImageGenCard 等按路径读盘的消费组件零改动可用。
   */
  originalPath: string
  bytes: number
}

export interface ReplayTimeline {
  version: typeof REPLAY_FORMAT_VERSION
  /** 按数组顺序播放；t 单调不减（编译器保证）。 */
  items: ReplayItem[]
}

/** assistant-ui 内容 part 的宽松序列化形态（与 chat store 的 part 同构）。 */
export type SerializedContentPart = { type: string; [key: string]: unknown }

interface ReplayItemBase {
  id: string
  /** 相对录制起点的真实毫秒偏移。 */
  t: number
}

/* ── chat 轨 ──
 * 与 live 的 ChatEvent 序列对齐的「压缩形态」：turn_start → 若干内容块 →
 * turn_end。播放端把每个块按虚拟时钟展开成 ChatEvent 微步（text → chunk
 * 切片、tool → tool_use_start/delta/end/result），统一喂
 * applyChatEventToStore(live=null)。 */

export type ReplayChatItem = ReplayItemBase &
  (
    | {
        track: 'chat'
        /** 用户消息整条瞬时落卡（live 里它也是 composer 一次性 append 的）。 */
        op: 'user_message'
        content: SerializedContentPart[]
      }
    | {
        track: 'chat'
        /** → {type:'start', messageId}。每条 assistant 消息一个（对齐 live）。 */
        op: 'turn_start'
        messageId: string
      }
    | {
        track: 'chat'
        /** 整段正文文本；播放端按 durMs 切片成 chunk 打字机。 */
        op: 'text'
        messageId: string
        text: string
        durMs: number
      }
    | {
        track: 'chat'
        /** thinking 块 → thinking_start/delta/end。 */
        op: 'thinking'
        messageId: string
        text: string
        durMs: number
      }
    | {
        track: 'chat'
        /** 工具调用：args 流式 argsDurMs，随后 runDurMs 后落 result。 */
        op: 'tool'
        messageId: string
        toolUseId: string
        toolName: string
        argsJson: string
        argsDurMs: number
        runDurMs: number
        result?: unknown
        /** workflow 卡的子任务（从 <task-notification> 重建），result 前逐条亮起。 */
        tasks?: WorkflowTask[]
      }
    | {
        track: 'chat'
        /** → {type:'end', messageId}。每个 turn（下一条 user 消息前）一个。 */
        op: 'turn_end'
        messageId: string
      }
  )

/* ── ui 轨 ──
 * 图片编辑面板的表演序列，由编译器从 [[image-edit]] user 消息的
 * ImageEditMeta 反推（消息自带全部坐标/文字，无需真实录制）。播放端经
 * imageEditDemoRegistry 驱动真实 ImageEditPanel；任何一步失败（面板没
 * 就绪/被分栏挡住）则跳过整段 ui 轨，聊天轨照常。
 *
 * askQuestion.* 与 confirm.* 是同一模式在「问题」tab 两种表单上的扩展
 * （2026-07-13 第二批）：
 * - askQuestion.*：从 AskUserQuestion 这个 tool-call 的 args（问题列表）+
 *   result（{answers}}，两者本来就在 transcript 里）反推，数据总是齐全。
 * - confirm.*：ppt-master 八项确认的选择只落盘到 result.json、从不进
 *   transcript，编译器只能从 confirm_ui/server.py 新打的
 *   `[[confirm-result]]{...}` 日志行（该 Bash 工具调用的 tool result 里）
 *   反推——**在此改动前录制的旧回放包没有这行日志，反推不出选择内容，
 *   编译器会跳过 confirm 表演**（聊天轨不受影响，见
 *   compileReplay.ts 的 buildConfirmPerformance）。
 * 两者都只做视觉：驱动真实组件（CanvasQuestionnaire/CanvasConfirm）暴露的
 * 命令式 handle 把选项/输入框推进「已选中」态，绝不触发它们真实的提交路径
 * （respond()/fetch /api/confirm）——回放的「结果」始终由 chat 轨的
 * tool_result/user_message 提供，表演只是把过程演给观众看。 */

export type ReplayUiItem = ReplayItemBase &
  (
    | { track: 'ui'; op: 'imageEdit.open'; path: string }
    | {
        track: 'ui'
        op: 'imageEdit.addMarker'
        x: number
        y: number
        w?: number
        h?: number
      }
    | { track: 'ui'; op: 'imageEdit.typeNote'; text: string; durMs: number }
    | { track: 'ui'; op: 'imageEdit.commitMarker' }
    | { track: 'ui'; op: 'imageEdit.typeExtra'; text: string; durMs: number }
    | { track: 'ui'; op: 'imageEdit.pressSend' }
    | { track: 'ui'; op: 'imageEdit.close' }
    /* ── AskUserQuestion 表演（问题 tab） ── */
    | {
        track: 'ui'
        op: 'askQuestion.open'
        /** 题目列表的 JSON（{questions:[...]}}，即该 tool-call 的 args
         *  原样）——播放端直接 JSON.parse 拿完整题目，不必反查 chat 轨的
         *  tool item（表演与数据供给解耦，同 confirm.open 携带 toolUseId
         *  而不是让消费方去扫 messages 的思路一致）。 */
        questionsJson: string
      }
    | {
        track: 'ui'
        op: 'askQuestion.select'
        /** 题面文本——播放端按此在当前 questions 列表里定位题目（与
         *  CanvasQuestionnaire 的 answers 字典同一个 key 空间）。 */
        question: string
        label: string
      }
    | {
        track: 'ui'
        op: 'askQuestion.typeOther'
        question: string
        text: string
        durMs: number
      }
    | { track: 'ui'; op: 'askQuestion.submit' }
    /* ── ppt-master 八项确认表演（问题 tab，tier1 → tier2 两段） ── */
    | {
        track: 'ui'
        op: 'confirm.open'
        tier: 1 | 2
        /** 产出这段表演的 Bash 工具调用 id——播放端用它在
         *  manifest.meta.confirmSnapshots 里找到同一个 toolUseId 的
         *  ReplayConfirmSnapshot，取其 recommendations 离线渲染
         *  CanvasConfirm（选项列表/推荐星标/色板候选都从这份数据来，
         *  后续 confirm.select/typeText 只管把已渲染好的选项点亮）。 */
        toolUseId: string
      }
    | { track: 'ui'; op: 'confirm.select'; field: string; value: string }
    | {
        track: 'ui'
        op: 'confirm.typeText'
        field: string
        text: string
        durMs: number
      }
    | { track: 'ui'; op: 'confirm.advanceTier2' }
    | { track: 'ui'; op: 'confirm.submitFinal' }
  )

export type ReplayItem = ReplayChatItem | ReplayUiItem
