import { describe, expect, it } from 'vitest';
import { extractExperienceFeedback } from '../ExperienceExtractor';

describe('extractExperienceFeedback', () => {
    it('extracts stable execution experience items', () => {
        const observations = [
            'TASK_COMPLETE',
            '',
            '## EXECUTION_EXPERIENCE',
            '- Agnes Video V2.0 create responses should be polled with video_id through /agnesapi when available.',
        ].join('\n');

        expect(extractExperienceFeedback(observations)).toEqual([
            'Agnes Video V2.0 create responses should be polled with video_id through /agnesapi when available.',
        ]);
    });

    it('filters unverified root-cause guesses from long-term task experience', () => {
        const observations = [
            'TASK_COMPLETE',
            '',
            '## EXECUTION_EXPERIENCE',
            '- 当外部 Skill 的 payload 验证通过但实际网络调用失败时，问题可能是 Broker 无法建立到目标域名的网络连接，需要排查代理/防火墙配置而非修改代码或参数。',
        ].join('\n');

        expect(extractExperienceFeedback(observations)).toEqual([]);
    });
});
