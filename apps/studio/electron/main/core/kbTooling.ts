/**
 * 转换工具链探测：管理页据此把导入按钮置灰并显示安装引导（spec ⑤）。
 * probeTooling 纯逻辑（DI 探针，可测）；detectTooling 是 execFileSync 薄包装。
 * 只主编机（managed 模式）会调——只读机不导入、不需要工具链。
 */
import { execFileSync } from 'node:child_process'
import type { KbToolingStatus } from '../../shared/kbAdmin'

export interface KbToolingProbe { run: (cmd: string, args: string[]) => { ok: boolean } }

export function probeTooling(probe: KbToolingProbe): KbToolingStatus {
  return {
    markitdown: probe.run('markitdown', ['--version']).ok,
    soffice: probe.run('soffice', ['--version']).ok
  }
}

/** 真探针：命令存在且能打印版本 → ok。任何异常（ENOENT/非零退出）→ ok:false。 */
export function detectTooling(): KbToolingStatus {
  return probeTooling({
    run: (cmd, args) => {
      try {
        // stdio ignore：只关心能不能起来、退出码，不要污染主进程日志。
        execFileSync(cmd, args, { stdio: 'ignore', timeout: 4000 })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    }
  })
}
