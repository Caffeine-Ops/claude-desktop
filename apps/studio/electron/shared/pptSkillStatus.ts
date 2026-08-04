/**
 * ppt-creator skill 的安装状态（main ↔ renderer 共享的纯数据契约）。
 *
 * 这个 skill 不再随安装包发布（99MB 未压缩 / 12167 个文件），改成首次需要时
 * 从远端下载。用户点「制作PPT」时若尚未就绪，会看到一个全屏进度层，直到
 * 三段工作全部完成才放行：
 *
 *   ① download —— 49MB zip（网络）
 *   ② extract  —— 解压 12167 个文件（磁盘，utilityProcess 里做）
 *   ③ python   —— 首次建 venv 并 pip install 约 18 个依赖（网络 + 编译，可能几分钟）
 *
 * ③ 常被忽略但恰恰是最慢的一段：skill 的 `bin/ensure-python.sh` 原本是在
 * 会话里由 AI 第一次跑 Python 命令时才触发的，于是「下完就能用」是个假象
 * ——用户会在进入对话后再干等几分钟且没有任何进度提示。所以安装流程主动把
 * 它提前跑掉，纳入同一个进度层。
 *
 * `phase` 是给 UI 选文案用的粗粒度阶段；`done/total` 的单位随阶段变化
 * （字节 / 文件数），UI 只拿它算百分比，不要跨阶段累加。
 */

export type PptSkillPhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'extracting'
  | 'preparing-python'
  | 'ready'
  | 'error'

export interface PptSkillStatus {
  phase: PptSkillPhase
  /** 当前阶段的进度分子（downloading=字节，extracting=文件数），其余阶段为 0。 */
  done: number
  /** 当前阶段的进度分母；0 表示总量未知，UI 应退化成不确定进度条。 */
  total: number
  /** 已装版本；未装为 null。 */
  installedVersion: string | null
  /** phase='error' 时的中文错误文案，可直接展示。 */
  error: string | null
  /**
   * 当前正在做什么，一句大白话（如「正在安装 numpy」）。主要服务
   * `preparing-python` 阶段——建 venv + pip 装 18 个包要几分钟，只给一条
   * 无限循环的进度条，用户无法判断是在正常推进还是已经卡死。
   */
  detail: string
  /**
   * bootstrap 脚本的原始输出尾巴（最近若干行），供 UI 折叠展示。
   *
   * 为什么要保留原始行而不只给映射后的 detail：pip 的失败信息千奇百怪
   * （网络超时、无 wheel 退化源码编译、缺系统库），映射表不可能穷举；
   * 出问题时这几行原文才是能拿去搜索/求助的东西。
   */
  logTail: string[]
}

export const initialPptSkillStatus: PptSkillStatus = {
  phase: 'idle',
  done: 0,
  total: 0,
  installedVersion: null,
  error: null,
  detail: '',
  logTail: []
}

/** UI 折叠区展示的行数上限；main 侧按这个数截断后再广播，别把整份日志搬过去。 */
export const PPT_SKILL_LOG_TAIL_LINES = 8

/**
 * 把 bootstrap 脚本 / pip 的一行输出翻译成给普通用户看的一句话。
 * 认不出的行返回 null——调用方保留上一句 detail，不要让文案在
 * 「正在安装 numpy」和一行看不懂的英文之间反复横跳。
 *
 * 放在 shared 而不是 main：这套映射是产品文案，将来若要在别处（如设置页的
 * 组件管理）复用同一份说法，不该再抄一遍。
 */
export function describePptBootstrapLine(line: string): string | null {
  const s = line.trim()
  if (s.length === 0) return null

  // ① 脚本自己的里程碑行（`[ppt-creator] …`）
  if (s.includes('建 venv')) return '正在创建 Python 环境…'
  if (s.includes('安装依赖')) return '正在安装依赖包…'
  if (s.includes('尝试镜像源')) return '正在连接镜像源…'
  if (s.includes('尝试官方源')) return '镜像源不通，正在连接官方源…'
  if (s.includes('换下一个')) return '当前源超时，正在换源重试…'
  if (s.includes('Python 就绪')) return '环境已就绪'

  // ② pip 的进度行——包名是用户唯一能感知的「还剩多少」信号
  const collecting = /^(?:Collecting|Downloading)\s+([\w.-]+)/.exec(s)
  if (collecting) return `正在获取 ${collecting[1]}…`
  if (/^Building wheel/.test(s)) return '正在编译组件（这一步较慢）…'
  if (/^Installing collected packages/.test(s)) return '正在写入依赖…'
  if (/^Successfully installed/.test(s)) return '依赖安装完成'

  return null
}

/** 是否可以放行 PPT 功能。只有真正三段都完成才算。 */
export function isPptSkillReady(s: PptSkillStatus): boolean {
  return s.phase === 'ready'
}

/** 是否正在忙（UI 据此显示进度层而不是「开始下载」按钮）。 */
export function isPptSkillBusy(s: PptSkillStatus): boolean {
  return s.phase === 'checking' || s.phase === 'downloading' || s.phase === 'extracting' || s.phase === 'preparing-python'
}
