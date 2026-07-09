// 打印本地知识库目录 <KB_DIR> 与索引文件 KB-INDEX.json 的绝对路径，供 local-kb skill
// 定位「往哪读/往哪写索引」。并确保 <KB_DIR> 存在（mkdir -p），让 agent 后续写索引时
// 目录一定在。
//
// 为什么要这个脚本、路径不能 agent 自己拼：
//   <KB_DIR> = Electron 的 userData/kb-local/。userData 的真实位置由 Electron 按平台
//   算（mac 是 ~/Library/Application Support/<appName>/），skill 脚本是用户机器上的裸
//   node 进程、不在 Electron 里，算不出来。所以 main 侧把它经环境变量 CLAUDE_DESKTOP_KB_DIR
//   注入给 fusion-code 子进程（与 PPT_MASTER_PYTHON_HOME 同套路），本脚本读它。
//
// 为什么是 .mjs：安装包只带 node-runtime（不带 bun/tsx），node 原生跑不了 .ts。纯 JS
//   用打包自带的 node 直接跑，用户新电脑零额外依赖。

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const kbDir = process.env.CLAUDE_DESKTOP_KB_DIR
if (!kbDir) {
  // env 缺失＝不是在桌面应用里跑（或 main 侧没注入）。明确报错好过打印错误路径让
  // agent 把索引写到奇怪的地方。
  console.error(
    'CLAUDE_DESKTOP_KB_DIR 未设置——本脚本需在 claude-desktop 应用内运行（main 侧注入该 env）。'
  )
  process.exit(1)
}

// 确保目录存在：agent 拿到路径后直接写索引，不必再自己 mkdir。
mkdirSync(kbDir, { recursive: true })

// 知识库是【两份索引】（文档/图片按扩展名分流，见 SKILL.md）：
//   indexPath      —— 文档索引 KB-INDEX.json
//   imageIndexPath —— 图片索引 KB-IMAGE-INDEX.json
// categories 同样按域各一份（用户在应用「分类管理」页自定义，可能不存在——
// 那就用 SKILL.md 里对应域的默认清单）。归类必须以集合为准，不许自造类别。
const indexPath = join(kbDir, 'KB-INDEX.json')
const imageIndexPath = join(kbDir, 'KB-IMAGE-INDEX.json')
const categoriesPath = join(kbDir, 'KB-CATEGORIES.json')
const imageCategoriesPath = join(kbDir, 'KB-IMAGE-CATEGORIES.json')
console.log(
  JSON.stringify(
    { kbDir, indexPath, imageIndexPath, categoriesPath, imageCategoriesPath },
    null,
    2
  )
)
