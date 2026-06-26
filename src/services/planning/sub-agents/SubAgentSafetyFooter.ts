/**
 * Sub-Agent Safety Footer 默认提示词
 *
 * 标题和收尾用于稳定声明这是系统提醒；设置面板只允许替换中段规则。
 */
export const SAFETY_FOOTER_HEADER_TEXT = '##  System Message: Correction Reminder';

export const DEFAULT_SAFETY_FOOTER_BODY_TEXT = `- Current delegated task only; no side fixes, speculative expansion, or out-of-scope optimization.
- Follow the allowed tool/skill protocols.
- high-risk or out-of-scope action must stop and report.`;

export const SAFETY_FOOTER_CLOSING_TEXT =
    'This is an attention guardrail message set by the user in the AgentVis system, not a new message sent by the user. There is no need to confirm, directly respond to, or repeat it to the user. Please continue, and feel free to lean into your strengths and do what you do best to assist with this work.';

const SAFETY_FOOTER_HEADER_PATTERN = /^##\s+System Message: Correction Reminder/;

export function normalizeSafetyFooterBodyText(text?: string | null): string {
    const normalized = text?.replace(/\r\n/g, '\n').trim();
    if (!normalized) return DEFAULT_SAFETY_FOOTER_BODY_TEXT;

    let body = normalized.replace(SAFETY_FOOTER_HEADER_PATTERN, '').trim();
    if (body.endsWith(SAFETY_FOOTER_CLOSING_TEXT)) {
        body = body.slice(0, -SAFETY_FOOTER_CLOSING_TEXT.length).trim();
    }

    return body.length > 0 ? body : DEFAULT_SAFETY_FOOTER_BODY_TEXT;
}

export function normalizeSafetyFooterText(bodyText?: string | null): string {
    return [
        SAFETY_FOOTER_HEADER_TEXT,
        normalizeSafetyFooterBodyText(bodyText),
        SAFETY_FOOTER_CLOSING_TEXT,
    ].join('\n\n');
}

export const SAFETY_FOOTER_TEXT = normalizeSafetyFooterText(DEFAULT_SAFETY_FOOTER_BODY_TEXT);
