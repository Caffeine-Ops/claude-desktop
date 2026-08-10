import type { ScenarioCatalog, ScenarioCatalogPrompt } from '@desktop-shared/ipc-channels'

/**
 * 空态场景导航的**内置默认目录**（2026-07-29 从 ScenarioRail.tsx 的
 * `CATEGORIES` + `PROMPTS_BY_SKILL` 原样搬出，内容一字未改）。
 *
 * 为什么要有这份内置表，明明后台会下发：
 *
 *   - **未登录用户看到的就是它**。远端目录走 `GET /api/v1/client/scenario-catalog`，
 *     是登录后才拉的用户态接口；空态 rail 在登录前就要能用。
 *   - **离线 / 首次安装 / 拉取失败时的兜底**。远端那份是缓存在 userData 里的，
 *     全新安装的机器上还没有。
 *   - **它同时是「远端配置写坏了」的安全网**：main 侧 normalize 整份拒收时
 *     （见 scenarioCatalogService.ts），渲染层回落到这里，用户看到的仍是一个
 *     完整可用的空态，而不是一片空白。
 *
 * 所以这份表**必须继续维护**，不能因为「反正后台会配」就让它烂掉。改内置
 * 文案与改后台配置是两件事：这里管的是「所有人的默认体验」，后台管的是
 * 「不发版就能调整」。
 *
 * 与远端格式完全同构（就是 ScenarioCatalog），渲染层因此只需要认一种形状。
 * 内置条目刻意**不写 label/icon**——它们回落 `skillChipRegistry` 里那份注册，
 * 那才是「技能长什么样」的唯一事实源，在这里重复一遍迟早漂移。同理分类不写
 * label，由渲染层按 id 回落 i18n（`scenarioCat*`）。
 */

const PPT_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: 'AI 发展历程 PPT',
    text: '请生成一个 AI 人工智能发展历程的 PPT，从图灵测试讲到大语言模型，每页一个里程碑，配时间轴。'
  },
  {
    // 修改现有文件：【PPT 文件】是 filePlaceholderPlugin 的文件槽（点击
    // 选文件换成 mention chip）；直接拖 pptx 进输入框同样以 @"path" chip
    // 混排进正文。文案刻意不带「拖入/点击」动作词（用户拍板 2026-07-16）
    // ——槽自己的虚线 pill 形态已表达「这里放文件」。
    label: '修改PPT文件',
    text: '帮我修改【PPT 文件】：【说明要改什么，例如换主题色、更新第 3 页数据、统一字体】，其余保持原样。'
  },
  {
    label: '季度业务汇报',
    text: '帮我生成一套季度业务汇报 PPT，包含业绩回顾、关键项目、问题与风险、下季度规划四个章节。'
  },
  {
    label: '产品介绍页',
    text: '为【产品名称】做一份 10 页以内的产品介绍 PPT，突出核心卖点和客户案例。'
  },
  {
    label: '选用现成模版',
    text: '帮我用【选择模版】做【PPT主题】的PPT。'
  },
  {
    label: '用我的PPT模版',
    text: '帮我用【PPT 模版文件】的版式做一份新PPT，内容是【说明主题和要点】，设计风格保持不变。'
  }
]

const SPREADSHEETS_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 「【…文件】」结尾 = filePlaceholderPlugin 的文件槽（点击选文件）。
    label: 'Excel 数据清洗',
    text: '帮我清洗【Excel 文件】：去重、补全缺失值、统一日期与金额格式，输出干净的新表并说明改动。'
  },
  {
    label: '销售数据透视',
    text: '基于【Excel 文件】生成透视汇总：按月份和区域统计销售额，标出环比变化最大的三项。'
  },
  {
    label: '发票台账整理',
    text: '把【发票信息】批量整理成 Excel 台账，包含日期、金额、税率、销售方，最后输出汇总合计。'
  },
  {
    label: '可视化表格',
    text: '把【Excel 文件】里的数据做成图表：自动挑选合适的图表类型（柱状/折线/饼图），配好标题、图例和数据标签。'
  },
  {
    label: '智能分析',
    text: '帮我分析【Excel 文件】：找出关键趋势、异常波动和相关性，用一页摘要给出结论和建议。'
  },
  {
    label: '表格生成PPT',
    text: '把【Excel 文件】里的数据整理成一套汇报 PPT：关键指标做成图表页，最后一页给出结论与建议。'
  },
  {
    label: '表格美化',
    text: '帮我美化【Excel 文件】的排版：统一字体、配色、边框和列宽，重点数据用条件格式高亮，不改动数据本身。'
  },
  {
    label: '会计统计',
    text: '基于【记账明细文件】做会计统计：按科目汇总收支，生成月度损益表和往来账龄分析。'
  },
  {
    label: '财务预算表',
    text: '帮我做一份【部门/项目】年度预算表：按科目列支出计划，自动汇总总额与分月分布。'
  },
  {
    label: '库存统计',
    text: '基于【库存明细文件】统计出入库：按商品汇总期初、入库、出库、期末结存，标出库存预警项。'
  },
  {
    label: '考勤统计',
    text: '基于【考勤记录文件】统计出勤：按人员汇总出勤、迟到、请假天数，生成月度考勤汇总表。'
  },
  {
    label: '进度跟踪表',
    text: '帮我做一份【项目名称】进度跟踪表：任务、负责人、起止时间、完成率，用条件格式标出延期项。'
  },
  {
    label: '数据对比分析',
    text: '基于【Excel 文件】做多期对比：把本期和上期数据放在一起，算出差值和增长率，标出变动最大的项。'
  },
  {
    label: '排班表',
    text: '帮我做一份【团队/门店】排班表：覆盖一整月，自动避开同一人连续排班冲突，统计每人总班次。'
  }
]

