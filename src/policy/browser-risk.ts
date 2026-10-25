import { createHash } from 'node:crypto';

/**
 * 浏览器操作动态风险判定（4.3 核心）：
 * - 风险由「目标元素 + 操作类型 + 页面上下文」共同决定，不能只看工具名；
 * - 无法可靠判定 → 一律高风险（保守默认）；
 * - 页面内容只能提供判定输入，不能修改本规则（规则在程序内，页面无权触达）。
 */

export interface ElementDescriptor {
  ref: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  href?: string;
  /** 元素所在 form 的 method/action（无 form 为空） */
  formMethod?: string;
  formAction?: string;
  disabled?: boolean;
}

export type BrowserRisk = 'low' | 'network' | 'high';

export interface RiskDecision {
  risk: BrowserRisk;
  reason: string;
  /** 审批展示用：预判的具体影响 */
  impact?: string;
}

// 中英副作用动词（点击类）：宁可误报，不可漏报
const SIDE_EFFECT_VERBS =
  /(提交|发布|发表|发送|付款|支付|购买|下单|订购|删除|移除|清除|注销|登出|退出登录|开通|续费|转账|提现|确认|生成订单|结算|投稿|评论|回复|订阅|关注|点赞|分享|上传|修改|保存|应用|更新|submit|publish|post\b|send|share|buy|purchase|pay|checkout|order|delete|remove|clear|confirm|transfer|withdraw|subscribe|follow|like|upload|update|save\b|apply\b|reply|comment)/i;

// 账户与安全类动词
const ACCOUNT_VERBS =
  /(登录|登陆|注册|改密|密码|绑定|解绑|验证身份|实名|注销账号|两步验证|找回|log ?in|sign ?in|sign ?up|register|password|passphrase|2fa|two.?factor|otp|verify identity|account settings|delete account|recover)/i;

/** 敏感输入字段：密码/支付/账户安全（autocomplete、name、type 综合判定） */
const SENSITIVE_FIELD_HINTS =
  /(password|passphrase|secret|token|api[-_]?key|private[-_]?key|cc[-_]?(number|csc|cvv|cvc|exp)|\b(cvv|cvc|csc)\b|credit.?card|card.?number|security.?code|verification.?code|one[-_]?time.?code|otp|sms.?code|密码|支付密码|安全码|验证码|信用卡|卡号|有效期|持卡人)/i;

const SENSITIVE_AUTOCOMPLETE =
  /^(current-password|new-password|cc-number|cc-csc|cc-cvv|cc-exp|cc-exp-month|cc-exp-year|cc-name|cc-type|one-time-code|otp|sms-otp)$/i;

const VALUE_SECRET_PATTERNS = [
  /\b(sk|rk)-[A-Za-z0-9_-]{10,}\b/,
  /\b(?:\d[ -]?){13,19}\b/, // 信用卡形态数字
  /^[A-Za-z0-9+/=]{32,}$/ // 长 base64 形态令牌
];

/** 点击类判定 */
export function classifyClick(el: ElementDescriptor, pageUrl: string): RiskDecision {
  void pageUrl;
  if (el.disabled) {
    return { risk: 'low', reason: '元素处于禁用状态，无实际效果' };
  }
  const label = `${el.text ?? ''} ${el.name ?? ''} ${el.role ?? ''}`.trim();
  const type = String(el.type ?? '').toLowerCase();
  const tag = el.tag.toLowerCase();
  const inForm = Boolean(el.formAction || el.formMethod);

  if (label !== '' && SIDE_EFFECT_VERBS.test(label)) {
    return {
      risk: 'high',
      reason: `目标元素文案命中副作用动词（${label.slice(0, 40)}）`,
      impact: `可能触发提交/发布/删除/支付等外部副作用（目标：${originOf(el, pageUrl)}）`
    };
  }
  if (label !== '' && ACCOUNT_VERBS.test(label)) {
    return {
      risk: 'high',
      reason: `目标元素文案命中账户/安全动词（${label.slice(0, 40)}）`,
      impact: '可能涉及登录、凭证或账户设置变更'
    };
  }
  if (
    type === 'submit' ||
    type === 'image' ||
    (inForm && (tag === 'button' || type === 'button'))
  ) {
    return {
      risk: 'high',
      reason: '表单提交型元素（submit/image/表单内按钮）',
      impact: `可能提交表单到 ${originOf(el, pageUrl)}`
    };
  }
  if (type === 'password' || (tag === 'input' && SENSITIVE_FIELD_HINTS.test(String(el.name ?? '')))) {
    return {
      risk: 'high',
      reason: '凭证/敏感输入控件',
      impact: '可能触发凭证或敏感信息交互'
    };
  }
  // 信息不足 → 保守高风险
  if (label === '' && !el.href && !inForm && type === '') {
    return {
      risk: 'high',
      reason: '元素语义信息不足（无文案/无链接/无类型），无法可靠判定',
      impact: '影响未知，按高风险处理'
    };
  }
  if (el.href) {
    return { risk: 'network', reason: '导航链接（受浏览器网络策略约束）' };
  }
  return { risk: 'network', reason: '页面内交互（非明显副作用动词）' };
}

