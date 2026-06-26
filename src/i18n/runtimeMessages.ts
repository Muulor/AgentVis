import type { TranslationKey } from './index';

type TranslationParams = Record<string, string | number | boolean | null | undefined>;
type Translate = (key: TranslationKey, params?: TranslationParams) => string;

const u = (value: string): string => value.replace(/\\u([0-9a-fA-F]{4})/g, (_match: string, code: string) => {
    return String.fromCharCode(Number.parseInt(code, 16));
});

const PHASE_KEY_BY_TEXT: Record<string, TranslationKey> = {
    'Preparing environment installation': 'runtime.progress.prepareInstall',
    'Checking Python installation': 'runtime.progress.checkPython',
    'Checking environment': 'runtime.progress.checkEnvironment',
    'Preparing packaged Python environment': 'runtime.progress.preparePrebuiltRuntime',
    'Creating virtual environment': 'runtime.progress.createVenv',
    'Base dependencies installed': 'runtime.progress.baseComplete',
    'Verifying packaged base dependencies': 'runtime.progress.verifyBaseRuntime',
    'Installing extra dependencies': 'runtime.progress.installExtraDeps',
    'Installing skill dependencies': 'runtime.progress.installSkillExtraDeps',
    'Verifying environment': 'runtime.progress.verifyEnvironment',
    'Environment ready': 'runtime.progress.ready',
    'Removing old environment': 'runtime.progress.removeOldEnvironment',
    [u('\\u51c6\\u5907\\u5b89\\u88c5\\u73af\\u5883')]: 'runtime.progress.prepareInstall',
    [u('\\u68c0\\u67e5 Python \\u5b89\\u88c5')]: 'runtime.progress.checkPython',
    [u('\\u68c0\\u67e5\\u73af\\u5883')]: 'runtime.progress.checkEnvironment',
    [u('\\u51c6\\u5907\\u9884\\u7f6e Python \\u73af\\u5883')]: 'runtime.progress.preparePrebuiltRuntime',
    [u('\\u521b\\u5efa\\u865a\\u62df\\u73af\\u5883')]: 'runtime.progress.createVenv',
    [u('\\u6821\\u9a8c\\u9884\\u7f6e\\u57fa\\u7840\\u4f9d\\u8d56')]: 'runtime.progress.verifyBaseRuntime',
    [u('\\u57fa\\u7840\\u4f9d\\u8d56\\u5b8c\\u6210')]: 'runtime.progress.baseComplete',
    [u('\\u5b89\\u88c5\\u989d\\u5916\\u4f9d\\u8d56')]: 'runtime.progress.installExtraDeps',
    [u('\\u5b89\\u88c5\\u6280\\u80fd\\u989d\\u5916\\u4f9d\\u8d56')]: 'runtime.progress.installSkillExtraDeps',
    [u('\\u9a8c\\u8bc1\\u73af\\u5883')]: 'runtime.progress.verifyEnvironment',
    [u('\\u73af\\u5883\\u5c31\\u7eea')]: 'runtime.progress.ready',
    [u('\\u5220\\u9664\\u65e7\\u73af\\u5883')]: 'runtime.progress.removeOldEnvironment',
};

const BASE_BATCH_PATTERNS = [
    /^Installing base packages\s+(\d+-\d+)\/(\d+):\s*(.+)$/i,
    /^\u5b89\u88c5\u57fa\u7840\u5305\s+(\d+-\d+)\/(\d+):\s*(.+)$/,
];

const EXTRA_BATCH_PATTERNS = [
    /^Installing extra dependencies\s+(\d+-\d+)\/(\d+):\s*(.+)$/i,
    /^\u5b89\u88c5\u989d\u5916\u4f9d\u8d56\s+(\d+-\d+)\/(\d+):\s*(.+)$/,
];

const LEGACY_PARTIAL_FAILED = u('\\u90e8\\u5206\\u4f9d\\u8d56\\u5b89\\u88c5\\u5931\\u8d25\\uff08\\u7f51\\u7edc\\u95ee\\u9898\\uff09\\uff0c\\u8bf7\\u5728\\u300c\\u6280\\u80fd\\u8bbe\\u7f6e\\u300d\\u4e2d\\u70b9\\u51fb\\u300c\\u5237\\u65b0\\u5217\\u8868\\u300d\\u91cd\\u8bd5');
const LEGACY_NETWORK_FAILED = u('\\u4f9d\\u8d56\\u5b89\\u88c5\\u5931\\u8d25\\uff08\\u53ef\\u80fd\\u662f\\u7f51\\u7edc\\u95ee\\u9898\\uff09\\uff0c\\u8bf7\\u5728\\u300c\\u6280\\u80fd\\u8bbe\\u7f6e\\u300d\\u4e2d\\u70b9\\u51fb\\u300c\\u5237\\u65b0\\u5217\\u8868\\u300d\\u91cd\\u8bd5');
const LEGACY_TIMEOUT = u('\\u6280\\u80fd\\u4f9d\\u8d56\\u5b89\\u88c5\\u8d85\\u65f6\\uff0c\\u8bf7\\u5728\\u300c\\u6280\\u80fd\\u8bbe\\u7f6e\\u300d\\u4e2d\\u70b9\\u51fb\\u300c\\u5237\\u65b0\\u5217\\u8868\\u300d\\u91cd\\u8bd5');

