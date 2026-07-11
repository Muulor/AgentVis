import { describe, expect, it } from 'vitest';
import {
  fixFlowchartDanglingPipeLabelLinks,
  fixFlowchartPseudoSubgraphNodeDeclarations,
  fixFlowchartRedundantPipeLabelLinkTails,
  fixFlowchartReservedNodeIds,
  fixFlowchartUnsafeSubgraphTitles,
  quoteFlowchartNodeLabelsForFallback,
  sanitizeFlowchartFallbackLabel,
  sanitizeFlowchartQuotedLabels,
} from './MermaidFlowchartSanitizer';

describe('fixFlowchartReservedNodeIds', () => {
  it('renames reserved flowchart node ids while preserving labels', () => {
    const code = `flowchart TB
    subgraph src["src/"]
        main["main.js"]
        style["style.css"]
    end

    main --> style`;

    const fixed = fixFlowchartReservedNodeIds(code);

    expect(fixed).toContain('style_node["style.css"]');
    expect(fixed).toContain('main --> style_node');
    expect(fixed).not.toContain('style_node.css');
  });

  it('keeps Mermaid directives and rewrites only reserved directive targets', () => {
    const code = `flowchart LR
    style["style.css"]
    style style fill:#fff
    class style selected
    classDef selected fill:#fff`;

    const fixed = fixFlowchartReservedNodeIds(code);

    expect(fixed).toContain('style_node["style.css"]');
    expect(fixed).toContain('style style_node fill:#fff');
    expect(fixed).toContain('class style_node selected');
    expect(fixed).toContain('classDef selected fill:#fff');
  });

  it('does not rewrite non-flowchart diagrams', () => {
    const code = `sequenceDiagram
    Alice->>Bob: style`;

    expect(fixFlowchartReservedNodeIds(code)).toBe(code);
  });
});

describe('fixFlowchartRedundantPipeLabelLinkTails', () => {
  it('removes redundant complete link tails after pipe labels', () => {
    const code = `flowchart LR
    A1 <--> B1
    A2 ---|竞争|--- B2
    A3 -.->|劣势| B3
    A4 -->|替代|--> B4
    A5 ==>|加速|==> B5`;

    const fixed = fixFlowchartRedundantPipeLabelLinkTails(code);

    expect(fixed).toContain('A2 ---|竞争| B2');
    expect(fixed).toContain('A3 -.->|劣势| B3');
    expect(fixed).toContain('A4 -->|替代| B4');
    expect(fixed).toContain('A5 ==>|加速| B5');
  });

  it('preserves valid split pipe label syntax', () => {
    const code = `flowchart LR
    A --|竞争|--> B
    C ==|加速|==> D
    E -.|风险|.-> F`;

    expect(fixFlowchartRedundantPipeLabelLinkTails(code)).toBe(code);
  });

  it('does not rewrite text inside node labels or non-flowchart diagrams', () => {
    const flowchart = `flowchart LR
    A["literal ---|x|--- text"] --> B`;
    const sequence = `sequenceDiagram
    Alice->>Bob: A ---|x|--- B`;

    expect(fixFlowchartRedundantPipeLabelLinkTails(flowchart)).toBe(flowchart);
    expect(fixFlowchartRedundantPipeLabelLinkTails(sequence)).toBe(sequence);
  });
});

describe('fixFlowchartDanglingPipeLabelLinks', () => {
  it('turns a final dangling pipe-label edge into a generated target node', () => {
    const check = '\u2705';
    const code = `flowchart LR
    step7 -->|${check} manifest cleared| step8["8. Record Agent Log"]
    step8 -->|${check} wrote Agent-Log/2026-07-03_agent-log.md|`;

    const fixed = fixFlowchartDanglingPipeLabelLinks(code);

    expect(fixed).toContain(
      `step8 --> flowchart_auto_node_1["${check} wrote Agent-Log/2026-07-03_agent-log.md"]`
    );
    expect(fixed).not.toContain('step8 -->|');
  });

  it('keeps valid pipe-label edges untouched', () => {
    const code = `flowchart LR
    A -->|done| B
    B ---|next| C`;

    expect(fixFlowchartDanglingPipeLabelLinks(code)).toBe(code);
  });

  it('avoids generated target node id collisions', () => {
    const code = `flowchart LR
    flowchart_auto_node_1["Existing"]
    A -->|done|`;

    const fixed = fixFlowchartDanglingPipeLabelLinks(code);

    expect(fixed).toContain('A --> flowchart_auto_node_2["done"]');
  });

  it('does not rewrite text inside node labels or non-flowchart diagrams', () => {
    const flowchart = `flowchart LR
    A["literal -->|done|"] --> B`;
    const sequence = `sequenceDiagram
    Alice->>Bob: A -->|done|`;

    expect(fixFlowchartDanglingPipeLabelLinks(flowchart)).toBe(flowchart);
    expect(fixFlowchartDanglingPipeLabelLinks(sequence)).toBe(sequence);
  });
});

