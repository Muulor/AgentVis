/**
 * ExternalSkillBootstrap dependency filtering tests.
 *
 * Covers runtime base-package de-duplication before dependency installation.
 */

import { describe, expect, it } from 'vitest';
import {
  filterRuntimeBasePackages,
  summarizeFailedDependencyImpact,
} from '../ExternalSkillBootstrap';

describe('filterRuntimeBasePackages', () => {
  it('filters explicit dependencies that are already provided by the shared runtime', () => {
    const result = filterRuntimeBasePackages(
      ['httpx>=0.27', 'markitdown[pptx]', 'custom-package==1.0.0'],
      new Set(['httpx', 'markitdown'])
    );

    expect(result).toEqual(['custom-package==1.0.0']);
  });
});

describe('summarizeFailedDependencyImpact', () => {
  it('maps failed packages back to only the affected skills', () => {
    const result = summarizeFailedDependencyImpact(
      [
        { skillName: 'desktop-control', packages: ['PyAutoGUI', 'PyGetWindow'] },
        { skillName: 'video-downloader', packages: ['yt-dlp', 'yutto'] },
        { skillName: 'pdf', packages: ['pdfplumber'] },
      ],
      ['pyautogui', 'pygetwindow']
    );

    expect(result).toEqual({
      skillNames: ['desktop-control'],
      packageSpecs: ['PyAutoGUI', 'PyGetWindow'],
    });
  });

  it('matches package names across dash underscore and case variants', () => {
    const result = summarizeFailedDependencyImpact(
      [
        { skillName: 'image-tools', packages: ['pillow-heif>=0.20'] },
        { skillName: 'web-scraper', packages: ['charset_normalizer'] },
      ],
      ['Pillow_Heif']
    );

    expect(result).toEqual({
      skillNames: ['image-tools'],
      packageSpecs: ['pillow-heif>=0.20'],
    });
  });
});
