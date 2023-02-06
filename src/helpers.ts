
import ts from "typescript"
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
export function hasModifier(modifiers: readonly ts.Modifier[] | undefined, kind: ts.ModifierSyntaxKind): boolean {
  if (modifiers === undefined) {
    return false;
  }
  return modifiers.find(m => m.kind === kind) !== undefined;
}

/**
 * Check whether the given modifiers array has the public, private or protected modifiers.
 */
export function hasClassModifier(modifiers: readonly ts.Modifier[] | undefined): boolean {
  return hasModifier(modifiers, ts.SyntaxKind.PublicKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.ProtectedKeyword)
      || hasModifier(modifiers, ts.SyntaxKind.PrivateKeyword)
}

/**
 * Adds the public class modifier if no class modifier has been specified yet.
 */
export function addPublicModifier(modifiers: readonly ts.Modifier[] | undefined): readonly ts.Modifier[] {
  if (modifiers === undefined) {
    return [
      ts.factory.createModifier(ts.SyntaxKind.PublicKeyword)
    ];
  }
  if (hasClassModifier(modifiers)) {
    return modifiers;
  }
  const newModifiers = [...modifiers];
  newModifiers.unshift(ts.factory.createModifier(ts.SyntaxKind.PublicKeyword));
  return modifiers;
}

export function makePublic(node: ts.HasModifiers) {
  if (hasClassModifier(ts.getModifiers(node))) {
    return node;
  }
  if (ts.isParameter(node)) {
    return ts.factory.createParameterDeclaration(
      addPublicModifier(ts.getModifiers(node)),
      node.dotDotDotToken,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  if (ts.isPropertySignature(node)) {
    return ts.factory.createPropertySignature(
      addPublicModifier(ts.getModifiers(node)),
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
    if (a.typeName.getText() !== b.typeName.getText()) {
      return false;
    }
    if (a.typeArguments === undefined || b.typeArguments === undefined) {
      return a.typeArguments === b.typeArguments;
    }
    return a.typeArguments.every((typeArg, i) => isTypeAssignableTo(typeArg, b.typeArguments![i]))
  }
  if (ts.isUnionTypeNode(b)) {
    return b.types.every(type => isTypeAssignableTo(a, type))
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
  if (ts.isParenthesizedTypeNode(a)) {
    return isTypeAssignableTo(a.type, b);
  }
  if (ts.isParenthesizedTypeNode(b)) {
    return isTypeAssignableTo(a, b.type);
  }
  if (ts.isLiteralTypeNode(a) || ts.isLiteralTypeNode(b)) {
    if (!(ts.isLiteralTypeNode(a) && ts.isLiteralTypeNode(b))) {
      return false;
    }
    throw new Error(`Could not check equivalence of two literal types: equality not supported.`);
  }
  if (isKeywordType(a) || isKeywordType(b)) {
    if (!(isKeywordType(a) && isKeywordType(b))) {
      return false;
    }
    return a.kind === b.kind;
  }
  throw new Error(`Could not check assignablility of the two types ${ts.SyntaxKind[a.kind]} and ${ts.SyntaxKind[b.kind]}. Support for type-checking is very limited right now.`);
}

export function isArrayType(typeNode: ts.TypeNode) {
  return ts.isArrayTypeNode(typeNode)
    || (ts.isTypeReferenceNode(typeNode)
      && typeNode.typeArguments !== undefined
      && typeNode.typeName.getText() === 'Array');
}

export function getArrayElementType(typeNode: ts.TypeNode) {
  if (ts.isArrayTypeNode(typeNode)) {
    return typeNode.elementType;
  }
  if (ts.isTypeReferenceNode(typeNode)) {
    assert(typeNode.typeName.getText() === 'Array');
    assert(typeNode.typeArguments !== undefined);
    return typeNode.typeArguments[0];
  }
  throw new Error(`Could not get the element type of the given TypeScript type node: unrecognised type node`);
}

export function doTypesOverlap(a: ts.TypeNode, b: ts.TypeNode): boolean {
  if (isArrayType(a) && isArrayType(b)) {
    return doTypesOverlap(getArrayElementType(a), getArrayElementType(b));
  }
  if (isArrayType(a) || isArrayType(b)) {
    return false;
  }
  if (ts.isTypeReferenceNode(a) && ts.isTypeReferenceNode(b)) {
    // FIXME resolve type aliases
    if (a.typeName.getText() !== b.typeName.getText()) {
      return false;
    }
    if (a.typeArguments === undefined || b.typeArguments === undefined) {
      return false;
    }
    return a.typeArguments.some((typeArg, i) => doTypesOverlap(typeArg, b.typeArguments![i]))
  }
  if (ts.isUnionTypeNode(b)) {
    return b.types.some(type => doTypesOverlap(a, type))
  }
  if (ts.isUnionTypeNode(a)) {
    return a.types.some(type => doTypesOverlap(type, b))
  }
  if (ts.isParenthesizedTypeNode(a)) {
    return doTypesOverlap(a.type, b);
  }
  if (ts.isParenthesizedTypeNode(b)) {
    return doTypesOverlap(a, b.type);
  }
  if (ts.isLiteralTypeNode(a) && ts.isLiteralTypeNode(b)) {
    if (a.literal.kind === ts.SyntaxKind.NullKeyword && b.literal.kind === ts.SyntaxKind.NullKeyword) {
      return true;
    }
    if (a.literal.kind === ts.SyntaxKind.UndefinedKeyword && b.literal.kind === ts.SyntaxKind.UndefinedKeyword) {
      return true;
    }
    throw new Error(`Could not compare literal types. Support for type-checkin is very limited right now.`);
  }
  if (ts.isLiteralTypeNode(a)) {
    if (a.literal.kind === ts.SyntaxKind.StringLiteral
      && b.kind === ts.SyntaxKind.StringLiteral) {
      return true;
    }
    if (a.literal.kind === ts.SyntaxKind.TrueKeyword && b.kind === ts.SyntaxKind.BooleanKeyword) {
      return true;
    }
    if (a.literal.kind === ts.SyntaxKind.FalseKeyword && b.kind === ts.SyntaxKind.BooleanKeyword) {
      return true;
    }
    // FIXME Cover more cases.
    return false;
  }
  if (ts.isLiteralTypeNode(b)) {
    return doTypesOverlap(b, a);
  }
  if (isKeywordType(a) || isKeywordType(b)) {
    if (!(isKeywordType(a) && isKeywordType(b))) {
      return false;
    }
    return a.kind === b.kind;
  }
  throw new Error(`Could not determine if the two types ${ts.SyntaxKind[a.kind]} and ${ts.SyntaxKind[b.kind]} overlap. Support for type-checking is very limited right now.`);
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
      ts.getModifiers(node),
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
      ts.getModifiers(node),
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
