/**
 * Safe Tailwind theme extraction for Project Preview.
 *
 * Agent configuration is parsed as syntax only and is never imported or
 * executed. Only bounded JSON-like literals below `theme` are retained;
 * functions, calls, identifiers, spreads, computed keys, and methods are
 * omitted before the result is serialized into AgentVis-owned Vite config.
 */

import type { File, Node, ObjectExpression } from '@babel/types';

import type { ProjectFile } from './types';

const CONFIG_PRIORITY = [
  'tailwind.config.js',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
  'tailwind.config.ts',
  'tailwind.config.mts',
  'tailwind.config.cts',
] as const;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_THEME_BYTES = 128 * 1024;
const MAX_LITERAL_DEPTH = 20;
const MAX_LITERAL_NODES = 8_192;
const MAX_LITERAL_STRING_BYTES = 16 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const UNSUPPORTED = Symbol('unsupported-tailwind-literal');

export type SafeTailwindValue =
  | string
  | number
  | boolean
  | null
  | SafeTailwindValue[]
  | { [key: string]: SafeTailwindValue };
export type SafeTailwindTheme = Record<string, SafeTailwindValue>;

interface LiteralBudget {
  visitedNodes: number;
}

function unwrapExpression(node: Node | null): Node | null {
  if (!node) return null;
  switch (node.type) {
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'TypeCastExpression':
      return unwrapExpression(node.expression);
    default:
      return node;
  }
}

function staticPropertyKey(node: Node | null): string | null {
  const key = unwrapExpression(node);
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'StringLiteral') return key.value;
  if (key.type === 'NumericLiteral' && Number.isFinite(key.value)) return String(key.value);
  return null;
}

function getObjectProperty(object: ObjectExpression, name: string): Node | null {
  let result: Node | null = null;
  for (const property of object.properties) {
    if (property.type !== 'ObjectProperty' || property.computed) continue;
    if (staticPropertyKey(property.key) === name) result = property.value;
  }
  return result;
}

function configObjectFromNode(node: Node | null): ObjectExpression | null {
  const value = unwrapExpression(node);
  if (!value) return null;
  if (value.type === 'ObjectExpression') return value;
  if (
    value.type === 'CallExpression' &&
    value.callee.type === 'Identifier' &&
    value.callee.name === 'defineConfig' &&
    value.arguments.length === 1
  ) {
    const argument = value.arguments[0];
    return argument?.type === 'SpreadElement' ? null : configObjectFromNode(argument ?? null);
  }
  return null;
}

function isCommonJsConfigAssignment(node: Node): boolean {
  if (node.type !== 'AssignmentExpression' || node.operator !== '=') return false;
  const left = unwrapExpression(node.left);
  if (left?.type !== 'MemberExpression') return false;
  const object = unwrapExpression(left.object);
  const propertyName = left.computed
    ? staticPropertyKey(left.property)
    : left.property.type === 'Identifier'
      ? left.property.name
      : null;
  return (
    (object?.type === 'Identifier' && object.name === 'module' && propertyName === 'exports') ||
    (object?.type === 'Identifier' && object.name === 'exports' && propertyName === 'default')
  );
}

function findConfigObject(ast: File): ObjectExpression | null {
  let commonJsResult: ObjectExpression | null = null;
  for (const statement of ast.program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      return configObjectFromNode(statement.declaration);
    }
    if (
      statement.type === 'ExpressionStatement' &&
      isCommonJsConfigAssignment(statement.expression)
    ) {
      const assignment = statement.expression;
      if (assignment.type === 'AssignmentExpression') {
        commonJsResult = configObjectFromNode(assignment.right);
      }
    }
  }
  return commonJsResult;
}

