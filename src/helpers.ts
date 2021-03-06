
import ts, { ModifiersArray } from "typescript"
import { assert, implementationLimitation } from "./util";

/**
 * Merges two modifier lists together so that there are no duplicates.
 * 
 * @param a Modifiers to keep when there are duplicates
 * @param b Modifiers to discard when there are duplicates
 */
export function mergeModifiers(a: ts.Modifier[] | undefined, b: ts.Modifier[] | undefined): ts.Modifier[] {
  if (a === undefined) {
    return b ?? [];
  }
  if (b === undefined) {
    return a ?? [];
  }
  let result: ts.Modifier[] = [];
  a.sort((l, r) => l.kind - r.kind);
  b.sort((l, r) => l.kind - r.kind);
  let i = 0;
  let j = 0;
  for (;;) {
    const modifierA = a[i];
    const modifierB = b[i];
    if (i === a.length) {
      for (let k = j; k < b.length; k++) {
        result.push(b[k])
      }
      break;
    }
    if (j === b.length) {
      for (let k = i; k < a.length; k++) {
        result.push(a[k])
      }
      break;
    }
    if (modifierA.kind > modifierB.kind) {
      result.push(modifierB);
      j++;
    } else if (modifierA.kind < modifierB.kind) {
      result.push(modifierA);
      i++;
    } else {
      result.push(modifierA);
      i++;
      j++;
    }
  }
  return result;
}

/**
 * Performs a quick search for a node with the given name without relying on
 * something like a symbol table. Useful if you can't create a symbol table or
 * creating a symbol table is too expensive.
 *
 * @param node The node to start searching in
 * @param name The name that the returned node should have
 */
export function findNodeNamed(node: ts.Node, name: string): ts.Node | null {
  const toVisit = [ node ];
  while (toVisit.length > 0) {
    const currNode = toVisit.pop()!;
    if ((ts.isClassDeclaration(currNode) || ts.isInterfaceDeclaration(currNode))
      && currNode.name !== undefined
      && currNode.name.getText() === name) {
      return currNode;
    }
    if (ts.isSourceFile(currNode)) {
      for (const statement of currNode.statements) {
        toVisit.push(statement);
      }
    }
  }
  return null;
}

/**
 * Search a class or interface for a constructor and returns it if found.
 *
 * @param node The class or interface to search in
 */
export function findConstructor(
  node: ts.ClassDeclaration | ts.ClassExpression | ts.InterfaceDeclaration
): ts.ConstructSignatureDeclaration | ts.ConstructorDeclaration | null {
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
      return member as ts.ConstructorDeclaration;
    }
  }
  return null;
}

/**
 * Check whether a given node has a specific modifier.
 */
export function hasModifier(modifiers: ts.ModifiersArray | undefined, kind: ts.ModifierSyntaxKind): boolean {
  if (modifiers === undefined) {
    return false;
  }
  return [...modifiers].find(m => m.kind === kind) !== undefined;
}

/**
 * Check whether the given modifiers array has the public, private or protected modifiers.
 * 
 * @param modifiers A modifiers array to check for class modifiers.
 * @returns 
 */
export function hasClassModifier(modifiers: ts.ModifiersArray | undefined): boolean {
  if (modifiers === undefined) {
    return false;
  }
  return hasModifier(modifiers, ts.SyntaxKind.PublicKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.ProtectedKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.PrivateKeyword)
}

/**
 * Adds the public class modifier if no class modifier has been specified yet.
 */
export function addPublicModifier(modifiers: ts.ModifiersArray | undefined): ts.ModifiersArray {
  if (modifiers === undefined) {
    return ts.factory.createNodeArray([
      ts.factory.createModifier(ts.SyntaxKind.PublicKeyword)
    ]);
  }
  if (hasModifier(modifiers, ts.SyntaxKind.PublicKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.ProtectedKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.PrivateKeyword)) {
    return modifiers;
  }
  const newModifiers = [...modifiers];
  newModifiers.unshift(ts.factory.createModifier(ts.SyntaxKind.PublicKeyword));
  return ts.factory.createNodeArray(modifiers);
}

