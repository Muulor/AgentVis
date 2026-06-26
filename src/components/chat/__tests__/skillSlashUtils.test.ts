import { describe, expect, it } from 'vitest';
import {
    compactSkillSearchText,
    filterSkillSlashOptions,
    findSkillSlashTrigger,
    normalizeSkillSearchText,
} from '../skillSlashUtils';

describe('skillSlashUtils', () => {
    describe('findSkillSlashTrigger', () => {
        it('detects a slash command at the beginning of the input', () => {
            expect(findSkillSlashTrigger('/mark', 5)).toEqual({
                start: 0,
                end: 5,
                query: 'mark',
            });
        });

        it('detects a slash command after whitespace', () => {
            expect(findSkillSlashTrigger('please /pdf', 11)).toEqual({
                start: 7,
                end: 11,
                query: 'pdf',
            });
        });

        it('ignores slashes inside paths and urls', () => {
            expect(findSkillSlashTrigger('C:/Users/Muulo', 14)).toBeNull();
            expect(findSkillSlashTrigger('https://github.com/owner/repo', 29)).toBeNull();
        });

        it('closes after the slash query contains whitespace', () => {
            expect(findSkillSlashTrigger('/marketing ideas', 16)).toBeNull();
        });
    });

    describe('skill matching', () => {
        it('normalizes case and separator differences', () => {
            expect(normalizeSkillSearchText('Marketing-Ideas')).toBe('marketing ideas');
            expect(compactSkillSearchText('Marketing Ideas')).toBe('marketingideas');
        });

        it('matches enabled skills by hyphenated names without requiring triggers', () => {
            const results = filterSkillSlashOptions([
                { name: 'Marketing-Ideas', description: 'Marketing ideation', enabled: true, mode: 'guide' },
                { name: 'theme-factory', description: 'Design themes', enabled: true, mode: 'guide' },
            ], 'marketingideas');

            expect(results.map(skill => skill.name)).toEqual(['Marketing-Ideas']);
        });

        it('does not limit the number of suggestions by default', () => {
            const skills = Array.from({ length: 12 }, (_, index) => ({
                name: `skill-${index}`,
                description: 'Guide',
                enabled: true,
                mode: 'guide' as const,
            }));

            expect(filterSkillSlashOptions(skills, '')).toHaveLength(12);
        });

        it('excludes disabled skills from suggestions', () => {
            const results = filterSkillSlashOptions([
                { name: 'Marketing-Ideas', description: 'Marketing ideation', enabled: false, mode: 'guide' },
            ], '');

            expect(results).toEqual([]);
        });
    });
});
