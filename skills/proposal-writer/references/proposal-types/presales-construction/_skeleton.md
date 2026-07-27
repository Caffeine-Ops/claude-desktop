# 售前建设方案 · 通用骨架

**类型定位**：给某单位建设一套系统的售前方案，核心是"讲清建什么、为什么建、怎么建、建成什么样、带来什么价值"。
交付给客户决策层 + 技术评审。图文并茂是硬要求。

## 章节顺序 + 调用的 section 卡

按此顺序组织（层级适度，一般到二~三级；"系统功能"章可下探到功能点）：

- **封面** → `sections/cover.md`
- **一、系统功能概述**（讲"是什么、为谁、为什么"）
  - 建设背景 → `sections/overview/background.md`
  - 系统定位 → `sections/overview/positioning.md`
  - 产品总体概述 → `sections/overview/product-summary.md`
  - 系统总体目标（分受众视角）→ `sections/overview/goals-by-audience.md`
  - 系统业务范围 → `sections/overview/business-scope.md`
  - 系统应用入口 → `sections/overview/entry-points.md`
  - 系统建设价值（分价值点）→ `sections/overview/value.md`
  - 系统总体成效 → `sections/overview/outcomes.md`
- **二、系统功能架构**（讲"怎么搭"）
  - 总体架构说明 + 总体架构图 → `sections/architecture/overall-architecture.md`
  - 业务闭环架构 → `sections/architecture/business-loop.md`
  - 系统功能架构 → `sections/architecture/functional-architecture.md`
  - AI 能力架构 → `sections/architecture/ai-capability.md`
  - 关键技术说明 → `sections/architecture/key-tech.md`
  - 系统技术路线 → `sections/architecture/tech-roadmap.md`
  - 系统总体特点 → `sections/architecture/system-traits.md`
- **三、系统功能**（讲"有哪些功能"，重点章、最详）
  - 按业务域分组，每域下叶子功能用 `sections/features/` 对应形态卡：
    输入类/对话类/推荐类/接入集成类/报告生成类/统计分析类/后台管理类。先读 `features/_pattern-guide.md`。
- **四、实施与保障**（可选，视素材）
  - 实施计划 → `sections/delivery/implementation-plan.md`
  - 售后服务 → `sections/delivery/after-sales.md`

## 用法

- 素材支持哪些章就写哪些，不硬凑；某章事实不足就精简或标缺料，别编。
- 有真实行业变体的（目前只有医疗 `healthcare.md`）优先读变体；其它行业先用本通用骨架 + 行业适配常识（但事实仍只来自素材）。
- 详略见 `methodology/emphasis-and-depth.md`：概述/架构标准展开，"系统功能"重点详写。