const PROPOSAL_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: '项目投标方案',
    text: '给【客户名称】写一份项目投标方案，包含需求理解、技术方案、实施计划、报价构成四部分。'
  },
  {
    label: '产品需求文档',
    text: '把【功能想法】整理成一份 PRD，包含背景、目标用户、功能清单、验收标准。'
  },
  {
    label: '活动策划案',
    text: '帮我写一份【活动主题】的策划方案，覆盖目标、流程安排、物料清单和预算。'
  }
]

const TENDER_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 「【招标文件】」是 filePlaceholderPlugin 的文件槽（「招标」关键词 →
    // picker 限定 .pdf/.doc/.docx，见 ACCEPT_BY_KEYWORD 表首那条）。四条
    // prompt 刻意从「全量」到「单项」递进：第一条是主路径，后三条对应技能
    // 内部三条独立的判断线，让已经知道自己要查什么的老手直接切进去。
    label: '完整审标',
    text: '帮我审这份【招标文件】：把废标项、评分项、要准备的证明材料、▲ 标识参数、时间节点和合同条款要点全部列出来，每条带原文出处，最后出一份 Excel 核对清单。'
  },
  {
    label: '只看废标点',
    text: '帮我看这份【招标文件】里所有会导致废标的条款：资格门槛、实质性要求、投标文件递交规格（形式/份数/封装），每条带原文出处，一条都别漏。'
  },
  {
    label: '只看评分项',
    text: '帮我梳理这份【招标文件】的评分规则：价格分怎么算、商务分和技术分各有哪些得分点、每项多少分、要提交什么才能拿到分，每条带原文出处。'
  },
  {
    // 合同条款是「中标后约束」，与废标项（递交时雷区）是两类独立清单——
    // 很多投标人不看合同，单独给一条入口让想看的人直达。
    label: '合同条款要点',
    text: '帮我看这份【招标文件】里的合同条款：付款方式、质保期、违约责任、验收标准这些中标后才生效的约束，每条带原文出处。'
  }
]

const DOC_CONVERT_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 「【Markdown 文件】」命中 filePlaceholderPlugin 的 markdown 规则
    // → picker 限定 .md/.markdown。
    label: 'Markdown 转 Word',
    text: '把【Markdown 文件】转成 Word 文档，标题层级、列表和加粗都保留。'
  },
  {
    // 「【Word 文件】」命中 word 规则 → .doc/.docx。文案刻意提一句排版，
    // 因为这条在没装 LibreOffice 的机器上会走「先问用户」的门禁分支
    // （见 SKILL.md §2），提前把预期立在这里。
    label: 'Word 转 PDF',
    text: '把【Word 文件】转成 PDF，尽量保留原排版。'
  },
  {
    // 「【Excel 文件】」命中 excel 规则 → .xls/.xlsx/.csv，双向都能选。
    label: 'Excel 与 CSV 互转',
    text: '把【Excel 文件】转成另一种格式（xlsx 转 csv 或 csv 转 xlsx），中文不要乱码。'
  },
  {
    // 合并/拆分共用一条入口：用户嘴里说的都是「拆开/合起来」，
    // 具体怎么拆由对话里问清楚，不在这里拆成两个按钮稀释列表。
    label: 'PDF 合并拆分',
    text: '帮我处理【PDF 文件】：【说明要做什么，例如和另一份合并、按章节拆成多个文件、删掉第 2 和第 5 页、加个水印】。'
  }
]

