---
name: doc-convert
description: "Use this skill when a user requests to convert between document formats — Markdown to Word, Word to PDF, Excel to/from CSV, or PDF page operations (merge, split, delete pages, watermark). 文档处理：格式转换、PDF 页面操作。"
---

# 文档处理（Document Convert）

用户丢进一份文件、想要另一种格式时用这个技能。当前覆盖四类**确定性转换**——
每一类都有专用脚本，**一律调脚本，不要自己现写 Python**。脚本里已经处理了
中文编码、页码换算、字体缺失等一堆坑，现写必然踩回去。

## 运行环境（先读这一段）

所有 Python 工作走本技能专属 venv。每个会话开始时引导一次：

```bash
# macOS / Linux —— 必须用 `source`（脚本要把 $DOC_CONVERT_PY 导回你的 shell）
source ${SKILL_DIR}/bin/ensure-python.sh
"$DOC_CONVERT_PY" -c "import pypdf, docx, openpyxl, reportlab; print('ok')"
```

> **Windows**：改跑 `${SKILL_DIR}\bin\ensure-python.cmd`，它末行打印
> `DOC_CONVERT_PY=<path>`，后续所有 python 命令用那个路径。

- 首次运行要下载依赖（约几分钟），之后靠哨兵文件秒过。**开始前告诉用户这次要等**。
- skill 目录在打包后的 app 里是**只读**的。永远不要往 `${SKILL_DIR}` 里写东西，
  也不要往自带 runtime 里 pip install。所有产物写到会话工作目录。

## 四条能力与对应脚本

### 1. Markdown → Word

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/md_to_docx.py 输入.md -o 输出.docx
```

支持 Markdown 常用子集（标题 / 段落 / 有序无序列表 / 粗斜体 / 行内代码 /
围栏代码块 / 分隔线）。**不支持表格、引用块、图片、链接语法**——遇到这些，
先把它们改写成受支持的形式再转，不要指望脚本处理。

### 2. Word → PDF

```bash
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/docx_to_pdf.py 输入.docx -o 输出.pdf
```

⛔ **这条有一道必须遵守的门禁。** 本机装了 LibreOffice 才能保留排版；没装时
脚本会**报错退出**，而不是悄悄降级。

收到这个报错时：**先把情况告诉用户，让他选，不要自作主张加 `--allow-textonly`。**
原话大意——

> 你电脑上没装 LibreOffice，我没法保留原来的排版。两个选择：
> ① 装一下 LibreOffice（免费）再转，排版能保住；
> ② 我直接转成纯文字版 PDF，但**表格、图片和所有排版都会丢**。
> 你要哪个？

用户明确选了②，才加 `--allow-textonly` 重跑。
用户没回答之前不要转。理由：纯文字版 PDF 看起来是个正常 PDF，用户很可能直接
拿去用（发客户、投标），发现丢了表格时已经晚了。

即便用户选了②走纯文字兜底，**这条路自己还有两道独立的拒绝**（见下面
「脚本会拒绝干活的几种情况」）：文档里提不出任何文字、或本机连中文字体都
找不到，两种情况脚本都不产出文件，不会给你一份空白 / 满纸方块的 PDF。

### 3. Excel ↔ CSV

```bash
# 方向按输入扩展名自动判定
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/excel_csv.py 输入.xlsx -o 输出.csv
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/excel_csv.py 输入.csv  -o 输出.xlsx
```

源文件有**多张工作表**时脚本会报错并列出表名，要求指定 `--sheet 表名`
（`--sheet` 只对 xlsx→csv 方向有意义）。这时问用户要哪一张，或者按他的需求
循环导出多次——**不要随便挑第一张**，那等于让用户丢数据还不知道。

导出的 CSV 带 UTF-8 BOM，Excel 双击打开中文不乱码。这是刻意的，别去掉。

⚠️ **csv → xlsx 方向有个用户容易误以为"转错了"的坑，转完必须主动提醒：**
脚本是按文本逐行读 CSV 再写进单元格的，所以转出来的 xlsx 里，**看起来是
数字的内容其实是文本格式**，不是真正的数值。用户如果直接拿这份表做
`=SUM(...)` 之类的求和公式会算出 0 或报错，Excel 还会在这些单元格左上角
标一个绿色小三角提示"数字以文本形式存储"。这不是转换出错，但用户十有八九
会以为是。**转完主动告诉用户**，别等他自己发现再来问。原话大意——

> 转好了，不过这份 xlsx 里的数字是按文本格式存的，直接用公式求和会算不出来。
> 如果你需要用它做计算，在 Excel 里选中那些列 → 右键设置单元格格式改成
> "数值"（或者用"数据"里的"分列"功能）就能转回真正的数字。

### 4. PDF 页面操作

```bash
# 合并（按给定顺序）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py merge a.pdf b.pdf -o 合并.pdf

# 拆分：一页一个文件
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py split 输入.pdf -d 输出目录/

# 拆分：按区间，每个区间一个文件
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py split 输入.pdf -d 输出目录/ --ranges "1-3,4-8"

# 删页
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py delete 输入.pdf -o 输出.pdf --pages "2,5-7"

