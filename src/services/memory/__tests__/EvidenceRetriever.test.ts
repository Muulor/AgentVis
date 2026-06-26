import { describe, expect, it } from 'vitest';
import { EvidenceRetriever } from '../EvidenceRetriever';
import type { Message, OpenQuestion } from '../types';

describe('EvidenceRetriever', () => {
    it('returns a complete user-assistant turn for query-aware evidence', async () => {
        const retriever = new EvidenceRetriever();
        const slices = await retriever.retrieve(
            createStockQuestion(),
            [
                createMessage('user', '要不帮我查查现在哪个股比较适合模拟？'),
                createMessage('assistant', '推荐模拟标的包括招商银行、美的集团、宁德时代。宁德时代适合练习成长股思路。'),
                createMessage('user', '宁德时代好像最近都比较火，能否展开分析一下'),
                createMessage('assistant', [
                    '宁德时代核心分析摘要。',
                    '公司地位：全球动力电池和储能电池领先。',
                    '财务数据：营收、净利润、出货量高增。',
                    '风险提示：竞争加剧、地缘政治影响、原材料价格波动。',
                ].join('\n')),
            ],
            {
                maxEvidenceTurns: 1,
                userQuery: '所以其实分析任何一家股票，就得像调查宁德时代这种维度的各种信息来分析，是一个比较通用的投资前的策略对吗',
            }
        );

        expect(slices).toHaveLength(2);
        expect(slices.map(slice => `${slice.turnId}:${slice.speaker}`)).toEqual(['2:user', '2:assistant']);
        expect(slices[0]?.content).toContain('能否展开分析一下');
        expect(slices[1]?.content).toContain('宁德时代核心分析摘要');
    });

    it('clips long assistant evidence to query-relevant paragraphs', async () => {
        const retriever = new EvidenceRetriever();
        const slices = await retriever.retrieve(
            createStockQuestion(),
            [
                createMessage('user', '宁德时代好像最近都比较火，能否展开分析一下'),
                createMessage('assistant', [
                    '公司地位：全球动力电池连续多年领先，储能电池市占率靠前。',
                    '财务数据：营收、净利润、出货量保持增长，产能利用率较高。',
                    '机构观点：多家券商给出买入评级。',
                    '风险提示：竞争加剧，原材料价格波动，地缘政治影响海外布局。',
                    '模拟盘结论：适合练习成长股分析，但波动会比较大。',
                ].join('\n\n')),
            ],
            {
                maxEvidenceTurns: 1,
                maxAssistantChars: 80,
                userQuery: '分析宁德时代风险，尤其原材料和地缘政治这些维度',
            }
        );

        const assistantSlice = slices.find(slice => slice.speaker === 'assistant');
        expect(assistantSlice?.content).toContain('风险提示');
        expect(assistantSlice?.content).toContain('原材料');
        expect(assistantSlice?.content.length).toBeLessThanOrEqual(83);
    });
});

function createStockQuestion(): OpenQuestion {
    return {
        question: '用户是否需要进一步查看宁德时代的细分详细数据，或对比招商银行、美的集团的相关信息',
        scope: '个股分析',
        reason: '需要根据前文股票分析内容继续展开。',
        turnHint: [2],
        keywords: ['宁德时代', '股票分析', '细分数据', '招商银行', '美的集团'],
    };
}

function createMessage(role: 'user' | 'assistant', content: string): Message {
    return {
        id: `${role}-${content.substring(0, 8)}`,
        agentId: 'agent-1',
        role,
        content,
        createdAt: Date.now(),
    };
}
