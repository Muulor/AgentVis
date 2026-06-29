/**
 * Compatibility wrapper for knowledge-base indexing rules.
 *
 * The canonical file type policy lives in @services/file-types. Keep these
 * exports so existing RAG/planning call sites can migrate gradually.
 */

export type { KnowledgeDocumentType } from '@services/file-types';

export {
    CODE_FILE_EXTENSIONS,
    KNOWLEDGE_OFFICE_FILE_EXTENSIONS,
    KNOWLEDGE_TEXT_FILE_EXTENSIONS,
    getKnowledgeDocumentType,
    isKnowledgeOfficeFile,
    isKnowledgeTextFile,
    shouldAutoIndexKnowledgeFile,
} from '@services/file-types';

export {
    getFileExtension as getFileExtensionForKnowledge,
    isAgentLogFile as isAgentLogFileForKnowledge,
    isCodeFile as isCodeFileForKnowledge,
} from '@services/file-types';
