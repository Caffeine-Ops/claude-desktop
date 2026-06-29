import type { KbIndex } from '@shared/kbIndex'

export interface MatchedProduct {
  productLine: string
  product: string
}

// 用户文本里产品名之间的分隔符：中英文顿号/逗号/分号、空白、数字、换行。
// 数字也算分隔，是为了切掉「1 系统功能概述」里的序号，让「系统功能概述」成 token。
const TOKEN_SPLIT = /[、，,；;\s\d\r\n]+/

// 产品名里的「通用词」——剥掉后剩下的才是判别性核心。这些词几乎每个产品名都有
// （如「智能X系统」「X运营监管系统」），若拿它们去匹配会命中一大片，所以先抹成
// 分隔符再切片。注意：只抹这些整词，不抹「数字」二字（否则「数字人」会被打碎）；
// 产品名前缀的序号「1_ / 2_」靠 LEADING_INDEX 单独剥。
const GENERIC_WORDS = ['智能', '运营监管', '系统', '平台', '管理']
const LEADING_INDEX = /^\d+_/
// 片段切分：通用词被抹成空格后，连同原有空格/下划线/连字符一起切。
const FRAGMENT_SPLIT = /[\s_-]+/

/**
 * 从一个产品名里提取判别性核心片段。
 *
 * 例：「2_智能预问诊系统」→ 剥前缀「2_」→ 抹「智能」「系统」→ 切片 → ["预问诊"]；
 *    「4_医保智能审核系统」→ ["医保","审核"]；「5_数字人 诊前患者服务」→
 *    ["数字人","诊前患者服务"]。长度 <2 的片段（如孤立的「总」）丢弃。
 *
 * 为什么需要它：用户常把产品简称粘在后文里写，如「预问诊两个产品」——分词切出的
 * 是「预问诊两个产品」，它不是产品全名「智能预问诊系统」的子串，纯 token 规则会漏。
 * 用核心片段「预问诊」去 text.includes 就能命中这种粘连写法，又因为抹掉了通用词，
 * 不会像裸 token 那样让「系统功能概述」命中所有带「系统」的产品。
 */
function productCoreFragments(product: string): string[] {
  let s = product.replace(LEADING_INDEX, '')
  for (const w of GENERIC_WORDS) s = s.split(w).join(' ')
  return s.split(FRAGMENT_SPLIT).filter((f) => f.length >= 2)
}

/**
 * 从用户的一段自然语言需求里，匹配出知识库里实际存在的产品。
 *
 * 召回优先（recall-first）：宁可多命中也不漏——多命中只是多给 AI 一个可读
 * 目录、提示词多点一个名，AI 仍按用户文字写，且 chip 可删；漏命中则有「整库
 * 兜底 + AI 自行 Grep」。所以匹配错误代价低，倾向宽松。
 *
 * 纯函数：同输入同输出，无副作用、不读全局。
 */
/**
 * 列出知识库里所有【可选产品】：distinct {productLine, product}，只取有 ok 文件的。
 * 空 product 是产品线级文档、不作可选产品；只数 f.ok 的文件——只有失败文档的产品其镜像
 * 从未写出，选了也检索不到（评审 #9）。「产品 chip 可增」（方案三）的候选源，与 matchProducts
 * 的候选提取共用同一套规则（只此一处定义，避免两边漂移）。纯函数。
 */
export function listKbProducts(index: KbIndex | null): MatchedProduct[] {
  if (!index) return []
  const out: MatchedProduct[] = []
  const seen = new Set<string>()
  for (const f of index.files) {
    if (!f.ok || !f.product) continue
    const key = `${f.productLine}::${f.product}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ productLine: f.productLine, product: f.product })
  }
  return out
}

export function matchProducts(text: string, index: KbIndex | null): MatchedProduct[] {
  if (!index || !text) return []

  // 1) 候选 = 索引里所有可选产品（distinct、只取有 ok 文件的）。提取规则见 listKbProducts。
  const candidates = listKbProducts(index)

  // 2) 把用户文本切成 token（长度 ≥2 才算，避免单字误命中）。
  const tokens = text.split(TOKEN_SPLIT).filter((t) => t.length >= 2)

  // 3) 命中规则（任一成立即命中，召回优先）：
  //    a. 用户文本整体包含产品全名（如文本「导诊系统」含目录名）；
  //    b. 某个 token 是产品名的子串（如 token「导诊」⊂ 产品「智能导诊系统」）；
  //    c. 产品的某个判别性核心片段出现在用户文本里（覆盖「预问诊两个产品」这类
  //       把简称粘在后文、token 规则会漏的写法）。
  const out: MatchedProduct[] = []
  const outKeys = new Set<string>()
  for (const c of candidates) {
    const fragments = productCoreFragments(c.product)
    const hit =
      text.includes(c.product) ||
      tokens.some((tok) => c.product.includes(tok)) ||
      fragments.some((frag) => text.includes(frag))
    if (!hit) continue
    const key = `${c.productLine}::${c.product}`
    if (outKeys.has(key)) continue
    outKeys.add(key)
    out.push(c)
  }
  return out
}