const IMAGEGEN_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    // 【图片文件】是 filePlaceholderPlugin 的文件槽（「图片」关键词 →
    // 选择器限定 image/*）；选完/拖入后点 chip 还能开右栏图片编辑面板。
    label: '编辑修改图片',
    text: '帮我修改【图片文件】：【说明要改什么，例如去掉背景、调整色调、加一行文字】，其余保持原样。'
  },
  {
    // 融合＝多图合一，所以放两个文件槽（都含「图片」关键词 → 都限定
    // image/*，见 filePlaceholderPlugin 的 ACCEPT_BY_KEYWORD）；用户也可
    // 以直接拖多张图进输入框，两条路都汇进同一次生成。
    label: '融合图片',
    text: '把【图片文件】和【另一张图片文件】融合成一张：【说明想要的效果，例如把人物放进这个背景、两张图的元素合成一幅、统一整体光影风格】，输出一张自然协调的合成图。'
  },
  {
    label: '活动海报',
    text: '为【活动主题】生成一张竖版活动海报，主视觉醒目，留出时间地点文字区域。'
  },
  {
    label: '公众号头图',
    text: '生成一张公众号头图，主题是【文章主题】，简洁大气，宽幅横版构图。'
  },
  {
    label: '产品示意图',
    text: '为【产品/功能】生成一张干净的概念示意图，白底，适合放进 PPT。'
  }
]

const REMOTION_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: '产品宣传短片',
    text: '根据【产品介绍】生成一支 30 秒左右的产品宣传短视频，节奏明快，结尾带行动号召。'
  },
  {
    label: '数据动画',
    text: '把【这组数据】做成一段动态图表短视频，逐项展示增长趋势。'
  }
]

const WRITING_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: '公众号文案',
    text: '帮我写一篇公众号文案，主题是【主题】，目标读者是【读者画像】，希望读者读完【去做什么】。'
  },
  {
    label: '短篇小说',
    text: '帮我写一篇短篇小说，题材是【悬疑/言情/科幻/脑洞/治愈/搞笑】，核心设定是【一句话设定】，我希望读者读完的感觉是【意难平/反转震撼/爽感/治愈/细思极恐】。'
  },
  {
    label: '干货 / 观点长文',
    text: '帮我写一篇文章，主题是【主题】，我的核心观点是【一句话观点】，发在【平台】给【读者】看。'
  },
  {
    // 职场实用写作走 workflows/workplace-writing.md：轻量快道，从零写周报 /
    // 邮件 / 道歉 / 发言稿等。与三体裁创作同为「从零写」，故紧邻创作类之后、
    // 处理已有文字类（优化改写 / 去 AI 味 / 学文风）之前。细分文体不露按钮，
    // 由工作流追问。
    label: '职场文档',
    text: '帮我写一份职场文档，类型是【周报/述职/邮件/道歉信/通知/发言稿】，写给【谁·什么关系】，要达成【一句话目的】，关键信息是【必须写进去的事实】。'
  },
  {
    // 「优化 / 改写」是「处理我已有的文字」簇的合并主入口（2026-07-29 用户
    // 要求：改写 + 体检优化本质同类，合成一个，点进去再分方向）。【文稿文件】
    // 是 filePlaceholderPlugin 的文件槽（「文稿」关键词 → picker 限定
    // txt/md/markdown/docx/pdf，见 acceptForPlaceholder 的文稿组合映射）。
    // prompt 收进原两条的行为：没给方向 → 走 optimize-existing.md 先五维体检、
    // 分档、确认修改强度（末句「确认前不改正文」是其 ⛔ BLOCKING 硬门在 UI 侧
    // 的对齐）；给了方向 → 走 rewrite.md 直接按方向改。底层两个工作流不动，
    // 仅合并 UI 入口。
    label: '优化 / 改写',
    text: '帮我优化或改写【文稿文件】。如果我没说方向，先检查内容、结构、表达、文风和 AI 痕迹，告诉我主要问题，并推荐轻度润色、标准优化或深度改写，在我确认修改强度前不要改正文；如果我明确说了方向（比如更口语、压到 800 字、换成小红书风格），就直接按方向改写。'
  },
  {
    // 去AI化走 workflows/de-ai.md：轻量快道，只擦 AI 痕迹、保留原意与结构
    // （不提质、不改结构，那是「优化 / 改写」的活）。贴文字即走，属处理已有
    // 文字类，紧邻其后。
    label: '去 AI 味',
    text: '帮我把下面这段文字去AI化，只擦掉 AI 痕迹、保留原意和结构：\n\n【粘贴原文】'
  },
  {
    label: '学我的文风',
    text: '读一下【我的往期文章文件或目录】，分析我的写作风格，生成一份文风档案，以后写东西都按这个风格来。'
  }
]

