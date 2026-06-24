/**
 * 思考进度条的单一真相源。
 * main（engine.ts openSession）用 THINKING_TOKEN_BUDGET 注入 MAX_THINKING_TOKENS
 * env 作为分母上限；renderer（ReasoningCard）用同一常量算百分比。两处引用同一
 * 来源，杜绝分母漂移。
 */
export const THINKING_TOKEN_BUDGET = 8000

/**
 * 流式过程拿不到官方实时 thinking token 数，只能用已累积的思考字符数估算：
 * 中英文混合的经验值约 3.5 字符 ≈ 1 token。取偏大系数 → 估出的 token（分子）
 * 偏保守 → 进度条不会虚高冲顶。
 */
export const CHARS_PER_THINKING_TOKEN = 3.5
