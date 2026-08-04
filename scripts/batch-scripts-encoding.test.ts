import { describe, it, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Windows 批处理（.cmd/.bat）的字节形态守门测试（2026-08-04 事故后补）。
 *
 * 事故：三份 ensure-python.cmd 一直是 LF 行尾 + UTF-8 中文注释，于是在 Windows
 * 上从来没真正建出过 venv——cmd.exe 按字节偏移边读边执行，LF-only 时对下一行的
 * 重定位会落在行中间，跨行的 `( … )` 块与 `for /f` 循环静默错乱（`set` 行像没
 * 执行过），最终 `echo PPT_PY=%VENV_PY%` 展开成空串。而调用方 pptSkillInstaller
 * 只看退出码，脚本乱序后仍可能以 0 退出 → UI 报「已就绪」，实际环境根本没建，
 * 用户看到的报错离真因十万八千里。
 *
 * 非 ASCII 同样致命：GBK 码页下 UTF-8 字符被按双字节配对读取，落单的尾字节会
 * 吞掉紧随其后的 ASCII 字节——转义符 `^>` 的 `^` 被吞掉后 `>` 就变成真的重定向。
 *
 * 两条约束都由 `.gitattributes` 的四条 `eol=crlf` 规则（针对 skills 与 skills-src
 * 下的 cmd/bat，必须写在 `skills/** text eol=lf` 之后才能覆盖它）在检出侧保证，
 * 本测试是第二道闸：属性写错、新增目录没被通配覆盖、或有人手滑提交了中文注释，
 * 都会在这里当场炸。
 *
 * 注：本段注释刻意不写出带星号斜杠的 glob 字面量——那个组合会提前闭合块注释
 * （仓库 errors 里有同款记录）。
 *
 * 反过来 `.sh` 必须保持 LF（bash 吃 CRLF 会报 `$'\r': command not found`），
 * 顺带一并断言，免得将来有人把整棵树统一成 CRLF 时把 shell 脚本一起带沟里。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** git 跟踪的文件清单（只测入库的——构建产物 prebundled/ 是 cpSync 逐字节副本，源对了它就对）。 */
function trackedFiles(pattern: string): string[] {
  const out = execFileSync('git', ['ls-files', pattern], { cwd: repoRoot, encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

const batchFiles = [
  ...trackedFiles('skills/**/*.cmd'),
  ...trackedFiles('skills/**/*.bat'),
  ...trackedFiles('skills-src/**/*.cmd'),
  ...trackedFiles('skills-src/**/*.bat')
]

describe('Windows 批处理脚本的字节形态', () => {
  it('至少扫到三份 ensure-python.cmd（通配没写错的自检）', () => {
    // 通配失效时上面会得到空数组，下面每条断言都空转通过——先证明真的扫到了东西。
    expect(batchFiles.length).toBeGreaterThanOrEqual(3)
    for (const skill of ['ppt-creator', 'writing', 'spreadsheets']) {
      expect(batchFiles.some((f) => f.includes(skill) && f.endsWith('ensure-python.cmd'))).toBe(true)
    }
  })

  for (const rel of batchFiles) {
    describe(rel, () => {
      const buf = readFileSync(join(repoRoot, rel))

      it('每个换行都是 CRLF（无孤立 LF）', () => {
        const loneLf: number[] = []
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x0a && buf[i - 1] !== 0x0d) loneLf.push(i)
        }
        // 报字节偏移而不是只报个 false——定位到具体哪一行比「有问题」有用得多。
        expect(loneLf).toEqual([])
      })

      it('无孤立 CR（CR 后面必须跟 LF）', () => {
        const loneCr: number[] = []
        for (let i = 0; i < buf.length; i++) {
          if (buf[i] === 0x0d && buf[i + 1] !== 0x0a) loneCr.push(i)
        }
        expect(loneCr).toEqual([])
      })

      it('纯 ASCII（无 >0x7F 字节，含无 BOM）', () => {
        const nonAscii: string[] = []
        for (let i = 0; i < buf.length; i++) {
          if (buf[i]! > 0x7f) nonAscii.push(`0x${buf[i]!.toString(16)}@${i}`)
        }
        expect(nonAscii).toEqual([])
      })
    })
  }
})

describe('技能 shell 脚本必须保持 LF', () => {
  const shFiles = [...trackedFiles('skills/**/*.sh'), ...trackedFiles('skills-src/**/*.sh')]

  it('至少扫到三份 ensure-python.sh', () => {
    expect(shFiles.length).toBeGreaterThanOrEqual(3)
  })

  for (const rel of shFiles) {
    it(`${rel} 无 CR`, () => {
      // bash 会把行尾的 \r 当成命令的一部分：`$'\r': command not found`。
      expect(readFileSync(join(repoRoot, rel)).includes(0x0d)).toBe(false)
    })
  }
})
