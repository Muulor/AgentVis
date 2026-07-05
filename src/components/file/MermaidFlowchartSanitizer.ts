const FLOWCHART_RESERVED_NODE_IDS = ['style', 'class', 'classDef', 'click', 'linkStyle'];
const FLOWCHART_RESERVED_NODE_ID_SET = new Set<string>(FLOWCHART_RESERVED_NODE_IDS);
const FLOWCHART_GENERATED_SUBGRAPH_ID_PREFIX = 'subgraph_auto_';
const FLOWCHART_GENERATED_NODE_ID_PREFIX = 'flowchart_auto_node_';
const FLOWCHART_SAFE_SUBGRAPH_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

interface FlowchartOperatorMatch {
    value: string;
    kind: string;
}

interface FlowchartSubgraphOpenLine {
    indent: string;
    keyword: string;
    rest: string;
    suffix: string;
}

export function fixFlowchartReservedNodeIds(code: string): string {
    if (!isFlowchartLike(code)) return code;

    const lines = code.split('\n');
    const renames = collectReservedNodeRenames(lines);
    if (renames.size === 0) return code;

    return lines
        .map((line) => replaceReservedNodeIds(line, renames))
        .join('\n');
}

export function fixFlowchartRedundantPipeLabelLinkTails(code: string): string {
    if (!isFlowchartLike(code)) return code;

    // LLMs sometimes emit `A ---|label|--- B`. Mermaid expects the target
    // immediately after a pipe label when the left operator is already complete.
    // Keep valid split forms such as `A --|label|--> B` untouched.
    return code
        .split('\n')
        .map((line) => fixRedundantPipeLabelLinkTailInLine(line))
        .join('\n');
}

export function fixFlowchartDanglingPipeLabelLinks(code: string): string {
    if (!isFlowchartLike(code)) return code;

    const lines = code.split('\n');
    const usedIds = collectFlowchartDeclarationIds(lines);
    let nextIdIndex = 1;

    return lines
        .map((line) => {
            const fixed = fixDanglingPipeLabelLinkInLine(line, usedIds, nextIdIndex);
            nextIdIndex = fixed.nextIndex;
            return fixed.line;
        })
        .join('\n');
}

export function fixFlowchartPseudoSubgraphNodeDeclarations(code: string): string {
    if (!isFlowchartLike(code)) return code;

    const lines = code.split('\n');
    const matchedOpenLines = collectMatchedFlowchartSubgraphOpenLines(lines);

    const fixedLines = lines.map((line, index) => {
        const subgraphOpen = parseFlowchartSubgraphOpenLine(line);
        if (!subgraphOpen) return line;

        if (matchedOpenLines.has(index)) {
            if (subgraphOpen.keyword === 'subgraph') return line;

            return `${subgraphOpen.indent}subgraph ${subgraphOpen.rest}${subgraphOpen.suffix}`;
        }

        const nodeDeclaration = readPseudoSubgraphNodeDeclaration(subgraphOpen.rest);
        if (!nodeDeclaration) return line;

        return `${subgraphOpen.indent}${nodeDeclaration}${subgraphOpen.suffix}`;
    });

    return fixedLines.join('\n');
}

export function fixFlowchartUnsafeSubgraphTitles(code: string): string {
    if (!isFlowchartLike(code)) return code;

    const lines = code.split('\n');
    const usedIds = collectFlowchartDeclarationIds(lines);
    let nextIdIndex = 1;

    const fixedLines = lines.map((line) => {
        const match = /^(\s*)subgraph\s+(.+?)\s*$/.exec(line);
        const indent = match?.[1] ?? '';
        const title = match?.[2]?.trim();
        if (!title || isSafeFlowchartSubgraphDeclaration(title)) return line;

        const generated = makeUniqueFlowchartSubgraphId(usedIds, nextIdIndex);
        nextIdIndex = generated.nextIndex;
        const label = getUnsafeFlowchartSubgraphLabel(title);

        return `${indent}subgraph ${generated.id}["${sanitizeFlowchartFallbackLabel(label)}"]`;
    });

    return fixedLines.join('\n');
}

