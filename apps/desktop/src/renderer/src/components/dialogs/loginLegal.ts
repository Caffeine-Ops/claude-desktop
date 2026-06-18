/*
 * loginLegal.ts
 * =============
 * The long-form copy behind the login modal's 《用户协议》/《隐私政策》 links,
 * pulled out of LoginDialog.tsx so the component file stays about markup +
 * interaction rather than carrying ~200 lines of legal prose inline.
 *
 * These are STANDARD TEMPLATE texts, not vetted legal documents: they cover
 * the obvious surfaces for this product (phone-number accounts, the AI/agent
 * workflow, the third-party fusion-code / model calls that process whatever a
 * user types) so the UI is complete and reads like a real agreement. Swap in a
 * lawyer-reviewed version by editing only this file — the dialog doesn't change.
 *
 * The operating entity ("Open Design") and the support email are PLACEHOLDERS;
 * the single source of truth for both lives here so a real value only has to be
 * filled in once.
 */

/** Operating entity shown across the legal copy. Placeholder. */
export const LEGAL_ENTITY = 'Open Design'
/** Support contact shown on the 联系支持 panel. Placeholder. */
export const SUPPORT_EMAIL = 'support@opendesign.example'
/** Effective date stamped on both documents. Placeholder. */
export const LEGAL_EFFECTIVE_DATE = '2026 年 6 月 1 日'

export interface LegalSection {
  heading: string
  /**
   * Paragraphs. A line that starts with `· ` is rendered as a bullet item
   * (the dialog styles `.od-legal-li`); everything else is a plain paragraph.
   */
  body: string[]
}

export interface LegalDoc {
  title: string
  /** One-line lead under the title (e.g. effective date). */
  meta: string
  intro: string
  sections: LegalSection[]
}

export const TERMS_DOC: LegalDoc = {
  title: '用户协议',
  meta: `生效日期：${LEGAL_EFFECTIVE_DATE}`,
  intro: `欢迎使用 ${LEGAL_ENTITY}（以下简称"本产品"）。本协议是您与本产品运营方之间就使用本产品服务所订立的协议。请您在使用前仔细阅读本协议全部内容，特别是免除或限制责任的条款。当您勾选同意并完成登录，即表示您已充分理解并同意接受本协议的全部约定。`,
  sections: [
    {
      heading: '一、服务说明',
      body: [
        `本产品是一款面向创作的智能体工作台，通过封装 fusion-code 等命令行与模型能力，帮助您将想法转化为成品。`,
        '我们可能会不时更新、调整或优化服务功能。除另有约定外，相关变更同样适用本协议。'
      ]
    },
    {
      heading: '二、账户与登录',
      body: [
        '本产品采用手机号 + 短信验证码方式登录。未注册的手机号在首次登录时将自动创建账户。',
        '您应妥善保管您的手机号及设备，因您自身原因导致验证码泄露或账户被他人使用的，由您自行承担相应后果。',
        '您承诺登录所使用的手机号为您本人合法持有，不得冒用他人身份或使用非法获取的号码。'
      ]
    },
    {
      heading: '三、用户行为规范',
      body: [
        '您在使用本产品过程中应遵守所适用的法律法规，不得利用本产品从事以下行为：',
        '· 生成、传播违法、侵权、暴力、色情或其他违背公序良俗的内容；',
        '· 侵犯他人知识产权、商业秘密、隐私或其他合法权益；',
        '· 干扰、破坏本产品或其依赖的第三方服务的正常运行；',
        '· 利用自动化手段对服务进行超出正常使用范围的访问或滥用。'
      ]
    },
    {
      heading: '四、内容与知识产权',
      body: [
        '本产品自身的软件、界面、商标及相关素材的知识产权归运营方或相应权利人所有。',
        '在遵守本协议与适用法律的前提下，您通过本产品生成的成果，其使用权归属于您；但您应自行确保您提供的输入及最终用途不侵犯任何第三方权益。',
        '由于生成式技术的特性，相同或相似的输入可能产生相近的结果，您理解并接受该特性。'
      ]
    },
    {
      heading: '五、第三方服务',
      body: [
        `本产品的核心能力依赖 fusion-code 命令行及底层模型服务。您的部分输入将被传递给上述第三方以完成响应。`,
        '上述第三方服务可能有其自身的条款与策略，您对相关服务的使用还应遵守其各自的规定。'
      ]
    },
    {
      heading: '六、免责声明',
      body: [
        '本产品按"现状"提供，我们不对生成结果的准确性、完整性或适用性作出任何明示或默示的保证。',
        '对于因不可抗力、第三方服务中断、网络故障等非我方可控原因造成的服务中断或数据损失，我们在法律允许的范围内不承担责任。',
        '您应对依据本产品生成结果所作出的决策及行为自行负责。'
      ]
    },
    {
      heading: '七、协议变更与服务终止',
      body: [
        '我们可能根据业务需要修订本协议，更新后的协议将在本产品内公示。若您在协议变更后继续使用，即视为接受变更内容。',
        '若您违反本协议，我们有权视情节暂停或终止向您提供部分或全部服务。'
      ]
    },
    {
      heading: '八、适用法律',
      body: [
        '本协议的订立、解释及争议解决均适用中华人民共和国大陆地区法律。',
        '若双方就本协议发生争议，应首先友好协商解决；协商不成的，可依法向有管辖权的人民法院提起诉讼。'
      ]
    }
  ]
}

