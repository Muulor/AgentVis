import { describe, expect, it } from 'vitest';
import {
    translateDependencyInstallResultMessage,
    translateRuntimeProgressPhase,
} from './runtimeMessages';

const t = (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    return `${key}:${JSON.stringify(params)}`;
};
const translate = t as Parameters<typeof translateRuntimeProgressPhase>[1];

describe('runtimeMessages', () => {
    it('translates current English runtime phases', () => {
        expect(translateRuntimeProgressPhase('Checking Python installation', translate))
            .toBe('runtime.progress.checkPython');
    });

    it('translates current English runtime batch phases', () => {
        expect(translateRuntimeProgressPhase('Installing base packages 1-3/10: pip, wheel', translate))
            .toBe('runtime.progress.installBaseBatch:{"range":"1-3","total":"10","packages":"pip, wheel"}');
    });

    it('translates current English dependency install results', () => {
        expect(translateDependencyInstallResultMessage(
            'Dependencies for skill "read" installed successfully (2 packages)',
            translate
        )).toBe('settings.skills.depInstallCompleteForSkill:{"name":"read","count":"2"}');
    });

    it('translates current English dependency failures', () => {
        expect(translateDependencyInstallResultMessage(
            'Some dependencies failed to install due to a network issue. Click "Refresh list" in Skill Settings to retry.',
            translate
        )).toBe('settings.skills.depInstallPartialFailed');
    });

    it('translates dependency failures with affected skill and packages', () => {
        expect(translateDependencyInstallResultMessage(
            'Dependency installation failed for skill "desktop-control" (pyautogui, pygetwindow). Click "Refresh list" in Skill Settings to retry.',
            translate
        )).toBe('settings.skills.depInstallFailedForSkillPackages:{"name":"desktop-control","packages":"pyautogui, pygetwindow"}');
    });
});
