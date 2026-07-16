import type { Chunk, ChunkMetadata } from '../../types';

export const DOCUMENT_OVERVIEW_CHUNK_INDEX = -1;
export const DOCUMENT_OVERVIEW_HEADING = 'Document Overview';

const MAX_HEADINGS = 16;
const MAX_LEAD_CHARS = 900;
const MAX_OVERVIEW_CHARS = 1800;

interface CreateDocumentOverviewChunkInput {
  agentId: string;
  documentId: string;
  content: string;
  metadata: Partial<ChunkMetadata>;
  childChunkCount: number;
  parentChunkCount: number;
}

interface BuildDocumentOverviewContentInput {
  documentId: string;
  content: string;
  metadata: Partial<ChunkMetadata>;
  childChunkCount: number;
  parentChunkCount: number;
}

interface HeadingEntry {
  level: number;
  title: string;
}

export function createDocumentOverviewChunk(input: CreateDocumentOverviewChunkInput): Chunk | null {
  const overviewContent = buildDocumentOverviewContent(input);
  if (!overviewContent) {
    return null;
  }

  const id = `chunk_doc_overview_${crypto.randomUUID()}`;

  return {
    id,
    agentId: input.agentId,
    documentId: input.documentId,
    chunkIndex: DOCUMENT_OVERVIEW_CHUNK_INDEX,
    content: overviewContent,
    metadata: {
      ...input.metadata,
      heading: DOCUMENT_OVERVIEW_HEADING,
      headingLevel: 0,
      sectionPath: DOCUMENT_OVERVIEW_HEADING,
      isDocumentOverview: true,
      parentChunkId: id,
    },
    createdAt: Date.now(),
  };
}

export function buildDocumentOverviewContent(input: BuildDocumentOverviewContentInput): string {
  const fileName = input.metadata.fileName?.trim();
  const displayFileName = fileName && fileName.length > 0 ? fileName : input.documentId;
  const headings = extractMarkdownHeadings(input.content);
  const title = extractDocumentTitle(headings, fileName, input.documentId);
  const lead = extractLeadText(input.content);
  const lines: string[] = ['# Document Overview', `File: ${displayFileName}`];

  if (title) {
    lines.push(`Title: ${title}`);
  }

  lines.push(`Chunks: ${input.childChunkCount}`);
  if (input.parentChunkCount > 0) {
    lines.push(`Sections: ${input.parentChunkCount}`);
  }

  if (headings.length > 0) {
    lines.push('', 'Topics:');
    for (const heading of headings.slice(0, MAX_HEADINGS)) {
      lines.push(`- H${heading.level} ${heading.title}`);
    }
  }

  if (lead) {
    lines.push('', 'Lead:', lead);
  }

  const overview = lines.join('\n').trim();
  return overview.length > MAX_OVERVIEW_CHARS
    ? `${sliceWithoutSplittingSurrogatePair(overview, MAX_OVERVIEW_CHARS).trim()}...`
    : overview;
}

function extractDocumentTitle(
  headings: HeadingEntry[],
  fileName: string | undefined,
  documentId: string
): string {
  const h1 = headings.find((heading) => heading.level === 1);
  if (h1) return h1.title;

  const firstHeading = headings[0];
  if (firstHeading) return firstHeading.title;

  if (fileName) {
    return fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  }

  return documentId;
}

function extractMarkdownHeadings(content: string): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  const seen = new Set<string>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;

    const title = cleanInlineMarkdown(match[2] ?? '');
    if (!title) continue;

    const key = `${match[1]?.length ?? 1}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    headings.push({
      level: match[1]?.length ?? 1,
      title,
    });

    if (headings.length >= MAX_HEADINGS) {
      break;
    }
  }

  return headings;
}

function extractLeadText(content: string): string {
  const normalized = stripFrontmatter(content);
  const paragraphs: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const paragraph = current.join(' ').replace(/\s+/g, ' ').trim();
    current = [];
    if (paragraph) {
      paragraphs.push(paragraph);
    }
  };

  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith('```')) {
      inFence = !inFence;
      flush();
      continue;
    }
    if (inFence) continue;

    if (!line) {
      flush();
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) continue;

    current.push(cleanInlineMarkdown(line));
    if (paragraphs.join('\n').length + current.join(' ').length >= MAX_LEAD_CHARS) {
      flush();
      break;
    }
  }

  flush();

  return sliceWithoutSplittingSurrogatePair(
    paragraphs.slice(0, 2).join('\n\n'),
    MAX_LEAD_CHARS
  ).trim();
}

function sliceWithoutSplittingSurrogatePair(value: string, maxLength: number): string {
  let end = Math.min(Math.max(0, Math.floor(maxLength)), value.length);
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const current = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      end--;
    }
  }
  return value.slice(0, end);
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) {
    return content;
  }

  const end = content.indexOf('\n---', 3);
  if (end < 0) {
    return content;
  }

  return content.slice(end + 4);
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