export const PRIVACY_DOC: LegalDoc = {
  title: '隐私政策',
  meta: `生效日期：${LEGAL_EFFECTIVE_DATE}`,
  intro: `${LEGAL_ENTITY}（以下简称"我们"）深知个人信息对您的重要性，并会尽力保护您的个人信息安全。本政策说明我们如何收集、使用、存储和保护您的信息，以及您所享有的权利。请您在使用本产品前仔细阅读。`,
  sections: [
    {
      heading: '一、我们收集的信息',
      body: [
        '为向您提供服务，我们会在必要范围内收集以下信息：',
        '· 账户信息：您登录所使用的手机号；',
        '· 设备与日志信息：用于保障服务稳定与安全的设备标识、操作系统、错误日志等；',
        '· 服务内容：您在使用过程中主动输入的指令、文本及为完成任务而提供的资料。'
      ]
    },
    {
      heading: '二、我们如何使用信息',
      body: [
        '· 完成账户的注册、登录与身份校验；',
        '· 向您提供、维护与改进本产品的核心功能；',
        '· 保障服务安全，预防、发现和处理欺诈或滥用行为；',
        '· 在获得您同意或法律要求的情形下进行其他必要处理。'
      ]
    },
    {
      heading: '三、信息的对外共享',
      body: [
        `为实现智能体的核心能力，您输入的部分内容会被传输至 fusion-code 命令行及底层模型服务以生成响应。`,
        '除上述为实现功能所必需的情形、获得您单独同意的情形，或法律法规要求的情形外，我们不会向第三方共享您的个人信息。'
      ]
    },
    {
      heading: '四、信息的存储与安全',
      body: [
        '我们将采取合理且符合行业标准的技术与管理措施保护您的信息，防止未经授权的访问、泄露或篡改。',
        '我们仅在实现本政策所述目的所必需的期限内保留您的信息，法律法规另有规定的除外。'
      ]
    },
    {
      heading: '五、您的权利',
      body: [
        '在适用法律允许的范围内，您有权对您的个人信息行使以下权利：',
        '· 访问与更正您的账户信息；',
        '· 删除您的信息或注销账户；',
        '· 撤回您此前作出的授权同意。',
        `如需行使上述权利，您可通过本政策末尾的联系方式与我们联系。`
      ]
    },
    {
      heading: '六、本地存储',
      body: [
        '本产品可能在您的设备本地存储必要的配置与会话信息，以维持登录状态、保存您的偏好并提升使用体验。'
      ]
    },
    {
      heading: '七、未成年人保护',
      body: [
        '本产品主要面向成年人。若您是未成年人，请在监护人陪同与同意下使用，并由监护人协助阅读本政策。'
      ]
    },
    {
      heading: '八、政策更新',
      body: [
        '我们可能适时更新本隐私政策。更新后的政策将在本产品内公示，重大变更我们会以适当方式提示您。'
      ]
    },
    {
      heading: '九、如何联系我们',
      body: [
        `如您对本政策或您的个人信息有任何疑问、意见或投诉，可通过 ${SUPPORT_EMAIL} 与我们联系，我们将尽快予以回复。`
      ]
    }
  ]
}
