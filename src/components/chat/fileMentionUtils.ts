import { compactSkillSearchText, normalizeSkillSearchText } from './skillSlashUtils';

export interface FileMentionOption {
    id: string;
    kind: 'file' | 'folder';
    label: string;
    path: string;
    relativePath: string;
    size?: number;
}

export interface FileMentionTrigger {
    start: number;
    end: number;
    query: string;
}

export function findFileMentionTrigger(text: string, cursorPosition: number): FileMentionTrigger | null {
    const beforeCursor = text.slice(0, cursorPosition);
    const atIndex = beforeCursor.lastIndexOf('@');

    if (atIndex === -1) {
        return null;
    }

    if (atIndex > 0 && !/\s/.test(beforeCursor[atIndex - 1] ?? '')) {
        return null;
    }

    const query = beforeCursor.slice(atIndex + 1);
    if (/\s/.test(query)) {
        return null;
    }

    return {
        start: atIndex,
        end: cursorPosition,
        query,
    };
}

export function filterFileMentionOptions(
    files: FileMentionOption[],
    query: string,
    limit = 50
): FileMentionOption[] {
    const canonicalQuery = normalizeSkillSearchText(query);
    const compactQuery = compactSkillSearchText(query);
    const candidates = !canonicalQuery && !compactQuery
        ? files
        : files.filter((file) => {
            const searchable = `${file.label} ${file.relativePath}`;
            const canonical = normalizeSkillSearchText(searchable);
            const compact = compactSkillSearchText(searchable);

            return canonical.includes(canonicalQuery) || compact.includes(compactQuery);
        });

    return candidates.slice(0, limit);
}

export function getFileMentionLabel(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
