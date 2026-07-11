export interface SkillSlashOption {
  name: string;
  description?: string;
  enabled?: boolean;
  mode?: 'guide' | 'script';
  packagePath?: string;
}

export interface SkillSlashTrigger {
  start: number;
  end: number;
  query: string;
}

export function findSkillSlashTrigger(
  text: string,
  cursorPosition: number
): SkillSlashTrigger | null {
  const beforeCursor = text.slice(0, cursorPosition);
  const slashIndex = beforeCursor.lastIndexOf('/');

  if (slashIndex === -1) {
    return null;
  }

  if (slashIndex > 0 && !/\s/.test(beforeCursor[slashIndex - 1] ?? '')) {
    return null;
  }

  const query = beforeCursor.slice(slashIndex + 1);
  if (/\s/.test(query)) {
    return null;
  }

  return {
    start: slashIndex,
    end: cursorPosition,
    query,
  };
}

export function normalizeSkillSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/([\u3400-\u9FFF])([a-z0-9])/g, '$1 $2')
    .replace(/([a-z0-9])([\u3400-\u9FFF])/g, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function compactSkillSearchText(text: string): string {
  return normalizeSkillSearchText(text).replace(/\s+/g, '');
}

export function filterSkillSlashOptions(
  skills: SkillSlashOption[],
  query: string,
  limit?: number
): SkillSlashOption[] {
  const enabledSkills = skills.filter((skill) => skill.enabled !== false);

  const canonicalQuery = normalizeSkillSearchText(query);
  const compactQuery = compactSkillSearchText(query);

  if (!canonicalQuery && !compactQuery) {
    return typeof limit === 'number' ? enabledSkills.slice(0, limit) : enabledSkills;
  }

  const results = enabledSkills.filter((skill) => {
    const searchable = `${skill.name} ${skill.description ?? ''}`;
    const canonical = normalizeSkillSearchText(searchable);
    const compact = compactSkillSearchText(searchable);

    return canonical.includes(canonicalQuery) || compact.includes(compactQuery);
  });

  return typeof limit === 'number' ? results.slice(0, limit) : results;
}
