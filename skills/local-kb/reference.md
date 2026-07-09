# local-kb 参考细节

正常「添加文件 / 查询」流程按 `SKILL.md` 走即可，本文件是排查或调整时的明细，按需读。

## 知识库就是两份 json（文档 + 图片）

- 文档索引 = `<KB_DIR>/KB-INDEX.json`；图片索引 = `<KB_DIR>/KB-IMAGE-INDEX.json`；
  `<KB_DIR>` = `~/.cowork`（用户主目录下的隐藏目录）。按扩展名分流（图片 =
  png/jpg/jpeg/gif/webp/bmp/heic/svg），两份 schema 完全相同。
- 没有"库根文件夹"、没有向量——就两份结构化索引（schema 与类别集合见 SKILL.md）。
- 加文件 = 往对应索引 upsert 一条 entry（path 为主键，已存在则替换）。查文件 = 按查询
  语义选索引读（问截图/图片读图片索引；不明确就两份都读）。
- **另一个写手**：桌面应用「更新知识库」按钮（文档识别/图片识别页各一个）会全量重扫授权
  目录、按文件名重新归类后整份重写（保留你写的 summary、重算 category）。所以写回必须
  是严格合法 JSON。

## kbpath.mjs

**调用：** `node scripts/kbpath.mjs`（打包自带的 node，无需 bun）。
**输出：** 一段 JSON：`kbDir`（知识库目录）、`indexPath`（文档索引）、`imageIndexPath`
（图片索引）、`categoriesPath`（文档类别）、`imageCategoriesPath`（图片类别；类别文件
可能不存在——用 SKILL.md 对应域默认清单）。
脚本会顺便 `mkdir -p` 出 kbDir，所以拿到路径后可直接写索引。
**前置：** 依赖 main 侧注入的环境变量 `CLAUDE_DESKTOP_KB_DIR`。在桌面应用内运行时一定有；
env 缺失会报错退出（好过打印错误路径把索引写到奇怪地方）。

## 各类文件怎么提取内容写概览

| 类型 | 怎么读 |
|---|---|
| txt / md / 代码 / json / csv / yaml 等文本 | 直接 `Read` |
| **图片（png/jpg/gif/webp 等）** | 直接 `Read`——Read 工具读图返回图像内容，你**看得到画面**，据画面写概览（什么应用的界面截图 / 拍了什么 / 图表展示什么） |
| **xlsx（Excel）** | 两处都取：`unzip -p "<文件>" xl/sharedStrings.xml 2>/dev/null`（共享字符串，可能不存在）+ `unzip -p "<文件>" xl/worksheets/sheet1.xml`（内联字符串在这）。`<t>` 标签＝单元格文本。**别 `require('xlsx')`**——它是前端 devDep，打包后用户机器没有 |
| docx / pptx | 同理是 zip+xml：`unzip -p "<文件>" word/document.xml`（docx）；文本在 `<w:t>` 标签里。可选支持 |
| pdf / 图片 | 暂不提取内容。可只凭文件名写保守概览，并注明"未读取内容" |

**为什么 xlsx 用 unzip 而不是 xlsx 包**：`xlsx`（SheetJS）在 `apps/studio/package.json` 里是
`devDependencies`（被前端 bundle 动态 import），不会作为独立包出现在用户安装包的
node_modules 里——skill 脚本 `require('xlsx')` 在打包后会失败。`unzip` 是 macOS/多数系统
自带的命令，零依赖、一定在。xlsx/docx/pptx 本质都是 zip，这条路对三者通用。

## 概览写作要点

- 一句话，抓"内容是什么"，不是"这是什么格式的文件"。
- 保留关键实体（人名/公司/项目/模块/列名/结论）——这些是用户查询时会用的检索词。
- 表格：写它记录什么维度的数据（有哪些列、什么主题），不是"一个 xlsx 文件"。
- 代码：写模块职责（"处理支付回调的路由"）。
- 文档：写主题与结论。

## KB-INDEX.json 示例

```json
{
  "version": 1,
  "updatedAt": 1720500000000,
  "entries": [
    {
      "path": "/Users/me/Desktop/示例表格/员工信息示例.xlsx",
      "name": "员工信息示例.xlsx",
      "ext": "xlsx",
      "category": "数据报表",
      "summary": "员工信息表：姓名/工号/部门/入职日期等基础字段",
      "size": 0,
      "mtimeMs": 0,
      "indexedAt": 1720500000000
    },
    {
      "path": "/Users/me/资料/合同/云续约.pdf",
      "name": "云续约.pdf",
      "ext": "pdf",
      "category": "合同协议",
      "summary": "与某云厂商三年续约，含 SLA 赔偿条款",
      "size": 0,
      "mtimeMs": 0,
      "indexedAt": 1720500000000
    }
  ]
}
```
