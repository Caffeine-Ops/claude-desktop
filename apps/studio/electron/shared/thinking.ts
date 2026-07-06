/**
 * 思考的 token 预算上限。main（engine.ts openSession）用它注入 MAX_THINKING_TOKENS
 * env，限制单轮思考最多消耗多少 token——保守取大，避免截断较长的思考。
 *
 * 历史：曾用它（以及一个解耦出来的"显示满格"常量）给思考卡算百分比进度条，但
 * 思考没有可靠的"完成度"，分母怎么取都失真（贴上限取大则恒 0%，取小又随思考量
 * 波动）。进度条已废弃，思考卡改为"步数 + 逐条气泡 + 末步光标"展示推进（见
 * ThreadView 的 ReasoningCard）。本常量如今只剩"思考上限"这一个职责。
 */
export const THINKING_TOKEN_BUDGET = 8000
