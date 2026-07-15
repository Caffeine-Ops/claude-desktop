# 技术方案 · 通用骨架〔通用款·待真实样本升级〕

> ⚠️ **通用款**：本卡按行业通用套路搭，**尚无真实样本提炼**。有了真实技术方案样本请据此升级本卡。

**类型定位**：偏工程/实现，给客户**技术侧**看——讲清系统怎么建、技术怎么选、如何部署与保障。
比售前建设方案更硬核、更少营销叙事。

## 章节顺序 + 调用的 section 卡

- **封面** → `sections/cover.md`
- **一、项目概述 / 需求理解**：项目背景、需求分析、建设目标（部分复用 `overview/background.md`、`overview/positioning.md`）
- **二、总体技术架构**（本方案重心）
  - 总体架构说明 + 架构图 → `sections/architecture/overall-architecture.md`
  - 系统功能架构 → `sections/architecture/functional-architecture.md`
  - 技术选型 / 关键技术 → `sections/architecture/key-tech.md`
  - 技术路线 → `sections/architecture/tech-roadmap.md`
- **三、详细设计**
  - 功能模块设计 → `sections/features/`（各形态卡）
  - 接口 / 集成设计 → `sections/features/integration.md`
  - 数据 / 安全 / 性能设计（视素材；无据标缺料）
- **四、部署与实施**
  - 部署架构（mermaid 拓扑图）
  - 实施计划 → `sections/delivery/implementation-plan.md`
  - 运维 / 售后保障 → `sections/delivery/after-sales.md`

## 行业适配提示（内联，无样本时的常识，不替代素材）

- 政务：强调等保合规、信创/国产化、数据不出域——但具体级别/清单只能来自素材，无据标缺料。
- 金融：强调高可用、灾备、审计留痕、监管合规。
- 医疗：强调院内系统对接（HIS/EMR）、数据脱敏、电子病历回写。
- 制造/能源：强调边缘部署、OT/IT 融合、稳定性。

## 写法要点

- 技术方案更依赖 mermaid 结构图（架构/时序/部署拓扑/数据流）——见 `images-and-figures.md`。
- 技术选型、性能指标等结构化内容用表格 → `methodology/tables.md`；指标类必须有素材出处，不编。
- 受众是技术评委，语气偏严谨、少营销词。
