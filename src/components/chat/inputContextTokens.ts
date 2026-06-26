export type InputContextTokenType = 'skill' | 'file' | 'folder';

export interface InputContextToken {
    id: string;
    type: InputContextTokenType;
    label: string;
    description?: string;
    path?: string;
    relativePath?: string;
    badge?: string;
    semanticText?: string;
}

export type InputDisplayPart =
    | { type: 'text'; text: string }
    | { type: 'token'; token: InputContextToken };

export interface SerializedInputContext {
    displayContent: string;
    displayParts: InputDisplayPart[];
    contextTokens: InputContextToken[];
}

export function appendUniqueContextToken(
    tokens: InputContextToken[],
    token: InputContextToken
): InputContextToken[] {
    if (tokens.some(existing => existing.id === token.id)) {
        return tokens;
    }
    return [...tokens, token];
}

export function removeContextToken(
    tokens: InputContextToken[],
    tokenId: string
): InputContextToken[] {
    return tokens.filter(token => token.id !== tokenId);
}

export function buildContextTokenPrefix(tokens: InputContextToken[]): string {
    return tokens
        .map(token => token.semanticText?.trim() ?? '')
        .filter(Boolean)
        .join(' ');
}

export function buildDisplayContent(parts: InputDisplayPart[]): string {
    return parts
        .map(part => part.type === 'text' ? part.text : part.token.label)
        .join('');
}