describe('fixFlowchartPseudoSubgraphNodeDeclarations', () => {
  it('turns unmatched VisualEnhancer SubGraph layer declarations into regular nodes', () => {
    const code = `flowchart LR
    SubGraph Frontend["Frontend / TUI Layer"]
    SubGraph Backend["Backend Layer"]
    SubGraph Tools["Tooling & Infra"]

    Frontend -- "Interacts with" --> Backend
    Backend -- "Utilizes" --> Tools

    classDef layer fill:#f9f9f9,stroke:#333,stroke-width:2px;
    class Frontend,Backend,Tools layer;`;

    const fixed = fixFlowchartPseudoSubgraphNodeDeclarations(code);

    expect(fixed).toContain('Frontend["Frontend / TUI Layer"]');
    expect(fixed).toContain('Backend["Backend Layer"]');
    expect(fixed).toContain('Tools["Tooling & Infra"]');
    expect(fixed).not.toContain('SubGraph Frontend');
    expect(fixed).toContain('class Frontend,Backend,Tools layer;');
  });

  it('normalizes mixed-case subgraph keywords when a matching end exists', () => {
    const code = `flowchart TB
SubGraph Frontend["Frontend"]
    A[OK]
end`;

    const fixed = fixFlowchartPseudoSubgraphNodeDeclarations(code);

    expect(fixed).toContain('subgraph Frontend["Frontend"]');
    expect(fixed).toContain('    A[OK]');
    expect(fixed).toContain('end');
  });

  it('does not rewrite non-flowchart diagrams', () => {
    const code = `sequenceDiagram
    Alice->>Bob: SubGraph Frontend["Frontend"]`;

    expect(fixFlowchartPseudoSubgraphNodeDeclarations(code)).toBe(code);
  });
});

describe('fixFlowchartUnsafeSubgraphTitles', () => {
  it('assigns generated ids to unsafe bare subgraph titles', () => {
    const code = `flowchart TB
    subgraph 第一步：阵地占位
        A1[创建Gitee镜像<br>与GitHub双向同步]
        A2[掘金发布首篇文章<br>技术解析/项目介绍]
    end
    subgraph 第二步：社群建设
        B[在README挂微信群/QQ群二维码]
    end
    subgraph 第三步：内容引流
        C[发布实战教程<br>《用这个Agent项目10分钟搞定XXX》 ]
    end
    A1 --> A2
    A2 --> B
    B --> C
    C --> D[后续迭代： <br>内容引流 → 社区互动 → KOL合作]`;

    const fixed = fixFlowchartUnsafeSubgraphTitles(code);
    const fallbackFixed = quoteFlowchartNodeLabelsForFallback(fixed);

    expect(fixed).toContain('subgraph subgraph_auto_1["第一步：阵地占位"]');
    expect(fixed).toContain('subgraph subgraph_auto_2["第二步：社群建设"]');
    expect(fixed).toContain('subgraph subgraph_auto_3["第三步：内容引流"]');
    expect(fallbackFixed).toContain('A1["创建Gitee镜像<br/>与GitHub双向同步"]');
    expect(fallbackFixed).toContain('D["后续迭代： <br/>内容引流 → 社区互动 → KOL合作"]');
  });

  it('keeps valid subgraph declarations untouched', () => {
    const code = `flowchart TB
    subgraph src["src/"]
        A[OK]
    end
    subgraph services
        B[OK]
    end
    subgraph api [API layer]
        C[OK]
    end
    subgraph "Already quoted"
        D[OK]
    end`;

    expect(fixFlowchartUnsafeSubgraphTitles(code)).toBe(code);
  });

  it('keeps explicit labels when unsafe subgraph ids are followed by bracket labels', () => {
    const code = `flowchart TB
    subgraph 搞混了["你可能混淆了"]
        A[英伟达 NVIDIA] -.->|≠| B[台积电 TSMC]
    end

    subgraph 英伟达["🔥 英伟达"]
        A --> A1[📍 美国加州 公司]
        A --> A2[💻 GPU芯片霸主]
    end

    subgraph 台积电["🏭 台积电"]
        B --> B1[📍 台湾新竹 公司]
        B --> B2[⚙️ 芯片代工制造]
    end`;

    const fixed = fixFlowchartUnsafeSubgraphTitles(code);
    const fallbackFixed = quoteFlowchartNodeLabelsForFallback(fixed);

    expect(fixed).toContain('subgraph subgraph_auto_1["你可能混淆了"]');
    expect(fixed).toContain('subgraph subgraph_auto_2["🔥 英伟达"]');
    expect(fixed).toContain('subgraph subgraph_auto_3["🏭 台积电"]');
    expect(fixed).not.toContain("搞混了['你可能混淆了']");
    expect(fallbackFixed).toContain('A["英伟达 NVIDIA"] -.->|≠| B["台积电 TSMC"]');
    expect(fallbackFixed).toContain('A --> A1["📍 美国加州 公司"]');
  });

  it('avoids generated id collisions and ignores non-flowchart diagrams', () => {
    const code = `flowchart TB
    subgraph_auto_1[Existing]
    subgraph 中文标题
        A[OK]
    end`;
    const sequence = `sequenceDiagram
    Alice->>Bob: subgraph 中文标题`;

    expect(fixFlowchartUnsafeSubgraphTitles(code)).toContain(
      'subgraph subgraph_auto_2["中文标题"]'
    );
    expect(fixFlowchartUnsafeSubgraphTitles(sequence)).toBe(sequence);
  });
});

