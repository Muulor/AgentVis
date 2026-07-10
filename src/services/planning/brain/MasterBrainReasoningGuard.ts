/**
 * MasterBrainReasoningGuard - detects stalled MB reasoning streams and keeps
 * their live UI preview bounded independently from the model output budget.
 */

export interface MbReasoningGuardConfig {
    softEstimatedTokens: number;
    softDurationMs: number;
    hardEstimatedTokens: number;
    hardDurationMs: number;
    detectionWindowChars: number;
    exactCheckStepChars: number;
    approximateCheckStepChars: number;
    previewHeadChars: number;
    previewTailChars: number;
}

export interface MbReasoningGuardMetrics {
    totalChars: number;
    estimatedTokens: number;
    elapsedMs: number;
    phase: 'normal' | 'soft';
}

export interface MbReasoningLoopEvidence {
    kind: 'exact_cycle' | 'approximate_stall';
    detail: string;
    periodChars?: number;
    repeatedChars?: number;
    noveltyRatio?: number;
    similarity?: number;
}

export type MbReasoningGuardResult =
    | {
        action: 'continue';
        softEntered: boolean;
        metrics: MbReasoningGuardMetrics;
    }
    | {
        action: 'retry';
        reason: 'exact_cycle' | 'approximate_stall';
        evidence: MbReasoningLoopEvidence;
        metrics: MbReasoningGuardMetrics;
    }
    | {
        action: 'abort';
        reason: 'hard_token_fuse' | 'hard_time_fuse';
        metrics: MbReasoningGuardMetrics;
    };

export type MbReasoningPreview =
    | {
        truncated: false;
        content: string;
        totalChars: number;
        omittedChars: 0;
    }
    | {
        truncated: true;
        head: string;
        tail: string;
        totalChars: number;
        omittedChars: number;
    };

interface ExactCycleMatch {
    periodChars: number;
    repeatedChars: number;
    repetitions: number;
}

interface ApproximateMetrics {
    noveltyRatio: number;
    maxDiceSimilarity: number;
}

const CJK_CHARACTER_PATTERN =
    /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;
const EXACT_MIN_REPEATED_CHARS = 1024;
const EXACT_MAX_PERIOD_CHARS = 4096;
const EXACT_MIN_REPETITIONS = 4;
const APPROXIMATE_LATEST_CHARS = 2048;
const APPROXIMATE_SHINGLE_CHARS = 24;
const APPROXIMATE_SHINGLE_STRIDE = 1;
const APPROXIMATE_HISTORY_STEP_CHARS = 512;
const APPROXIMATE_NOVELTY_MAX = 0.08;
const APPROXIMATE_NOVEL_PROGRESS_MIN = 0.20;
const APPROXIMATE_SIMILARITY_MIN = 0.90;
const APPROXIMATE_STREAK_MIN = 3;
const APPROXIMATE_STAGNATION_MS = 30000;

export class MbEstimatedTokenCounter {
    private cjkCharacterCount = 0;
    private otherCharacterCount = 0;

    append(content: string): void {
        if (!content) return;
        const cjkCharacters = content.match(CJK_CHARACTER_PATTERN)?.length ?? 0;
        this.cjkCharacterCount += cjkCharacters;
        this.otherCharacterCount += content.length - cjkCharacters;
    }

    get estimatedTokens(): number {
        return Math.ceil(this.cjkCharacterCount / 1.5) +
            Math.ceil(this.otherCharacterCount / 4);
    }
}

function clampNow(nowMs: number, previousNowMs: number): number {
    return Math.max(previousNowMs, nowMs);
}

function normalizeForDetection(content: string): string {
    return content
        .normalize('NFKC')
        .replace(/\r\n?/g, '\n')
        .replace(/[\t\f\v ]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n');
}

function buildPrefixTable(content: string[]): number[] {
    const prefix = new Array<number>(content.length).fill(0);
    for (let index = 1; index < content.length; index++) {
        let candidate = prefix[index - 1] ?? 0;
        while (candidate > 0 && content[index] !== content[candidate]) {
            candidate = prefix[candidate - 1] ?? 0;
        }
        if (content[index] === content[candidate]) {
            candidate++;
        }
        prefix[index] = candidate;
    }
    return prefix;
}

function findExactPeriodicSuffix(content: string): ExactCycleMatch | null {
    const normalized = normalizeForDetection(content);
    const reversed = Array.from(normalized).reverse();
    if (reversed.length < EXACT_MIN_REPEATED_CHARS) {
        return null;
    }

    const prefix = buildPrefixTable(reversed);
    for (let repeatedChars = reversed.length; repeatedChars >= EXACT_MIN_REPEATED_CHARS; repeatedChars--) {
        const borderLength = prefix[repeatedChars - 1] ?? 0;
        const periodChars = repeatedChars - borderLength;
        if (
            periodChars <= 0 ||
            periodChars > EXACT_MAX_PERIOD_CHARS ||
            repeatedChars % periodChars !== 0
        ) {
            continue;
        }

        const repetitions = repeatedChars / periodChars;
        if (repetitions >= EXACT_MIN_REPETITIONS) {
            return { periodChars, repeatedChars, repetitions };
        }
    }

    return null;
}

function createShingles(content: string): Set<string> {
    const shingles = new Set<string>();
    if (content.length < APPROXIMATE_SHINGLE_CHARS) {
        return shingles;
    }

    for (
        let index = 0;
        index <= content.length - APPROXIMATE_SHINGLE_CHARS;
        index += APPROXIMATE_SHINGLE_STRIDE
    ) {
        shingles.add(content.slice(index, index + APPROXIMATE_SHINGLE_CHARS));
    }
    return shingles;
}

function diceSimilarity(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) {
        return 0;
    }

    let intersection = 0;
    for (const item of left) {
        if (right.has(item)) intersection++;
    }
    return (2 * intersection) / (left.size + right.size);
}