function matchAny(value: string, patterns: RegExp[]): RegExpMatchArray | null {
    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (match) {
            return match;
        }
    }
    return null;
}

export function translateRuntimeProgressPhase(phase: string, t: Translate): string {
    const normalizedPhase = phase.trim();
    const exactKey = PHASE_KEY_BY_TEXT[normalizedPhase];
    if (exactKey) {
        return t(exactKey);
    }

    const baseBatch = matchAny(normalizedPhase, BASE_BATCH_PATTERNS);
    if (baseBatch) {
        return t('runtime.progress.installBaseBatch', {
            range: baseBatch[1],
            total: baseBatch[2],
            packages: baseBatch[3],
        });
    }

    const extraBatch = matchAny(normalizedPhase, EXTRA_BATCH_PATTERNS);
    if (extraBatch) {
        return t('runtime.progress.installExtraBatch', {
            range: extraBatch[1],
            total: extraBatch[2],
            packages: extraBatch[3],
        });
    }

    return phase;
}

export function translateDependencyInstallResultMessage(message: string, t: Translate): string {
    const normalizedMessage = message.trim();

    let match = matchAny(normalizedMessage, [
        /^Dependencies for skill "(.+)" installed successfully \((\d+) packages?\)$/i,
        /^Dependencies for "(.+)" installed \((\d+) packages?\)$/i,
        /^\u6280\u80fd "(.+)" \u7684\u4f9d\u8d56\u5b89\u88c5\u5b8c\u6210\uff08(\d+) \u4e2a\u5305\uff09$/,
    ]);
    if (match) {
        return t('settings.skills.depInstallCompleteForSkill', {
            name: match[1],
            count: match[2],
        });
    }

    match = matchAny(normalizedMessage, [
        /^Dependencies installed successfully \((\d+) packages?\)$/i,
        /^Dependencies installed \((\d+) packages?\)$/i,
        /^\u4f9d\u8d56\u5b89\u88c5\u5b8c\u6210\uff08(\d+) \u4e2a\u5305\uff09$/,
    ]);
    if (match) {
        return t('settings.skills.depInstallComplete', { count: match[1] });
    }

    match = matchAny(normalizedMessage, [
        /^Dependency installation failed for skill "(.+)" \((.+)\)\. Click "Refresh List" in Skill settings to retry\.$/i,
    ]);
    if (match) {
        return t('settings.skills.depInstallFailedForSkillPackages', {
            name: match[1],
            packages: match[2],
        });
    }

    match = matchAny(normalizedMessage, [
        /^Dependency installation failed \((.+)\)\. Click "Refresh List" in Skill settings to retry\.$/i,
    ]);
    if (match) {
        return t('settings.skills.depInstallFailedPackages', {
            packages: match[1],
        });
    }

    match = matchAny(normalizedMessage, [
        /^Dependency installation for skill "(.+)" failed due to a network issue\. Click "Refresh List" in Skill settings to retry\.$/i,
        /^Dependency installation failed for "(.+)" due to a network issue\. Click "Refresh List" in Skill settings to retry\.$/i,
        /^\u6280\u80fd "(.+)" \u7684\u4f9d\u8d56\u5b89\u88c5\u5931\u8d25\uff08\u7f51\u7edc\u95ee\u9898\uff09\uff0c\u8bf7\u5728\u300c\u6280\u80fd\u8bbe\u7f6e\u300d\u4e2d\u70b9\u51fb\u300c\u5237\u65b0\u5217\u8868\u300d\u91cd\u8bd5$/,
    ]);
    if (match) {
        return t('settings.skills.depInstallFailedForSkill', { name: match[1] });
    }

    if (
        /^Some dependencies failed to install due to a network issue\. Click "Refresh List" in Skill settings to retry\.$/i.test(normalizedMessage) ||
        normalizedMessage === LEGACY_PARTIAL_FAILED
    ) {
        return t('settings.skills.depInstallPartialFailed');
    }

    if (
        /^Dependency installation failed, possibly due to a network issue\. Click "Refresh List" in Skill settings to retry\.$/i.test(normalizedMessage) ||
        normalizedMessage === LEGACY_NETWORK_FAILED
    ) {
        return t('settings.skills.depInstallFailedMaybeNetwork');
    }

    match = matchAny(normalizedMessage, [
        /^Dependency installation for skill "(.+)" timed out\. Click "Refresh List" in Skill settings to retry\.$/i,
        /^Dependency installation for "(.+)" timed out\. Click "Refresh List" in Skill settings to retry\.$/i,
        /^\u6280\u80fd "(.+)" \u7684\u4f9d\u8d56\u5b89\u88c5\u8d85\u65f6\uff0c\u8bf7\u5728\u300c\u6280\u80fd\u8bbe\u7f6e\u300d\u4e2d\u70b9\u51fb\u300c\u5237\u65b0\u5217\u8868\u300d\u91cd\u8bd5$/,
    ]);
    if (match) {
        return t('settings.skills.depInstallTimeoutForSkill', { name: match[1] });
    }

    if (
        /^Skill dependency installation timed out\. Click "Refresh List" in Skill settings to retry\.$/i.test(normalizedMessage) ||
        normalizedMessage === LEGACY_TIMEOUT
    ) {
        return t('settings.skills.depInstallTimeout');
    }

    return message;
}
