# writing skill 脚本手册

这些脚本是写作技能的**质检与工程骨架**——把「AI 味」「平台合规」「小说连贯性」这类
判断从「让模型自己拍脑袋」变成**可计算、可复现、带行号**的检测。SKILL.md 的审校阶段
（Step 7）靠它们出客观指标，不靠模型自评。

## 跑之前必做：自举 Python 环境

每条命令都必须跑在本技能自带的虚拟环境里，**不能用系统裸 `python3`**（它可能不存在，
或版本装不上带原生轮子的依赖）。每个会话先自举一次：

```bash
# macOS / Linux
source skills/writing/bin/ensure-python.sh   # 准备 ~/.writing-skill/venv 并 export WRITING_PY
# Windows
skills\writing\bin\ensure-python.cmd          # stdout 末行是 WRITING_PY=<path>
```

之后**把下表命令里的 `python3` 一律换成 `$WRITING_PY`**。venv 落在用户可写的
`~/.writing-skill/venv`，绝不建在 skill 目录里（打包后它在 Electron resources 下只读）。

跑测试：`$WRITING_PY -m pytest skills/writing/tests/ -v`

---

## 主管线脚本（7 个）

| 脚本 | 用途 | 典型命令 | 退出码 |
|---|---|---|---|
| `source_to_md.py` | 素材 → Markdown（纯文本 / PDF / Word / 网页四种来源） | `python3 scripts/source_to_md.py <源> --out-dir <项目>/sources` | `0` 成功；非 `0` 转换失败 |
| `project_manager.py` | 项目初始化 / 校验 / 状态 | `python3 scripts/project_manager.py init <名称> --dir <路径>`<br>`… validate <项目路径>`<br>`… info <项目路径>` | `0` 成功 / 结构完整；`1` 结构有缺（`validate`） |
| `style_profile.py` | 从往期文章提取个人文风档案（频次统计 + 可抄进契约的建议行） | `python3 scripts/style_profile.py <文件或目录> --out <档案.md> [--json]` | `0` 成功；非 `0` 无有效样本 |
| `ai_slop_checker.py` | AI 味五维检测（结构均匀度 / 套话 / AI 句式 / 书面腔 / 具体度，**总分 50，<35 打回**），逐处给行号 | `python3 scripts/ai_slop_checker.py <正文.md> [--spec-lock <契约>] [--json]` | `0` 达标（≥35）；**`1` 打回重写（<35）** |
| `readability_check.py` | 平台合规（段落超长 / 小标题密度 / 总字数区间），以脚本报错为准 | `python3 scripts/readability_check.py <正文.md> [--platform 公众号] [--spec-lock <契约>]` | `0` 全部通过；**`1` 有不合规项** |
| `continuity_check.py` | 小说连贯性（伏笔埋没回收 / 档案人物没登场 / 档案外人名手滑），拿契约当标准答案 | `python3 scripts/continuity_check.py <正文.md> --spec-lock <契约>` | `0` 无问题；**`1` 有待处理项** |
| `export.py` | 导出定稿（公众号内联样式 HTML / 纯文本 / docx） | `python3 scripts/export.py <定稿.md> --format wechat\|plain\|docx [--style wechat-default\|wechat-serif] [--out <路径>]` | `0` 成功；非 `0` 导出失败 |

> ⚠️ `ai_slop_checker` / `readability_check` / `continuity_check` 的退出码 `1` 是
> **业务判定「不达标」**，不是脚本崩溃——审校阶段要读它们的报告正文，别只看退出码。

## 辅助脚本（2 个，不在主管线，按需调用）

| 脚本 | 用途 | 典型命令 | 退出码 |
|---|---|---|---|
| `update_spec.py` | 改写作契约并标出受影响、需回改的已写章节。写作已开始后改字段**必须走它**，别手改契约 | `python3 scripts/update_spec.py <项目路径> --section <段名> --key <字段> --value <新值>` | `0` 成功；非 `0` 段名/字段非法 |
| `validate_library.py` | 校验 `references/` 资源库结构完整。改文风 / 结构 / 题材库后自查用 | `python3 scripts/validate_library.py` | `0` 结构完整；`1` 有缺登记 |

## 共享库（非 CLI）

- `writing_utils.py` —— 切句 / 切段 / 剥 Markdown / 变异系数 / 词表加载 / 契约解析。
  所有质检脚本共用它，**切句规则只有一份**，避免各脚本各切各的、同一段正文在不同报告里句数对不上。

---

## 三条不变量（改脚本前先读）

1. **质检三脚本（`ai_slop_checker` / `readability_check` / `continuity_check`）只用 Python 标准库**，
   不引分词库——依赖越轻越好打包，且中文分词在人名上本来就不准。
2. **阈值是可调常量，测试钉的是行为不是数值**。`ai_slop_checker` 的 `*_FLOOR`/`*_CEIL`
   用真实样本调时，改常量不该动测试（测试钉「AI 腔 < 人话」这类相对关系）。
3. **契约的段名 / 字段名被多个脚本逐字解析**（`update_spec` 认死九个段名，`continuity_check`
   逐字解析人物档案与伏笔表的竖线字段）。改字段名要同步改所有解析处，否则静默失效。