function measureApproximateRepetition(content: string): ApproximateMetrics | null {
    const normalized = normalizeForDetection(content);
    if (normalized.length < APPROXIMATE_LATEST_CHARS * 2) {
        return null;
    }

    const latest = normalized.slice(-APPROXIMATE_LATEST_CHARS);
    const history = normalized.slice(0, -APPROXIMATE_LATEST_CHARS);
    const latestShingles = createShingles(latest);
    const historyShingles = createShingles(history);
    if (latestShingles.size === 0 || historyShingles.size === 0) {
        return null;
    }

    let novelShingles = 0;
    for (const shingle of latestShingles) {
        if (!historyShingles.has(shingle)) novelShingles++;
    }
    const noveltyRatio = novelShingles / latestShingles.size;

    let maxDiceSimilarity = 0;
    for (
        let start = 0;
        start <= history.length - APPROXIMATE_LATEST_CHARS;
        start += APPROXIMATE_HISTORY_STEP_CHARS
    ) {
        const historicalWindow = history.slice(start, start + APPROXIMATE_LATEST_CHARS);
        maxDiceSimilarity = Math.max(
            maxDiceSimilarity,
            diceSimilarity(latestShingles, createShingles(historicalWindow))
        );
    }

    return { noveltyRatio, maxDiceSimilarity };
}

function safePrefix(content: string, maxChars: number): string {
    let end = Math.min(maxChars, content.length);
    if (
        end > 0 &&
        end < content.length &&
        /[\uD800-\uDBFF]/.test(content.charAt(end - 1)) &&
        /[\uDC00-\uDFFF]/.test(content.charAt(end))
    ) {
        end--;
    }
    return content.slice(0, end);
}

function safeSuffix(content: string, maxChars: number): string {
    let start = Math.max(0, content.length - maxChars);
    if (
        start > 0 &&
        start < content.length &&
        /[\uDC00-\uDFFF]/.test(content.charAt(start)) &&
        /[\uD800-\uDBFF]/.test(content.charAt(start - 1))
    ) {
        start++;
    }
    return content.slice(start);
}

export class BoundedReasoningPreview {
    private readonly maxChars: number;
    private fullContent = '';
    private head = '';
    private tail = '';
    private totalChars = 0;
    private truncated = false;

    constructor(
        private readonly headChars: number,
        private readonly tailChars: number,
    ) {
        this.maxChars = headChars + tailChars;
    }

    append(content: string): void {
        if (!content) return;
        this.totalChars += content.length;

        if (!this.truncated) {
            const combined = this.fullContent + content;
            if (combined.length <= this.maxChars) {
                this.fullContent = combined;
                return;
            }

            this.truncated = true;
            this.head = safePrefix(combined, this.headChars);
            this.tail = safeSuffix(combined, this.tailChars);
            this.fullContent = '';
            return;
        }

        this.tail = safeSuffix(this.tail + content, this.tailChars);
    }

    snapshot(): MbReasoningPreview {
        if (!this.truncated) {
            return {
                truncated: false,
                content: this.fullContent,
                totalChars: this.totalChars,
                omittedChars: 0,
            };
        }

        return {
            truncated: true,
            head: this.head,
            tail: this.tail,
            totalChars: this.totalChars,
            omittedChars: Math.max(0, this.totalChars - this.head.length - this.tail.length),
        };
    }
}

export class MasterBrainReasoningGuard {
    private readonly preview: BoundedReasoningPreview;
    private readonly tokenCounter = new MbEstimatedTokenCounter();
    private detectionWindow = '';
    private totalChars = 0;
    private startedAt: number | null = null;
    private lastNowMs = 0;
    private lastNovelProgressAt: number | null = null;
    private lastExactCheckChars = 0;
    private lastApproximateCheckChars = 0;
    private approximateLowNoveltyStreak = 0;
    private softPhaseEntered = false;

    constructor(private readonly config: MbReasoningGuardConfig) {
        this.preview = new BoundedReasoningPreview(
            config.previewHeadChars,
            config.previewTailChars,
        );
    }