function evaluateLiteral(
  node: Node | null,
  depth: number,
  budget: LiteralBudget
): SafeTailwindValue | typeof UNSUPPORTED {
  const value = unwrapExpression(node);
  budget.visitedNodes += 1;
  if (!value || depth > MAX_LITERAL_DEPTH || budget.visitedNodes > MAX_LITERAL_NODES) {
    return UNSUPPORTED;
  }

  switch (value.type) {
    case 'StringLiteral':
      return new TextEncoder().encode(value.value).byteLength <= MAX_LITERAL_STRING_BYTES
        ? value.value
        : UNSUPPORTED;
    case 'NumericLiteral':
      return Number.isFinite(value.value) ? value.value : UNSUPPORTED;
    case 'BooleanLiteral':
      return value.value;
    case 'NullLiteral':
      return null;
    case 'TemplateLiteral': {
      if (value.expressions.length > 0) return UNSUPPORTED;
      const text = value.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('');
      return new TextEncoder().encode(text).byteLength <= MAX_LITERAL_STRING_BYTES
        ? text
        : UNSUPPORTED;
    }
    case 'UnaryExpression': {
      if (value.operator !== '+' && value.operator !== '-') return UNSUPPORTED;
      const argument = evaluateLiteral(value.argument, depth + 1, budget);
      if (typeof argument !== 'number') return UNSUPPORTED;
      return value.operator === '-' ? -argument : argument;
    }
    case 'ArrayExpression': {
      const result: SafeTailwindValue[] = [];
      for (const element of value.elements) {
        if (!element || element.type === 'SpreadElement') return UNSUPPORTED;
        const item = evaluateLiteral(element, depth + 1, budget);
        if (item === UNSUPPORTED) return UNSUPPORTED;
        result.push(item);
      }
      return result;
    }
    case 'ObjectExpression': {
      const result = Object.create(null) as Record<string, SafeTailwindValue>;
      let acceptedProperties = 0;
      let unsupportedProperties = 0;
      for (const property of value.properties) {
        if (property.type !== 'ObjectProperty' || property.computed) {
          unsupportedProperties += 1;
          continue;
        }
        const key = staticPropertyKey(property.key);
        if (!key || FORBIDDEN_KEYS.has(key)) {
          unsupportedProperties += 1;
          continue;
        }
        const propertyValue = evaluateLiteral(property.value, depth + 1, budget);
        if (propertyValue === UNSUPPORTED) {
          unsupportedProperties += 1;
          continue;
        }
        Object.defineProperty(result, key, {
          configurable: false,
          enumerable: true,
          value: propertyValue,
          writable: false,
        });
        acceptedProperties += 1;
      }
      if (acceptedProperties === 0 && unsupportedProperties > 0) return UNSUPPORTED;
      return result;
    }
    default:
      return UNSUPPORTED;
  }
}

function findTailwindConfig(files: readonly ProjectFile[]): ProjectFile | null {
  const byPath = new Map(files.map((file) => [file.path.toLowerCase(), file]));
  for (const path of CONFIG_PRIORITY) {
    const file = byPath.get(path);
    if (file) return file;
  }
  return null;
}

/** Extract a bounded literal Tailwind theme without evaluating configuration code. */
export async function extractSafeTailwindTheme(
  files: readonly ProjectFile[]
): Promise<SafeTailwindTheme | null> {
  const config = findTailwindConfig(files);
  if (!config || new TextEncoder().encode(config.content).byteLength > MAX_CONFIG_BYTES)
    return null;

  try {
    const { parse } = await import('@babel/parser');
    const ast = parse(config.content, {
      createParenthesizedExpressions: true,
      plugins: ['typescript'],
      sourceType: 'unambiguous',
    });
    const configObject = findConfigObject(ast);
    if (!configObject) return null;
    const themeNode = getObjectProperty(configObject, 'theme');
    const theme = evaluateLiteral(themeNode, 0, { visitedNodes: 0 });
    if (
      theme === UNSUPPORTED ||
      theme === null ||
      Array.isArray(theme) ||
      typeof theme !== 'object'
    ) {
      return null;
    }
    const serialized = JSON.stringify(theme);
    if (new TextEncoder().encode(serialized).byteLength > MAX_THEME_BYTES) return null;
    return theme;
  } catch {
    return null;
  }
}