export function sanitizeFlowchartQuotedLabels(code: string): string {
    if (!isFlowchartLike(code)) return code;

    return code
        .split('\n')
        .map((line) => sanitizeFlowchartQuotedLabelsInLine(line))
        .join('\n');
}

export function quoteFlowchartNodeLabelsForFallback(code: string): string {
    if (!isFlowchartLike(code)) return code;

    const wrapSquare = code.replace(
        /\[([^"[\]\n][^[\]\n]*)]/g,
        (_match, label: string) => `["${sanitizeFlowchartFallbackLabel(label)}"]`
    );

    return wrapSquare.replace(
        /([A-Za-z0-9_]+)[{]([^"{}\n][^{}\n]*)[}]/g,
        (_match, nodeId: string, label: string) => `${nodeId}{"${sanitizeFlowchartFallbackLabel(label)}"}`
    );
}

export function sanitizeFlowchartFallbackLabel(label: string): string {
    return label
        .replace(/\\"/g, "'")
        .replace(/<br\s*\/?>/gi, '<br/>')
        .replace(/`([^`]*)`/g, "'$1'")
        .replace(/`/g, "'")
        .replace(/"/g, "'");
}

function isFlowchartLike(code: string): boolean {
    const firstContentLine = code
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('%%'));

    return firstContentLine ? /^(flowchart|graph)\b/i.test(firstContentLine) : false;
}

function collectMatchedFlowchartSubgraphOpenLines(lines: string[]): Set<number> {
    const openLineStack: number[] = [];
    const matchedOpenLines = new Set<number>();

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('%%')) return;

        if (parseFlowchartSubgraphOpenLine(line)) {
            openLineStack.push(index);
            return;
        }

        if (/^end\s*;?\s*$/i.test(trimmed)) {
            const openLineIndex = openLineStack.pop();
            if (openLineIndex !== undefined) matchedOpenLines.add(openLineIndex);
        }
    });

    return matchedOpenLines;
}

function parseFlowchartSubgraphOpenLine(line: string): FlowchartSubgraphOpenLine | null {
    const match = /^(\s*)(subgraph)\s+(.+?)(\s*;?\s*)$/i.exec(line);
    if (match?.[1] === undefined || !match[2] || !match[3] || match[4] === undefined) return null;

    return {
        indent: match[1],
        keyword: match[2],
        rest: match[3],
        suffix: match[4],
    };
}

function readPseudoSubgraphNodeDeclaration(rest: string): string | null {
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*((?:\[[^\n]+\]|\([^\n]+\)|\{[^\n]+}))$/.exec(rest.trim());
    if (!match?.[1] || !match[2]) return null;

    return `${match[1]}${match[2]}`;
}

function collectFlowchartDeclarationIds(lines: string[]): Set<string> {
    const ids = new Set<string>();
    const idPattern = /\b([A-Za-z][A-Za-z0-9_]*)\s*(?=[[{(>])/g;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('%%')) continue;

        const subgraphMatch = /^subgraph\s+([A-Za-z][A-Za-z0-9_]*)\b/.exec(trimmed);
        if (subgraphMatch?.[1]) ids.add(subgraphMatch[1]);

        let match: RegExpExecArray | null;
        while ((match = idPattern.exec(trimmed)) !== null) {
            if (match[1]) ids.add(match[1]);
        }
    }

    return ids;
}

function isSafeFlowchartSubgraphDeclaration(title: string): boolean {
    if (/^["'].*["']$/.test(title)) return true;

    const idMatch = /^([A-Za-z][A-Za-z0-9_-]*)(.*)$/.exec(title);
    if (!idMatch?.[1] || !FLOWCHART_SAFE_SUBGRAPH_ID_PATTERN.test(idMatch[1])) {
        return false;
    }

    const suffix = idMatch[2]?.trim() ?? '';
    return suffix.length === 0 || suffix.startsWith('[');
}

function getUnsafeFlowchartSubgraphLabel(title: string): string {
    const explicitLabel = readUnsafeFlowchartSubgraphBracketLabel(title);
    return explicitLabel ?? title;
}

function readUnsafeFlowchartSubgraphBracketLabel(title: string): string | null {
    const bracketStart = title.indexOf('[');
    if (bracketStart <= 0) return null;

    const rawId = title.slice(0, bracketStart).trim();
    const rawLabel = title.slice(bracketStart).trim();
    if (!rawId || /\s/.test(rawId) || !rawLabel.startsWith('[') || !rawLabel.endsWith(']')) {
        return null;
    }

    const label = rawLabel.slice(1, -1).trim();
    if (!label) return null;

    if (
        (label.startsWith('"') && label.endsWith('"'))
        || (label.startsWith("'") && label.endsWith("'"))
    ) {
        return label.slice(1, -1);
    }

    return label;
}

function sanitizeFlowchartQuotedLabelsInLine(line: string): string {
    return line
        .replace(
            /(\[")((?:\\.|[^"\\])*)("\])/g,
            (_match, open: string, label: string, close: string) =>
                `${open}${sanitizeFlowchartQuotedLabelContent(label)}${close}`
        )
        .replace(
            /(\{")((?:\\.|[^"\\])*)("\})/g,
            (_match, open: string, label: string, close: string) =>
                `${open}${sanitizeFlowchartQuotedLabelContent(label)}${close}`
        );
}

function sanitizeFlowchartQuotedLabelContent(label: string): string {
    return sanitizeFlowchartFallbackLabel(label);
}

function makeUniqueFlowchartSubgraphId(
    usedIds: Set<string>,
    startIndex: number
): { id: string; nextIndex: number } {
    return makeUniqueFlowchartGeneratedId(
        usedIds,
        FLOWCHART_GENERATED_SUBGRAPH_ID_PREFIX,
        startIndex
    );
}

function makeUniqueFlowchartNodeId(
    usedIds: Set<string>,
    startIndex: number
): { id: string; nextIndex: number } {
    return makeUniqueFlowchartGeneratedId(
        usedIds,
        FLOWCHART_GENERATED_NODE_ID_PREFIX,
        startIndex
    );
}

function makeUniqueFlowchartGeneratedId(
    usedIds: Set<string>,
    prefix: string,
    startIndex: number
): { id: string; nextIndex: number } {
    let index = startIndex;
    let id = `${prefix}${index}`;

    while (usedIds.has(id)) {
        index += 1;
        id = `${prefix}${index}`;
    }

    usedIds.add(id);
    return { id, nextIndex: index + 1 };
}

function collectReservedNodeRenames(lines: string[]): Map<string, string> {
    const renames = new Map<string, string>();

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('%%')) continue;
        if (isStyleDirective(trimmed) || isClassDirective(trimmed) || isClickDirective(trimmed)) continue;

        for (const id of FLOWCHART_RESERVED_NODE_IDS) {
            if (hasReservedNodeDefinition(line, id) || hasReservedSubgraphDefinition(line, id)) {
                renames.set(id, makeSafeNodeId(id));
            }
        }
    }

    return renames;
}

function hasReservedNodeDefinition(line: string, id: string): boolean {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(id)}\\s*(?=[\\[({>])`);
    return pattern.test(line);
}

function hasReservedSubgraphDefinition(line: string, id: string): boolean {
    const pattern = new RegExp(`^\\s*subgraph\\s+${escapeRegExp(id)}(?=\\s*(?:\\[|$))`);
    return pattern.test(line);
}

function replaceReservedNodeIds(line: string, renames: Map<string, string>): string {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('%%')) return line;
    if (/^(classDef|linkStyle)\b/.test(trimmed)) return line;
    if (isStyleDirective(trimmed)) return replaceDirectiveTarget(line, 'style', renames);
    if (isClassDirective(trimmed)) return replaceClassDirectiveTargets(line, renames);
    if (isClickDirective(trimmed)) return replaceDirectiveTarget(line, 'click', renames);

    return replaceIdsOutsideLabels(line, renames);
}

function fixRedundantPipeLabelLinkTailInLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) return line;

    let result = '';
    let index = 0;
    let quote: '"' | "'" | null = null;
    const labelStack: string[] = [];

    while (index < line.length) {
        const char = line.charAt(index);

        if (quote) {
            result += char;
            if (char === quote && line.charAt(index - 1) !== '\\') quote = null;
            index += 1;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            result += char;
            index += 1;
            continue;
        }

        const expectedClose = labelStack[labelStack.length - 1];
        if (expectedClose && char === expectedClose) {
            labelStack.pop();
            result += char;
            index += 1;
            continue;
        }

        if (expectedClose) {
            result += char;
            index += 1;
            continue;
        }

        const fixed = readRedundantPipeLabelTailFix(line, index);
        if (fixed) {
            result += fixed.text;
            index = fixed.nextIndex;
            continue;
        }

        const labelEnd = getLabelEnd(char);
        if (labelEnd) {
            labelStack.push(labelEnd);
        }

        result += char;
        index += 1;
    }

    return result;
}

function readRedundantPipeLabelTailFix(
    line: string,
    index: number
): { text: string; nextIndex: number } | null {
    const prefixOperator = readCompletePipeLabelOperatorAt(line, index);
    if (!prefixOperator) return null;

    const labelStart = skipInlineWhitespace(line, index + prefixOperator.value.length);
    if (line.charAt(labelStart) !== '|') return null;

    const labelEnd = findClosingPipe(line, labelStart + 1);
    if (labelEnd === -1) return null;

    const tailStart = skipInlineWhitespace(line, labelEnd + 1);
    const tailOperator = readCompletePipeLabelOperatorAt(line, tailStart);
    if (tailOperator?.kind !== prefixOperator.kind) return null;

    const nextIndex = tailStart + tailOperator.value.length;
    return {
        text: line.slice(index, tailStart),
        nextIndex,
    };
}

function fixDanglingPipeLabelLinkInLine(
    line: string,
    usedIds: Set<string>,
    nextIdIndex: number
): { line: string; nextIndex: number } {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) {
        return { line, nextIndex: nextIdIndex };
    }

    let index = 0;
    let quote: '"' | "'" | null = null;
    const labelStack: string[] = [];

    while (index < line.length) {
        const char = line.charAt(index);

        if (quote) {
            if (char === quote && line.charAt(index - 1) !== '\\') quote = null;
            index += 1;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            index += 1;
            continue;
        }

        const expectedClose = labelStack[labelStack.length - 1];
        if (expectedClose && char === expectedClose) {
            labelStack.pop();
            index += 1;
            continue;
        }

        if (expectedClose) {
            index += 1;
            continue;
        }

        const fixed = readDanglingPipeLabelLinkFix(line, index, usedIds, nextIdIndex);
        if (fixed) return fixed;

        const labelEnd = getLabelEnd(char);
        if (labelEnd) {
            labelStack.push(labelEnd);
        }

        index += 1;
    }

    return { line, nextIndex: nextIdIndex };
}

function readDanglingPipeLabelLinkFix(
    line: string,
    index: number,
    usedIds: Set<string>,
    nextIdIndex: number
): { line: string; nextIndex: number } | null {
    const prefixOperator = readCompletePipeLabelOperatorAt(line, index);
    if (!prefixOperator) return null;

    const labelStart = skipInlineWhitespace(line, index + prefixOperator.value.length);
    if (line.charAt(labelStart) !== '|') return null;

    const labelEnd = findClosingPipe(line, labelStart + 1);
    if (labelEnd === -1) return null;

    const tail = line.slice(labelEnd + 1).trim();
    const trailingSemicolon = tail === ';';
    if (tail.length > 0 && !trailingSemicolon) return null;

    const generated = makeUniqueFlowchartNodeId(usedIds, nextIdIndex);
    const label = line.slice(labelStart + 1, labelEnd).trim();
    const sanitizedLabel = sanitizeFlowchartFallbackLabel(label);
    const prefix = line.slice(0, index + prefixOperator.value.length).trimEnd();

    return {
        line: `${prefix} ${generated.id}["${sanitizedLabel}"]${trailingSemicolon ? ';' : ''}`,
        nextIndex: generated.nextIndex,
    };
}

function readCompletePipeLabelOperatorAt(line: string, index: number): FlowchartOperatorMatch | null {
    const slice = line.slice(index);
    const match = /^(<[-]+>|<[-]+|[-]+>|[-]{3,}|[=]+>|[=]{3,}|-\.->|-\.-|o--o|x--x)/.exec(slice);
    const value = match?.[0];
    if (!value) return null;

    const kind = getCompletePipeLabelOperatorKind(value);
    return kind ? { value, kind } : null;
}

function getCompletePipeLabelOperatorKind(value: string): string | null {
    if (/^<-+>$/.test(value)) return 'normal-bidirectional';
    if (/^<-+$/.test(value)) return 'normal-backward';
    if (/^-+>$/.test(value)) return 'normal-forward';
    if (/^-{3,}$/.test(value)) return 'normal-open';
    if (/^=+>$/.test(value)) return 'thick-forward';
    if (/^={3,}$/.test(value)) return 'thick-open';
    if (value === '-.->') return 'dotted-forward';
    if (value === '-.-') return 'dotted-open';
    if (value === 'o--o') return 'circle-bidirectional';
    if (value === 'x--x') return 'cross-bidirectional';
    return null;
}

function skipInlineWhitespace(line: string, index: number): number {
    let cursor = index;
    while (cursor < line.length && /\s/.test(line.charAt(cursor))) {
        cursor += 1;
    }
    return cursor;
}

function findClosingPipe(line: string, index: number): number {
    let cursor = index;
    while (cursor < line.length) {
        if (line.charAt(cursor) === '|' && line.charAt(cursor - 1) !== '\\') {
            return cursor;
        }
        cursor += 1;
    }
    return -1;
}

function replaceDirectiveTarget(line: string, directive: 'style' | 'click', renames: Map<string, string>): string {
    const pattern = new RegExp(`^(\\s*${directive}\\s+)([A-Za-z][A-Za-z0-9_]*)\\b`);
    return line.replace(pattern, (full, prefix: string, id: string) => {
        const replacement = renames.get(id);
        return replacement ? `${prefix}${replacement}` : full;
    });
}

function replaceClassDirectiveTargets(line: string, renames: Map<string, string>): string {
    const pattern = /^(\s*class\s+)([A-Za-z0-9_,\s]+)(\s+\S.*)$/;
    return line.replace(pattern, (_full, prefix: string, ids: string, suffix: string) => {
        const replacedIds = ids.replace(/[A-Za-z][A-Za-z0-9_]*/g, (id) => renames.get(id) ?? id);
        return `${prefix}${replacedIds}${suffix}`;
    });
}

function replaceIdsOutsideLabels(line: string, renames: Map<string, string>): string {
    let result = '';
    let index = 0;
    let quote: '"' | "'" | null = null;
    const labelStack: string[] = [];

    while (index < line.length) {
        const char = line.charAt(index);

        if (quote) {
            result += char;
            if (char === quote && line.charAt(index - 1) !== '\\') quote = null;
            index += 1;
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            result += char;
            index += 1;
            continue;
        }

        const expectedClose = labelStack[labelStack.length - 1];
        if (expectedClose && char === expectedClose) {
            labelStack.pop();
            result += char;
            index += 1;
            continue;
        }

        if (expectedClose) {
            result += char;
            index += 1;
            continue;
        }

        const word = /^[A-Za-z][A-Za-z0-9_]*/.exec(line.slice(index))?.[0];
        if (word) {
            const replacement = renames.get(word);
            result += replacement ?? word;
            index += word.length;
            continue;
        }

        const labelEnd = getLabelEnd(char);
        if (labelEnd) {
            labelStack.push(labelEnd);
        }

        result += char;
        index += 1;
    }

    return result;
}

function getLabelEnd(char: string): string | null {
    if (char === '[') return ']';
    if (char === '(') return ')';
    if (char === '{') return '}';
    return null;
}

function isStyleDirective(trimmed: string): boolean {
    return /^style\s+/.test(trimmed);
}

function isClassDirective(trimmed: string): boolean {
    return /^class\s+/.test(trimmed);
}

function isClickDirective(trimmed: string): boolean {
    return /^click\s+/.test(trimmed);
}

function makeSafeNodeId(id: string): string {
    return FLOWCHART_RESERVED_NODE_ID_SET.has(id) ? `${id}_node` : id;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