    appendReasoning(content: string, nowMs: number): MbReasoningGuardResult {
        const now = this.normalizeNow(nowMs);
        if (content && this.startedAt === null) {
            this.startedAt = now;
            this.lastNovelProgressAt = now;
        }

        if (content) {
            this.totalChars += content.length;
            this.tokenCounter.append(content);
            this.preview.append(content);
            this.detectionWindow = safeSuffix(
                this.detectionWindow + content,
                this.config.detectionWindowChars,
            );
        }

        const softEntered = this.updateSoftPhase(now);
        const metrics = this.getMetrics(now);
        if (metrics.estimatedTokens >= this.config.hardEstimatedTokens) {
            return { action: 'abort', reason: 'hard_token_fuse', metrics };
        }
        if (
            this.startedAt !== null &&
            metrics.elapsedMs >= this.config.hardDurationMs
        ) {
            return { action: 'abort', reason: 'hard_time_fuse', metrics };
        }

        if (
            content &&
            this.totalChars - this.lastExactCheckChars >= this.config.exactCheckStepChars
        ) {
            this.lastExactCheckChars = this.totalChars;
            const exactCycle = findExactPeriodicSuffix(this.detectionWindow);
            if (exactCycle) {
                return {
                    action: 'retry',
                    reason: 'exact_cycle',
                    evidence: {
                        kind: 'exact_cycle',
                        detail: `exact periodic reasoning suffix detected (period=${exactCycle.periodChars}, repetitions=${exactCycle.repetitions}, repeatedChars=${exactCycle.repeatedChars})`,
                        periodChars: exactCycle.periodChars,
                        repeatedChars: exactCycle.repeatedChars,
                    },
                    metrics,
                };
            }
        }

        if (
            content &&
            this.totalChars - this.lastApproximateCheckChars >=
                this.config.approximateCheckStepChars
        ) {
            this.lastApproximateCheckChars = this.totalChars;
            const approximate = measureApproximateRepetition(this.detectionWindow);
            if (approximate) {
                const lowNovelty =
                    approximate.noveltyRatio <= APPROXIMATE_NOVELTY_MAX &&
                    approximate.maxDiceSimilarity >= APPROXIMATE_SIMILARITY_MIN;

                if (approximate.noveltyRatio >= APPROXIMATE_NOVEL_PROGRESS_MIN) {
                    this.lastNovelProgressAt = now;
                    this.approximateLowNoveltyStreak = 0;
                } else if (lowNovelty) {
                    this.approximateLowNoveltyStreak++;
                } else {
                    this.approximateLowNoveltyStreak = 0;
                }

                if (
                    this.softPhaseEntered &&
                    lowNovelty &&
                    this.approximateLowNoveltyStreak >= APPROXIMATE_STREAK_MIN &&
                    now - (this.lastNovelProgressAt ?? now) >= APPROXIMATE_STAGNATION_MS
                ) {
                    return {
                        action: 'retry',
                        reason: 'approximate_stall',
                        evidence: {
                            kind: 'approximate_stall',
                            detail: `approximate reasoning loop detected (novelty=${approximate.noveltyRatio.toFixed(3)}, similarity=${approximate.maxDiceSimilarity.toFixed(3)})`,
                            noveltyRatio: approximate.noveltyRatio,
                            similarity: approximate.maxDiceSimilarity,
                        },
                        metrics,
                    };
                }
            }
        }

        return { action: 'continue', softEntered, metrics };
    }

    noteFinalDelta(content: string, nowMs: number): void {
        if (!content.trim()) return;
        const now = this.normalizeNow(nowMs);
        this.lastNovelProgressAt = now;
        this.approximateLowNoveltyStreak = 0;
    }

    evaluateTime(nowMs: number): MbReasoningGuardResult {
        const now = this.normalizeNow(nowMs);
        const softEntered = this.updateSoftPhase(now);
        const metrics = this.getMetrics(now);
        if (
            this.startedAt !== null &&
            metrics.elapsedMs >= this.config.hardDurationMs
        ) {
            return { action: 'abort', reason: 'hard_time_fuse', metrics };
        }
        return { action: 'continue', softEntered, metrics };
    }

    getPreview(): MbReasoningPreview {
        return this.preview.snapshot();
    }

    getMetrics(nowMs: number): MbReasoningGuardMetrics {
        const now = this.normalizeNow(nowMs);
        return {
            totalChars: this.totalChars,
            estimatedTokens: this.estimateTokens(),
            elapsedMs: this.startedAt === null ? 0 : Math.max(0, now - this.startedAt),
            phase: this.softPhaseEntered ? 'soft' : 'normal',
        };
    }

    private normalizeNow(nowMs: number): number {
        this.lastNowMs = clampNow(nowMs, this.lastNowMs);
        return this.lastNowMs;
    }

    private estimateTokens(): number {
        return this.tokenCounter.estimatedTokens;
    }

    private updateSoftPhase(nowMs: number): boolean {
        if (this.softPhaseEntered) return false;

        const estimatedTokens = this.estimateTokens();
        const elapsedMs = this.startedAt === null ? 0 : Math.max(0, nowMs - this.startedAt);
        if (
            estimatedTokens < this.config.softEstimatedTokens &&
            elapsedMs < this.config.softDurationMs
        ) {
            return false;
        }

        this.softPhaseEntered = true;
        return true;
    }
}
