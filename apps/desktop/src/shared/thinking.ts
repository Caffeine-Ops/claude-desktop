/**
 * 思考的 token 预算上限。main（engine.ts openSession）用它注入 MAX_THINKING_TOKENS
 * env，限制单轮思考最多消耗多少 token——保守取大，避免截断较长的思考。
 *
 * 注意：这 *不是* 进度条的分母（见 THINKING_PROGRESS_FULL_TOKENS）。早先两者
 * 共用一个常量（"真分母 = 思考上限"），但实测发现：上限取得够大（不截断思考）时，
 * 典型一轮思考（几百~一两千字符）相对 8000 token 的占比是个位数甚至 round 成 0%，
 * 进度条形同不动。"不截断思考"和"进度条有意义"绑在同一个数上不可兼得，故把分母
 * 解耦出去（下一个常量），这里只保留思考上限的职责。
 */
export const THINKING_TOKEN_BUDGET = 8000

/**
 * 进度条满格（≈100%）对应的思考量，与上面的思考上限解耦。
 * pct = 已累积思考 token 估值 / 本常量，封顶 99%（thinking_end 后才 100%）。
 *
 * 取值贴近"典型一轮思考"的量级而非思考上限：满格 600 token ≈ 2100 字符（按下面
 * 的字符系数），于是常见思考能走到 30~80%、长思考停在 99%——既反映"在推进"，又
 * 不必为了不截断长思考而把分母撑大到进度条不动。它纯是显示用的满格基准，调它只
 * 影响进度条走速、不影响思考长度（那由 THINKING_TOKEN_BUDGET 管）。
 */
export const THINKING_PROGRESS_FULL_TOKENS = 600

/**
 * 流式过程拿不到官方实时 thinking token 数，只能用已累积的思考字符数估算：
 * 中英文混合的经验值约 3.5 字符 ≈ 1 token。取偏大系数 → 估出的 token（分子）
 * 偏保守 → 进度条不会虚高冲顶。
 */
export const CHARS_PER_THINKING_TOKEN = 3.5
