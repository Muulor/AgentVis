/**
 * Bundled Script Skill 回归测试
 *
 * 覆盖当前内置 brokerOnly Script Skill 的 contract 解析、参数校验与入口脚本形态。
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExternalSkillRegistryLoader } from '../ExternalSkillRegistry';
import { validateArgs } from '../ContractValidator';

const BUNDLED_SKILLS_DIR = resolve(process.cwd(), 'src-tauri/skills-bundle');

function createBundledLoader(): ExternalSkillRegistryLoader {
  return new ExternalSkillRegistryLoader(
    BUNDLED_SKILLS_DIR,
    async (path) => readFileSync(path, 'utf-8'),
    async (path) => existsSync(path) && statSync(path).isDirectory(),
    async (path) => readdirSync(path)
  );
}

describe('bundled Script Skills', () => {
  it('应加载带凭据策略的 bundled brokerOnly Script Skill contract', async () => {
    const result = await createBundledLoader().scanAll();

    expect(result.warnings).toEqual([]);
    const scriptSkills = result.skills.filter((skill) => skill.mode === 'script');
    const names = scriptSkills.map((skill) => skill.name);

    expect(names).toEqual(
      expect.arrayContaining(['github-lookup', 'context7-docs', 'agnes-video', 'agnes-image'])
    );
    for (const skill of scriptSkills.filter(
      (skill) =>
        skill.name === 'github-lookup' ||
        skill.name === 'context7-docs' ||
        skill.name === 'agnes-video' ||
        skill.name === 'agnes-image'
    )) {
      expect(skill.contract).toBeDefined();
      expect(skill.contract?.runtime).toBe('python');
      expect(skill.contract?.permissions?.network).toBe(true);
      expect(skill.contract?.permissions?.networkMode).toBe('brokerOnly');
      expect(skill.packagePath).toContain('src-tauri/skills-bundle');
    }
    const githubLookup = scriptSkills.find((skill) => skill.name === 'github-lookup');
    expect(githubLookup?.contract?.credentials).toEqual([
      {
        id: 'github',
        provider: 'github',
        mode: 'brokerAuth',
        hosts: ['api.github.com'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        required: false,
      },
    ]);
    const context7Docs = scriptSkills.find((skill) => skill.name === 'context7-docs');
    expect(context7Docs?.contract?.credentials).toEqual([
      {
        id: 'context7',
        provider: 'context7',
        mode: 'brokerAuth',
        hosts: ['context7.com'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        required: false,
      },
    ]);
    const agnesVideo = scriptSkills.find((skill) => skill.name === 'agnes-video');
    expect(agnesVideo?.contract?.credentials).toEqual([
      {
        id: 'agnes',
        provider: 'agnes',
        mode: 'brokerAuth',
        hosts: ['apihub.agnes-ai.com'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        required: true,
      },
    ]);
    const agnesImage = scriptSkills.find((skill) => skill.name === 'agnes-image');
    expect(agnesImage?.contract?.credentials).toEqual([
      {
        id: 'agnes',
        provider: 'agnes',
        mode: 'brokerAuth',
        hosts: ['apihub.agnes-ai.com'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        required: true,
      },
    ]);
  });

  it('应按真实 contract 校验 bundled Script Skill 的参数', async () => {
    const result = await createBundledLoader().scanAll();
    const githubLookup = result.skills.find((skill) => skill.name === 'github-lookup');
    const context7Docs = result.skills.find((skill) => skill.name === 'context7-docs');
    const agnesVideo = result.skills.find((skill) => skill.name === 'agnes-video');
    const agnesImage = result.skills.find((skill) => skill.name === 'agnes-image');

    expect(githubLookup?.contract).toBeDefined();
    expect(context7Docs?.contract).toBeDefined();
    expect(agnesVideo?.contract).toBeDefined();
    expect(agnesImage?.contract).toBeDefined();
    expect(agnesVideo?.contract?.timeout).toBe(600);
    expect(agnesVideo?.contract?.permissions?.longRunning).toBe(true);
    expect(agnesImage?.contract?.timeout).toBe(240);

    const missingAction = validateArgs({}, githubLookup!.contract!);
    expect(missingAction.valid).toBe(false);
    if (!missingAction.valid) {
      expect(missingAction.errors.join('\n')).toContain('action');
    }
    expect(
      validateArgs(
        {
          action: 'search',
          query: 'hermes agent',
          limit: 3,
        },
        githubLookup!.contract!
      )
    ).toEqual({ valid: true });

    const missingContext7Action = validateArgs({}, context7Docs!.contract!);
    expect(missingContext7Action.valid).toBe(false);
    if (!missingContext7Action.valid) {
      expect(missingContext7Action.errors.join('\n')).toContain('action');
    }
    expect(
      validateArgs(
        {
          action: 'resolve-docs',
          libraryName: 'react',
          query: 'How do I use hooks?',
          outputFormat: 'text',
          limit: 3,
        },
        context7Docs!.contract!
      )
    ).toEqual({ valid: true });

    const missingAgnesAction = validateArgs({}, agnesVideo!.contract!);
    expect(missingAgnesAction.valid).toBe(false);
    if (!missingAgnesAction.valid) {
      expect(missingAgnesAction.errors.join('\n')).toContain('action');
    }
    expect(
      validateArgs(
        {
          action: 'payload',
          prompt: 'A cinematic product demo with soft camera movement',
          width: 1152,
          height: 768,
          numFrames: 121,
          frameRate: 24,
          outputFormat: 'json',
        },
        agnesVideo!.contract!
      )
    ).toEqual({ valid: true });
    expect(
      validateArgs(
        {
          action: 'status',
          taskId: 'task_123456',
          skipDownload: true,
        },
        agnesVideo!.contract!
      )
    ).toEqual({ valid: true });
    expect(
      validateArgs(
        {
          action: 'create-and-wait',
          prompt: 'A cinematic kitten practicing kung fu',
          timeoutSeconds: 540,
          savePath: 'videos/cat-kung-fu.mp4',
        },
        agnesVideo!.contract!
      )
    ).toEqual({ valid: true });
    expect(
      validateArgs(
        {
          action: 'download',
          videoUrl: 'https://storage.googleapis.com/example/video.mp4',
          savePath: 'videos/example.mp4',
        },
        agnesVideo!.contract!
      )
    ).toEqual({ valid: true });

    const missingAgnesImageAction = validateArgs({}, agnesImage!.contract!);
    expect(missingAgnesImageAction.valid).toBe(false);
    if (!missingAgnesImageAction.valid) {
      expect(missingAgnesImageAction.errors.join('\n')).toContain('action');
    }
    expect(
      validateArgs(
        {
          action: 'payload',
          prompt: 'A layered fantasy harbor city with dense visual detail',
          size: '1024x1024',
          outputFormat: 'json',
        },
        agnesImage!.contract!
      )
    ).toEqual({ valid: true });
    expect(
      validateArgs(
        {
          action: 'generate',
          prompt: 'Restyle this image as a rainy neon street while preserving composition',
          image: 'https://example.com/input.png',
          aspectRatio: '16:9',
          customName: 'rainy-neon-street',
        },
        agnesImage!.contract!
      )
    ).toEqual({ valid: true });
    expect(
      validateArgs(
        {
          action: 'download-url',
          imageUrl: 'https://storage.googleapis.com/example/image.png',
          savePath: 'images/example.png',
        },
        agnesImage!.contract!
      )
    ).toEqual({ valid: true });
  });

  it('应固定当前 brokerOnly 入口脚本的静态扫描差异', () => {
    const githubEntry = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'github-lookup/scripts/github_lookup_entry.py'),
      'utf-8'
    ).toLowerCase();
    const githubImpl = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'github-lookup/scripts/github_lookup.py'),
      'utf-8'
    );
    const context7Entry = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'context7-docs/scripts/context7_docs_entry.py'),
      'utf-8'
    ).toLowerCase();
    const context7Impl = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'context7-docs/scripts/context7_docs.py'),
      'utf-8'
    );
    const agnesEntry = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'agnes-video/scripts/agnes_video_entry.py'),
      'utf-8'
    ).toLowerCase();
    const agnesImpl = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'agnes-video/scripts/agnes_video.py'),
      'utf-8'
    );
    const agnesImageEntry = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'agnes-image/scripts/agnes_image_entry.py'),
      'utf-8'
    ).toLowerCase();
    const agnesImageImpl = readFileSync(
      resolve(BUNDLED_SKILLS_DIR, 'agnes-image/scripts/agnes_image.py'),
      'utf-8'
    );

    expect(githubEntry).not.toMatch(/import\s+httpx|urllib\.request|requests\./);
    expect(githubImpl).toContain('AGENTVIS_BROKER_FETCH');
    expect(githubImpl).toContain('AGENTVIS_BROKER_PIPE');
    expect(githubImpl).toContain('AGENTVIS_BROKER_TOKEN');
    expect(githubImpl).toContain('credential_ref="github"');
    expect(context7Entry).not.toMatch(/import\s+httpx|urllib\.request|requests\./);
    expect(context7Entry).not.toContain('https://');
    expect(context7Impl).toContain('AGENTVIS_BROKER_FETCH');
    expect(context7Impl).toContain('AGENTVIS_BROKER_PIPE');
    expect(context7Impl).toContain('AGENTVIS_BROKER_TOKEN');
    expect(context7Impl).toContain('"credentialRef": "context7"');
    expect(agnesEntry).not.toMatch(/import\s+httpx|urllib\.request|requests\./);
    expect(agnesEntry).not.toContain('https://');
    expect(agnesImpl).toContain('AGENTVIS_BROKER_FETCH');
    expect(agnesImpl).toContain('AGENTVIS_BROKER_PIPE');
    expect(agnesImpl).toContain('AGENTVIS_BROKER_TOKEN');
    expect(agnesImpl).toContain('credential_ref="agnes"');
    expect(agnesImpl).toContain('https://apihub.agnes-ai.com/v1');
    expect(agnesImageEntry).not.toMatch(/import\s+httpx|urllib\.request|requests\./);
    expect(agnesImageEntry).not.toContain('https://');
    expect(agnesImageImpl).toContain('AGENTVIS_BROKER_FETCH');
    expect(agnesImageImpl).toContain('AGENTVIS_BROKER_PIPE');
    expect(agnesImageImpl).toContain('AGENTVIS_BROKER_TOKEN');
    expect(agnesImageImpl).toContain('credential_ref="agnes"');
    expect(agnesImageImpl).toContain('https://apihub.agnes-ai.com/v1');
  });
});