# 加水印（水印是另一份 PDF 的第一页）
"$DOC_CONVERT_PY" ${SKILL_DIR}/scripts/pdf_ops.py watermark 输入.pdf -o 输出.pdf --stamp 水印.pdf
```

**页码一律 1 起、闭区间**，和用户嘴里说的一致（"删第 3 页"就是 `--pages 3`）。
越界会报错并告诉你总页数，不会静默截断。

#### 水印页从哪来

`watermark` 子命令只负责"叠加"，不负责"画"——它要的 `--stamp` 是一份**现成的**
水印 PDF。但用户说的是"给这份 PDF 加个'机密'水印"，他手上通常没有这份文件。

**这是本技能允许你自己现写 Python 的唯一例外**（开头"一律调脚本"的规矩在这里
不适用）：水印文字、字号、透明度、旋转角度因人而异，没法预先做成一个参数化脚本
覆盖所有情况，所以由你现场用 reportlab 画一页，再交给 `pdf_ops.py watermark` 去叠。

⚠️ **画水印页必须先注册中文字体**，否则中文会渲染成方块——这正是
`docx_to_pdf.py` 顶部注释警告过的坑。不要自己重新摸索找字体的逻辑，直接复用
`docx_to_pdf.py` 里现成的 `find_cjk_font()`（venv 里 reportlab 已装，两个脚本
同一个 venv）：

```python
import sys
sys.path.insert(0, "${SKILL_DIR}/scripts")
from docx_to_pdf import find_cjk_font

from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

font_path = find_cjk_font()
if font_path is None:
    # 找不到中文字体时不要硬画——中文会变方块，比没有水印更糟。
    # 告诉用户本机缺中文字体，建议装 LibreOffice 或换一台有中文字体的机器。
    raise SystemExit("本机找不到中文字体，拒绝生成水印页")

FONT_NAME = "WatermarkCJK"
# .ttc 是字体集合，注册时要指定取第几个；我们要的都是第一个，直接传 0。
# .ttf 是单个字体，不用传这个参数。
if font_path.suffix.lower() == ".ttc":
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(font_path), subfontIndex=0))
else:
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(font_path)))

c = canvas.Canvas("水印.pdf", pagesize=A4)
c.setFont(FONT_NAME, 60)
c.setFillColorRGB(0.6, 0.6, 0.6, alpha=0.4)
c.saveState()
c.translate(A4[0] / 2, A4[1] / 2)
c.rotate(45)
c.drawCentredString(0, 0, "机密")
c.restoreState()
c.save()
```

生成好「水印.pdf」后，正常走上面的 `pdf_ops.py watermark ... --stamp 水印.pdf`
命令去叠加，不要自己写叠加逻辑——叠加涉及页面坐标系合并，`pdf_ops.py` 已经踩过
pypdf 弃用接口的坑（见脚本内注释），现写大概率踩回去。

## 脚本会拒绝干活的几种情况

四个脚本都在评审后加了一批**主动拒绝**的护栏——遇到下面这些情况，脚本会
报错退出、**不产出文件**（不会给你一份空的 / 错的 / 半成品文件）。这些不是
bug，是刻意设计：宁可让你知道哪里出了问题，也不悄悄生成一份看起来正常、
实际有缺陷的文件让用户带着走。遇到了照着「怎么办」处理，**不要瞎试别的
参数或换脚本绕过去**。

| 情况 | 触发脚本 | 脚本怎么反应 | agent 该怎么办 |
| --- | --- | --- | --- |
| PDF 有密码保护 | `pdf_ops.py` 四个子命令（merge/split/delete/watermark） | 报错退出，提示文件被密码保护 | 告诉用户"这份 PDF 有密码保护，请先用阅读器去掉密码再试"。**不要试图猜密码或换别的脚本绕过** |
| 水印源 PDF 是 0 页 | `pdf_ops.py watermark` | 报错退出 | 告诉用户水印文件是空的，换一份有内容的水印 PDF |
| `merge` 传空输入列表 | `pdf_ops.py merge` | 报错退出（不会生成空 PDF） | 确认要合并的文件列表，至少给一个 |
| PDF 页码越界 | `pdf_ops.py`（split --ranges / delete） | 报错并告诉你该文件总页数 | 据此改正页码重试，拿不准就问用户 |
| 删页删到一页不剩 | `pdf_ops.py delete` | 拒绝生成空 PDF | 告诉用户删除范围覆盖了全部页，让他确认想删哪几页 |
| Excel 源文件有多张工作表但没指定 `--sheet` | `excel_csv.py`（xlsx→csv 方向） | 报错并列出所有工作表名 | 问用户要哪一张，或按需求循环导出多次。**不要随便挑第一张** |
| Excel 源文件是 `.xls`（旧的二进制格式） | `excel_csv.py` | 报错退出，提示这是旧格式 | 告诉用户"请先在 Excel 里另存为 .xlsx 再试" |
| Excel 工作表一行数据都没有 | `excel_csv.py`（xlsx→csv 方向） | 拒绝生成 0 字节 CSV | 告诉用户这张表是空的，确认是不是选错了工作表 |
| Word 文档里没有可提取的文字（含只有空段落的情况） | `docx_to_pdf.py`（无 LibreOffice 的兜底路径） | 拒绝生成，不产出空白 PDF | 告诉用户这份 Word 文档提不出文字内容，请确认文件是否正确 |
| 本机找不到任何中文字体 | `docx_to_pdf.py`（无 LibreOffice 的兜底路径） | 拒绝输出（满纸方块的 PDF 比没有更糟） | 告诉用户本机缺中文字体，建议装 LibreOffice 走保排版路径 |

统一强调一条：**这些错误信息都是写给用户看的中文，原样转达比你重新组织
语言有用。**

## 通用纪律

- **产物路径**：默认写到会话工作目录，文件名用中文描述性名字（`季度汇报.pdf`
  好过 `output.pdf`），转完把完整路径告诉用户。
- **不要吞掉脚本的报错**。上面每个脚本的错误信息都写得很具体（缺什么、
  装什么能解决、怎么强行继续），原样转达给用户比你重新组织语言有用。
- **超出这四条的需求**（PDF 转 Word、图片提取文字、PDF 表格转 Excel……）
  不属于本技能当前范围，如实告诉用户做不了，不要用现写脚本硬凑。
