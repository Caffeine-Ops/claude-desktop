// 前后端共享的嵌入模型下载状态。范式同 UpdaterState/KbBuildStatus：main 持单例、
// invoke 拉快照 + 主动推全量，renderer 整体替换不拼装。
export interface KbModelDownloadState {
  /** idle=未开始/未安装；downloading=下载中；ready=已就绪（安装完或本就存在）；error=失败。 */
  phase: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0-100，跨所有文件的整体字节进度（分母＝各文件真实字节数之和，onnx 占绝对多数）。 */
  percent: number
  /** 当前正在下载的文件相对路径（供 UI 文本），非下载态为 null。 */
  currentFile: string | null
  /** 失败原因，成功/进行中为 null。 */
  errorMessage: string | null
  /** 模型是否已在磁盘就绪（判据同 kbBuildWorker.modelReady）。 */
  installed: boolean
}

export const INITIAL_KB_MODEL_DOWNLOAD_STATE: KbModelDownloadState = {
  phase: 'idle',
  percent: 0,
  currentFile: null,
  errorMessage: null,
  installed: false,
}
