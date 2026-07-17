import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Teal (https://github.com/teal-language/tl) — typed dialect of Lua.
 * Grammar: euclidianAce/tree-sitter-teal v0.1.0 (ABI 15), vendored wasm.
 *
 * Node names differ from the Lua grammar (`function_statement` vs
 * `function_declaration`, `var_declaration` vs `variable_declaration`,
 * `called_object` vs `name` on calls). Records/interfaces are first-class.
 */

/** First descendant of a given type (breadth-first), or null. */
function findDescendant(node: SyntaxNode, type: string): SyntaxNode | null {
  const queue: SyntaxNode[] = [...node.namedChildren];
  while (queue.length) {
    const n = queue.shift()!;
    if (n.type === type) return n;
    queue.push(...n.namedChildren);
  }
  return null;
}

/**
 * If `callNode` is a `require(...)` call, return the module name; otherwise null.
 * Teal uses the same require idiom as Lua: `require("Mod:Path")` / `require "x"`.
 */
function requireModule(callNode: SyntaxNode, source: string): string | null {
  const callee = getChildByField(callNode, 'called_object');
  if (!callee || callee.type !== 'identifier') return null;
  if (getNodeText(callee, source) !== 'require') return null;

  const args = getChildByField(callNode, 'arguments');
  if (!args) return null;

  const content = findDescendant(args, 'string_content');
  if (content) return getNodeText(content, source).trim() || null;
  const str = findDescendant(args, 'string');
  if (str) {
    const mod = getNodeText(str, source)
      .trim()
      .replace(/^\[\[/, '')
      .replace(/\]\]$/, '')
      .replace(/^["']/, '')
      .replace(/["']$/, '');
    if (mod) return mod;
  }
  return null;
}

/** Method name from `function_name` (`_IAPProduct.New` / `_IAPProduct:Foo`). */
function functionNameParts(
  nameNode: SyntaxNode | null,
  source: string,
): { receiver?: string; name: string } | null {
  if (!nameNode) return null;
  if (nameNode.type === 'identifier') {
    return { name: getNodeText(nameNode, source) };
  }
  if (nameNode.type === 'function_name') {
    const base = getChildByField(nameNode, 'base') ?? nameNode.namedChild(0);
    const entry = getChildByField(nameNode, 'entry') ?? nameNode.namedChild(1);
    if (entry) {
      return {
        receiver: base ? getNodeText(base, source) : undefined,
        name: getNodeText(entry, source),
      };
    }
    if (base) return { name: getNodeText(base, source) };
  }
  return { name: getNodeText(nameNode, source) };
}

export const tealExtractor: LanguageExtractor = {
  functionTypes: ['function_statement'],
  // Teal `record` is the primary structured type (OO-ish tables + typed fields).
  classTypes: ['record_declaration'],
  methodTypes: [],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  typeAliasTypes: ['type_declaration'],
  importTypes: [], // `require` is a function_call — handled in visitNode
  callTypes: ['function_call'],
  variableTypes: ['var_declaration'], // see the `teal` branch in extractVariable
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'arguments',

  resolveBody: (node, _bodyField) => {
    if (node.type === 'function_statement') {
      return getChildByField(node, 'body');
    }
    if (node.type === 'record_declaration') {
      return getChildByField(node, 'record_body');
    }
    if (node.type === 'interface_declaration') {
      return getChildByField(node, 'interface_body');
    }
    if (node.type === 'enum_declaration') {
      return getChildByField(node, 'enum_body');
    }
    return getChildByField(node, 'body');
  },

  resolveName: (node, source) => {
    const nameNode = getChildByField(node, 'name');
    const parts = functionNameParts(nameNode, source);
    return parts?.name;
  },

  getSignature: (node, source) => {
    const sig = getChildByField(node, 'signature');
    if (!sig) return undefined;
    const args = getChildByField(sig, 'arguments');
    const ret = getChildByField(sig, 'return_type');
    let out = args ? getNodeText(args, source) : '()';
    if (ret) out += `: ${getNodeText(ret, source)}`;
    return out;
  },

  getReturnType: (node, source) => {
    const sig = getChildByField(node, 'signature');
    const ret = sig ? getChildByField(sig, 'return_type') : null;
    return ret ? getNodeText(ret, source) : undefined;
  },

  // `function Rec.f()` / `function Rec:m()` → method with receiver `Rec`.
  getReceiverType: (node, source) => {
    const nameNode = getChildByField(node, 'name');
    const parts = functionNameParts(nameNode, source);
    return parts?.receiver;
  },

  visitNode: (node, ctx) => {
    const source = ctx.source;

    const emit = (callNode: SyntaxNode): void => {
      const mod = requireModule(callNode, source);
      if (!mod) return;
      const imp = ctx.createNode('import', mod, callNode, {
        signature: getNodeText(callNode, source).trim().slice(0, 100),
      });
      if (imp && ctx.nodeStack.length > 0) {
        const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (parentId) {
          ctx.addUnresolvedReference({
            fromNodeId: parentId,
            referenceName: mod,
            referenceKind: 'imports',
            line: callNode.startPosition.row + 1,
            column: callNode.startPosition.column,
          });
        }
      }
    };

    if (node.type === 'function_call') {
      if (requireModule(node, source)) {
        emit(node);
        return true;
      }
      return false;
    }

    // `local X = require(...)` — the var branch skips the initializer subtree.
    if (node.type === 'var_declaration') {
      const inits = getChildByField(node, 'initializers');
      if (!inits) return false;
      for (let i = 0; i < inits.namedChildCount; i++) {
        const child = inits.namedChild(i);
        if (child?.type === 'function_call') emit(child);
      }
      return false;
    }

    return false;
  },
};
