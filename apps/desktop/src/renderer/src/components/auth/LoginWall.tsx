import { useT } from '../../i18n'
import { useDialogStore } from '../../stores/dialogs'

/**
 * 登录墙——未登录时占据聊天区，挡住一切聊天交互。它本身不含登录表单，只是
 * 一个入口：按钮打开已有的 LoginDialog（phone + SMS）。登录成功后 auth store
 * 的 loggedIn 翻 true，App.tsx 不再渲染本组件、改挂 FusionRuntimeProvider。
 *
 * 为什么用墙挡住而不是只靠 engine 的 spawn 守卫：守卫只是兜底（未登录时
 * openSession 抛错），但那是个原始错误、UX 差。墙在 UI 层就阻止未登录用户
 * 走到发消息那一步，并给出明确的登录入口。
 */
export function LoginWall(): React.JSX.Element {
  const t = useT()
  const openDialog = useDialogStore((s) => s.openDialog)
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-background/60 px-10 py-12 text-center backdrop-blur-xl">
        <h2 className="text-lg font-semibold text-foreground">{t('loginWallTitle')}</h2>
        <p className="max-w-xs text-[13px] leading-relaxed text-foreground/60">{t('loginWallSubtitle')}</p>
        <button
          type="button"
          onClick={() => openDialog('login')}
          className="rounded-full bg-foreground px-6 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
        >
          {t('loginWallButton')}
        </button>
      </div>
    </div>
  )
}
