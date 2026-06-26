import { describe, expect, it } from 'vitest';
import {
    buildAuditOutputLanguageInstruction,
    buildAuditSystemPrompt,
    buildAuditTaskDescription,
    parseAuditResultFromOutput,
} from '../SkillAuditService';

const HAN_CHARACTER_PATTERN = /[\u3400-\u9FFF]/;

describe('SkillAuditService prompt invariants', () => {
    const packagePath = 'C:/AgentVis/skills/external/packages/sample-skill';
    const fileList = [
        'SKILL.md',
        'scripts/run.py',
        'package.json',
        'README.md',
        'assets/icon.svg',
    ];

    it('keeps system-owned audit prompt text in English', () => {
        const prompt = buildAuditSystemPrompt(packagePath, fileList, 'en-US');

        expect(prompt).not.toMatch(HAN_CHARACTER_PATTERN);
    });

    it('preserves schema fields, verdict enums, and termination signal', () => {
        const prompt = buildAuditSystemPrompt(packagePath, fileList, 'en-US');
        const requiredTokens = [
            'audit_result',
            'risk_score',
            'confidence',
            'summary',
            'intent_mismatch',
            'detected_capabilities',
            'findings',
            'line_or_location',
            'risk_level',
            'risk_type',
            'attack_scenario',
            'recommendation',
            'APPROVED',
            'REJECTED',
            'MANUAL_REVIEW_REQUIRED',
            'LOW',
            'MEDIUM',
            'HIGH',
            'CRITICAL',
            'TASK_COMPLETE',
        ];

        for (const token of requiredTokens) {
            expect(prompt).toContain(token);
        }
    });

    it('keeps the audit runner constrained to the read tool', () => {
        const prompt = buildAuditSystemPrompt(packagePath, fileList, 'en-US');

        expect(prompt).toContain('## Available Tools');
        expect(prompt).toContain('### read');
        expect(prompt).toContain('Read file contents. Parameters: `path`');
    });

    it('instructs human-readable result fields to follow the Chinese UI language', () => {
        const prompt = buildAuditSystemPrompt(packagePath, fileList, 'zh-CN');

        expect(prompt).toContain('Current UI language: Simplified Chinese (zh-CN)');
        expect(prompt).toContain('Write these human-readable natural-language fields in Simplified Chinese');
        expect(prompt).toContain('`summary`');
        expect(prompt).toContain('`findings[].description`');
        expect(prompt).toContain('`findings[].attack_scenario`');
        expect(prompt).toContain('`findings[].recommendation`');
        expect(prompt).toContain('Keep JSON keys, enum values, risk levels, file paths');
        expect(prompt).toContain('Keep `detected_capabilities` and `findings[].risk_type`');
    });

    it('can request English human-readable fields for English UI', () => {
        const instruction = buildAuditOutputLanguageInstruction('en-US');

        expect(instruction).toContain('Current UI language: English (en-US)');
        expect(instruction).toContain('Write these human-readable natural-language fields in English');
        expect(instruction).toContain('Keep JSON keys, enum values');
    });

    it('prioritizes high-risk files before config, docs, and other files', () => {
        const taskDescription = buildAuditTaskDescription(packagePath, fileList);

        expect(taskDescription).toContain('root skill definition: SKILL.md');
        expect(taskDescription).toContain('script/code files (high priority): scripts/run.py');
        expect(taskDescription).toContain('all configuration files: package.json');
        expect(taskDescription).toContain('documentation files: README.md');
        expect(taskDescription).toContain('assets by path/name');
        expect(taskDescription).toContain('assets/icon.svg');
        expect(taskDescription.indexOf('root skill definition')).toBeLessThan(
            taskDescription.indexOf('script/code files')
        );
        expect(taskDescription.indexOf('script/code files')).toBeLessThan(
            taskDescription.indexOf('configuration files')
        );
        expect(taskDescription.indexOf('configuration files')).toBeLessThan(
            taskDescription.indexOf('documentation files')
        );
    });
});

describe('SkillAuditService result parsing', () => {
    it('normalizes snake_case audit JSON into the service result shape', () => {
        const result = parseAuditResultFromOutput(JSON.stringify({
            audit_result: 'REJECTED',
            risk_score: 9,
            confidence: 'HIGH',
            summary: 'External command execution accepts untrusted input.',
            intent_mismatch: true,
            detected_capabilities: ['shell execution', 'network access'],
            findings: [{
                file: 'scripts/run.py',
                line_or_location: 'line 12',
                risk_level: 'CRITICAL',
                risk_type: 'RCE',
                description: 'Runs shell commands from user-controlled arguments.',
                attack_scenario: 'A crafted argument can execute arbitrary commands.',
                recommendation: 'Remove shell execution or use a strict allowlist.',
            }],
        }));

        expect(result.auditResult).toBe('REJECTED');
        expect(result.riskScore).toBe(9);
        expect(result.confidence).toBe('HIGH');
        expect(result.intentMismatch).toBe(true);
        expect(result.detectedCapabilities).toEqual(['shell execution', 'network access']);
        expect(result.findings).toEqual([{
            file: 'scripts/run.py',
            lineOrLocation: 'line 12',
            riskLevel: 'CRITICAL',
            riskType: 'RCE',
            description: 'Runs shell commands from user-controlled arguments.',
            attackScenario: 'A crafted argument can execute arbitrary commands.',
            recommendation: 'Remove shell execution or use a strict allowlist.',
        }]);
    });
});