export function makePublic(node: ts.ParameterDeclaration | ts.ClassElement | ts.TypeElement) {
  if (hasClassModifier(node.modifiers)) {
    return node;
  }
  if (ts.isParameter(node)) {
    return ts.factory.createParameterDeclaration(
      node.decorators,
      addPublicModifier(node.modifiers),
      node.dotDotDotToken,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  if (ts.isPropertySignature(node)) {
    return ts.factory.createPropertySignature(
      addPublicModifier(node.modifiers),
      node.name,
      node.questionToken,
      node.type
    )
  }
  throw new Error(`Could not make a ${ts.SyntaxKind[node.kind]} public: node type not supported.`);
}

/**
 * Removes public, private and protected modifiers from the given modifiers array.
 */
export function removeClassModifiers(modifiers: ts.ModifiersArray | undefined): ts.ModifiersArray {
  if (modifiers === undefined) {
    return ts.factory.createNodeArray();
  }
  const newModifiers = [];
  for (const modifier of modifiers) {
    if (modifier.kind !== ts.SyntaxKind.PublicKeyword
        && modifier.kind !== ts.SyntaxKind.ProtectedKeyword
        && modifier.kind !== ts.SyntaxKind.PrivateKeyword) {
      newModifiers.push(modifier);
    }
  }
  return ts.factory.createNodeArray(newModifiers);
}

/**
 * Check whether a type node is a KeywordTypeNode.
 */
export function isKeywordType(typeNode: ts.TypeNode): boolean {
  switch (typeNode.kind) {
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.BigIntKeyword:
    case ts.SyntaxKind.BooleanKeyword:
    case ts.SyntaxKind.IntrinsicKeyword:
    case ts.SyntaxKind.NeverKeyword:
    case ts.SyntaxKind.NumberKeyword:
    case ts.SyntaxKind.ObjectKeyword:
    case ts.SyntaxKind.StringKeyword:
    case ts.SyntaxKind.SymbolKeyword:
    case ts.SyntaxKind.UndefinedKeyword:
    case ts.SyntaxKind.UnknownKeyword:
    case ts.SyntaxKind.VoidKeyword: 
      return true;
    default:
      return false;
  }
}

/**
 * Mocks TypeScripts typing rules to determine if a value one type could be assigned to a variable of another type.
 * 
 * This procedure is by no means perfect and will produce many false
 * positives/negatives or throw an error. You might want to wrap a call to this
 * function in a try-catch statement and return false if the function errored.
 * 
 * @param a The type of the value that will be assigned.
 * @param b The type of the variable that will be assigned to.
 * @returns True if assignment would work, false otherwise.
 */
export function isTypeAssignableTo(a: ts.TypeNode, b: ts.TypeNode): boolean {
  if (ts.isTypeReferenceNode(a) && ts.isTypeReferenceNode(b)) {
    if (a.typeName !== b.typeName) {
      return false;
    }
    if (a.typeArguments === undefined || b.typeArguments === undefined) {
      return a.typeArguments === b.typeArguments;
    }
    return a.typeArguments.every((typeArg, i) => isTypeAssignableTo(typeArg, b.typeArguments![i]))
  }
  if (ts.isUnionTypeNode(b)) {
    return b.types.some(type => isTypeAssignableTo(a, type))
  }
  if (ts.isUnionTypeNode(a)) {
    return a.types.some(type => isTypeAssignableTo(type, b))
  }
  if (ts.isArrayTypeNode(a) || ts.isArrayTypeNode(b)) {
    if (!(ts.isArrayTypeNode(a) && ts.isArrayTypeNode(b))) {
      return false;
    }
    return isTypeAssignableTo(a.elementType, b.elementType);
  }
  // if (ts.isLiteralTypeNode(a) || ts.isLiteralTypeNode(b)) {
  //   if (!(ts.isLiteralTypeNode(a) && ts.isLiteralTypeNode(b))) {
  //     return false;
  //   }
  //   return a.literal.kind === b.literal.kind;
  // }
  if (isKeywordType(a) || isKeywordType(b)) {
    if (!(isKeywordType(a) && isKeywordType(b))) {
      return false;
    }
    return a.kind === b.kind;
  }
  throw new Error(`Could not check assignablility of the two types ${ts.SyntaxKind[a.kind]} and ${ts.SyntaxKind[b.kind]}. Support for type-checking is very limited right now.`);
}

/**
 * Check whether any type in the list can be assigned to any other type.
 * 
 * This method is mainly useful if you want to make sure you are holding types
 * that could be used as a discriminator for some other type.
 * 
 * @param types The list of types to check for semantic overlaps.
 * @returns True if at least one type overlaps with another, false otherwise.
 */
export function areTypesDisjoint(types: ts.TypeNode[]): boolean {
  for (let i = 0; i < types.length; i++) {
    for (let j = i+1; j < types.length; j++) {
      if (isTypeAssignableTo(types[i], types[j])) {
        return false;
      }
      if (isTypeAssignableTo(types[j], types[i])) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Convert supported TypeScript nodes to a class element.
 * 
 * Currently, parameter declarations and interface type elements are supported.
 * If the node already is a class element, it will be returned as-is.
 * 
 * @param node The node to convert.
 * @returns A class element that is as close as possible to the original node or nothing if conversion failed.
 */
export function convertToClassElement(node: ts.Node): ts.ClassElement | null {
  if (ts.isClassElement(node)) {
    return node;
  }
  if (ts.isPropertySignature(node)) {
    return ts.factory.createPropertyDeclaration(
      node.decorators,
      node.modifiers,
      node.name,
      node.questionToken,
      node.type,
      undefined,
    )
  }
  if (ts.isParameter(node)) {
    implementationLimitation(ts.isIdentifier(node.name));
    return ts.factory.createPropertyDeclaration(
      node.decorators,
      node.modifiers,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  return null;
}

export function clearModifiers(node: ts.Node): ts.Node {
  if (ts.isParameter(node)) {
    return ts.factory.createParameterDeclaration(
      node.decorators,
      undefined,
      node.dotDotDotToken,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  throw new Error(`Could not clear modifiers of a ${ts.SyntaxKind[node.kind]}: unsupported node type`)
}

export function convertToReference(node: ts.Node): ts.Identifier {
  if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    implementationLimitation(ts.isIdentifier(node.name));
    return node.name;
  }
  throw new Error(`Could not convert a ${ts.SyntaxKind[node.kind]} to a variable reference: unsupported nod type`)
}

export function convertToParameter(node: ts.Node): ts.ParameterDeclaration { 
  if (ts.isParameter(node)) {
    return node;
  }
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
    assert(ts.isBindingName(node.name))
    return ts.factory.createParameterDeclaration(
      node.decorators,
      node.modifiers,
      undefined,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  throw new Error(`Could not convert a ${ts.SyntaxKind[node.kind]} to a parameter declaration: unsupported node type`)
}

/**
 * Checks whether the given node is exported out of the source file through the export keyword.
 * 
 * @returns True if the node was exported, false otherwise.
 */
export function isNodeExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
    (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
  );
}

export function isSuperCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.SuperKeyword
}