const DAILY_DEV_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: '新增功能开发',
    text: '在【项目/模块】里新增【功能描述】：先说明改动方案，确认后实现并跑通类型检查。'
  },
  {
    label: '代码重构优化',
    text: '重构【目标文件/模块】：按职责拆分、消除重复，保持对外接口不变，改完列出改动清单。'
  },
  {
    label: '修复Bug',
    text: '这个 bug 的表现是：【现象描述】。帮我定位根因并修复，附上验证方式。'
  },
  {
    label: '性能优化',
    text: '分析【页面/接口】的性能瓶颈，量化每个热点的开销，按收益排序逐个优化。'
  },
  {
    label: '补充单元测试',
    text: '为【模块/函数】补充单元测试，覆盖正常路径、边界条件和报错分支。'
  },
  {
    label: '排查报错修复',
    text: '这是报错信息：【粘贴报错】。帮我定位到源码位置，解释原因并修复。'
  }
]

const WEB_DEV_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: '企业官网开发',
    text: '帮我搭一个企业官网：首页 + 产品介绍 + 关于我们 + 联系方式，响应式布局，先出首页。'
  },
  {
    label: '后台管理系统',
    text: '初始化一个后台管理系统：登录、侧边导航、数据表格增删改查，用【技术栈】。'
  },
  {
    label: '个人博客网站',
    text: '帮我做一个个人博客网站：文章列表、详情页、标签分类，支持 Markdown 写作。'
  },
  {
    label: '电商首页开发',
    text: '开发一个电商首页：轮播 banner、商品分类栅格、推荐位，移动端优先。'
  }
]

const AGENT_APP_PROMPTS: readonly ScenarioCatalogPrompt[] = [
  {
    label: 'Agent应用开发',
    text: '帮我开发一个 Agent 应用来解决【要处理的任务】，包含工具调用和多轮对话能力。'
  },
  {
    label: '聊天应用初始化',
    text: '初始化一个 AI 聊天应用：流式回复、会话历史、Markdown 渲染，用【技术栈】。'
  },
  {
    label: '客户端Agent应用',
    text: '做一个桌面端 Agent 应用骨架：本地运行、系统托盘、可调用本地文件与命令。'
  },
  {
    label: '智能客服Agent',
    text: '搭建一个智能客服 Agent：接入【知识库/FAQ】，支持转人工和多轮追问。'
  }
]

export const DEFAULT_SCENARIO_CATALOG: ScenarioCatalog = {
  // 内置表恒为 0：远端目录的 version 由后台维护且从 1 起，永远「更新」，
  // 不会出现远端拉到了却被判定成同一版而不生效。
  version: 0,
  categories: [
    {
      id: 'daily',
      icon: 'coffee',
      items: [
        { kind: 'skill', value: '/cowork:ppt-creator', prompts: PPT_PROMPTS },
        {
          kind: 'skill',
          value: '/claude-desktop:spreadsheets',
          prompts: SPREADSHEETS_PROMPTS
        },
        {
          kind: 'skill',
          value: '/claude-desktop:doc-convert',
          prompts: DOC_CONVERT_PROMPTS
        },
        {
          kind: 'skill',
          value: '/claude-desktop:proposal-writer',
          prompts: PROPOSAL_PROMPTS
        },
        {
          kind: 'skill',
          value: '/claude-desktop:tender-review',
          prompts: TENDER_PROMPTS
        }
      ]
    },
    {
      id: 'code',
      icon: 'code',
      // 代码开发的首层是三个【场景伪命令】（日常开发/网站开发/Agent 应用，
      // 见 lib/scenarioSlash.ts）：点击同技能 chip 一样插黑标签、进二级推荐
      // prompt；发送时 onNew 剥掉伪命令只发正文。
      items: [
        { kind: 'skill', value: '/daily-dev', pseudo: true, prompts: DAILY_DEV_PROMPTS },
        { kind: 'skill', value: '/web-dev', pseudo: true, prompts: WEB_DEV_PROMPTS },
        { kind: 'skill', value: '/agent-app', pseudo: true, prompts: AGENT_APP_PROMPTS }
      ]
    },
    {
      id: 'design',
      icon: 'palette',
      items: [
        { kind: 'skill', value: '/claude-desktop:writing', prompts: WRITING_PROMPTS },
        { kind: 'skill', value: '/claude-desktop:imagegen', prompts: IMAGEGEN_PROMPTS },
        { kind: 'skill', value: '/claude-desktop:remotion', prompts: REMOTION_PROMPTS },
        { kind: 'skill', value: '/cowork:ppt-creator', prompts: PPT_PROMPTS }
      ]
    }
  ]
}