/** 输入类判定（value 为待输入内容 —— 仅用于判定，绝不进入审计） */
export function classifyType(el: ElementDescriptor, value: string): RiskDecision {
  const type = String(el.type ?? '').toLowerCase();
  const autocomplete = String((el as ElementDescriptor & { autocomplete?: string }).autocomplete ?? '');
  const nameHint = `${el.name ?? ''} ${el.text ?? ''}`;

  if (type === 'password' || SENSITIVE_AUTOCOMPLETE.test(autocomplete)) {
    return {
      risk: 'high',
      reason: '密码/支付/一次性验证码字段（type 或 autocomplete 判定）',
      impact: '将向敏感字段输入内容（输入值不写入任何日志）'
    };
  }
  if (SENSITIVE_FIELD_HINTS.test(nameHint) && type !== 'search') {
    return {
      risk: 'high',
      reason: `字段语义含敏感迹象（${nameHint.trim().slice(0, 40)}）`,
      impact: '字段可能承载凭证或支付信息'
    };
  }
  if (VALUE_SECRET_PATTERNS.some((re) => re.test(value))) {
    return {
      risk: 'high',
      reason: '待输入内容匹配密钥/卡号/令牌形态',
      impact: '将输入疑似敏感数据（值不写入审计）'
    };
  }
  if (type === 'search' || type === 'text' || type === 'email' || el.tag === 'textarea' || type === 'url' || type === 'tel') {
    if (labelComplete(el)) {
      return { risk: 'low', reason: `普通${type === 'search' ? '搜索' : '文本'}字段` };
    }
    return { risk: 'high', reason: '字段语义不明确，无法排除敏感用途（保守处理）', impact: '字段用途未知' };
  }
  // 未知 type（date/number/file/hidden/…）：file 上传有明确副作用；其余不明确 → 高
  return { risk: 'high', reason: `非常规输入类型（${type || '未知'}），无法可靠判定`, impact: '影响未知，按高风险处理' };
}

function labelComplete(el: ElementDescriptor): boolean {
  const type = String(el.type ?? '').toLowerCase();
  return type === 'search' || type === 'email' || type === 'url' || el.tag === 'textarea' ||
    (el.name ?? '').trim() !== '' || (el.text ?? '').trim() !== '';
}

function originOf(el: ElementDescriptor, pageUrl: string): string {
  const action = el.formAction ?? el.href;
  if (action) {
    try {
      return new URL(action, pageUrl).origin;
    } catch {
      return action.slice(0, 60);
    }
  }
  try {
    return new URL(pageUrl).origin;
  } catch {
    return pageUrl.slice(0, 60);
  }
}

/**
 * 元素签名：审批绑定的最小稳定特征。
 * 页面导航（pageUrl 变化）或任一特征变化都会使签名改变 → 审批失效。
 */
export function elementSignature(el: ElementDescriptor, pageUrl: string): string {
  const parts = [
    pageUrl,
    el.tag,
    el.role ?? '',
    el.type ?? '',
    (el.name ?? '').slice(0, 80),
    (el.text ?? '').slice(0, 120),
    el.href ?? '',
    el.formMethod ?? '',
    el.formAction ?? ''
  ];
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 24);
}

/** 审批摘要：只含字段描述与目的，绝不包含待输入值 */
export function approvalSummary(action: string, el: ElementDescriptor, pageUrl: string, impact: string): string {
  const desc = [
    el.tag,
    el.type ? `[type=${el.type}]` : '',
    el.role ? `[role=${el.role}]` : '',
    el.name ? `名称:"${el.name.slice(0, 40)}"` : '',
    el.text ? `文案:"${el.text.slice(0, 60)}"` : ''
  ]
    .filter(Boolean)
    .join(' ');
  return `${action} → ${originOf(el, pageUrl)} ${desc}｜${impact}`;
}