describe('sanitizeFlowchartQuotedLabels', () => {
  it('normalizes escaped quotes inside already quoted flowchart labels', () => {
    const code = `flowchart LR
    A["Node.js 22+"] --> B["npm install -g<br>@openai/codex"]
    B --> C["codex --version<br>验证安装"]
    C --> D["ChatGPT 登录<br>或 API Key 认证"]
    D --> E["codex \\"描述需求\\"<br>基本用法"]`;

    const fixed = sanitizeFlowchartQuotedLabels(code);

    expect(fixed).toContain('B["npm install -g<br/>@openai/codex"]');
    expect(fixed).toContain('E["codex \'描述需求\'<br/>基本用法"]');
    expect(fixed).not.toContain('\\"描述需求\\"');
  });

  it('keeps non-flowchart diagrams untouched', () => {
    const code = `sequenceDiagram
    Alice->>Bob: "codex \\"描述需求\\"<br>基本用法"`;

    expect(sanitizeFlowchartQuotedLabels(code)).toBe(code);
  });
});

describe('quoteFlowchartNodeLabelsForFallback', () => {
  it('quotes risky LLM flowchart labels and normalizes inline breaks/code spans', () => {
    const code = `flowchart TB
    A[agent-browser 排查任务] --> B[被 OfflineIsolated 沙箱策略阻塞]
    C --> D[无法执行关键验证步骤： <br>1. agent-browser 命令运行<br>2. Chrome 运行时启动]
    E --> F[agent-browser 未在常见安装路径中找到<br>（全局 node_modules、AgentVis 外部包目录）]
    F --> G[\`where agent-browser\` 命令无法定位可执行文件]`;

    const fixed = quoteFlowchartNodeLabelsForFallback(code);

    expect(fixed).toContain('A["agent-browser 排查任务"] --> B["被 OfflineIsolated 沙箱策略阻塞"]');
    expect(fixed).toContain(
      'D["无法执行关键验证步骤： <br/>1. agent-browser 命令运行<br/>2. Chrome 运行时启动"]'
    );
    expect(fixed).toContain(
      'F["agent-browser 未在常见安装路径中找到<br/>（全局 node_modules、AgentVis 外部包目录）"]'
    );
    expect(fixed).toContain('G["\'where agent-browser\' 命令无法定位可执行文件"]');
    expect(fixed).not.toContain('<br>1.');
    expect(fixed).not.toContain('`where agent-browser`');
  });

  it('keeps non-flowchart diagrams untouched', () => {
    const code = `sequenceDiagram
    Alice->>Bob: \`where agent-browser\`<br>`;

    expect(quoteFlowchartNodeLabelsForFallback(code)).toBe(code);
  });
});

describe('sanitizeFlowchartFallbackLabel', () => {
  it('keeps quoted labels parse-friendly without changing ordinary prose', () => {
    expect(sanitizeFlowchartFallbackLabel('命令 `where agent-browser` <br> "失败"')).toBe(
      "命令 'where agent-browser' <br/> '失败'"
    );
  });
});
