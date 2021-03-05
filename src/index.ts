
import ts, { factory, getParsedCommandLineOfConfigFile, isTypeElement, isTypeNode, isVariableStatement, isYieldExpression, TypeNode } from "typescript"

import { DeclarationResolver, Symbol } from "./resolver";
import { assert, memoise } from "./util";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
}

function first<T1, T2>(tuple: [T1, T2]): T1 {
  return tuple[0];
}

function second<T>(tuple: T[]): T {
  return tuple[1];
}

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
 * Search a class declaration or class expression for a constructor and returns it if found.
 *
 * @param node The class to search in
 */
export function findConstructor(node: ts.ClassDeclaration | ts.ClassExpression): ts.ConstructorDeclaration | null {
  for (const member of node.members) {
    if (ts.isConstructorDeclaration(member)) {
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

function hasClassModifier(modifiers: ts.ModifiersArray | undefined): boolean {
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
export function makePublic(modifiers: ts.ModifiersArray | undefined): ts.ModifiersArray {
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
function isKeywordType(typeNode: ts.TypeNode): boolean {
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

function isTypeAssignableTo(a: ts.TypeNode, b: ts.TypeNode): boolean {
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
  const printer = ts.createPrinter();
  console.log(ts.SyntaxKind[a.kind])
  console.log(ts.isTypeReferenceNode(b))
  console.log(printer.printNode(ts.EmitHint.Unspecified, a, a.getSourceFile()));
  console.log(printer.printNode(ts.EmitHint.Unspecified, b, a.getSourceFile()));
  throw new Error(`Could not check assignablility of two types. Support for type-checking is very limited right now.`);
}

function areTypesDisjoint(types: ts.TypeNode[]): boolean {
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

function convertToClassElement(node: ts.Node): ts.ClassElement {
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
    assert(ts.isIdentifier(node.name));
    return ts.factory.createPropertyDeclaration(
      node.decorators,
      node.modifiers,
      node.name,
      node.questionToken,
      node.type,
      node.initializer
    )
  }
  throw new Error(`Support for converting an interface declaration to an abstract class is very limited right now.`)
}

function buildTypeOfEquality(expr: ts.Expression, typeStr: ts.Expression) {
  return ts.factory.createBinaryExpression(
    ts.factory.createTypeOfExpression(expr),
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    typeStr
  )
}

function buildCond(cases: [ts.Expression, ts.Statement][]): ts.IfStatement {
  const [test, then] = cases[cases.length-1]
  let result = ts.factory.createIfStatement(test, then)
  for (let i = cases.length-1; i >= 0; i++) {
    const [test, then] = cases[i];
    result = ts.factory.createIfStatement(test, then, result)
  }
  return result;
}

function buildEquality(left: ts.Expression, right: ts.Expression): ts.Expression {
  return ts.factory.createBinaryExpression(
    left,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    right
  )
}

function buildThrowError(message: string) {
  return ts.factory.createThrowStatement(
    ts.factory.createNewExpression(
      ts.factory.createIdentifier('Error'),
      undefined,
      [ ts.factory.createStringLiteral(message) ]
    )
  )
}

function buildBinaryExpression(operator: ts.BinaryOperator, args: ts.Expression[]) {
  let result = args[0]
  for (let i = 1; i < args.length; i++) {
    result = ts.factory.createBinaryExpression(result, operator, args[i]);
  }
  return result;
}

// export function isNodeExported(node: ts.Node): boolean {
//   return (
//     (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
//     (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
//   );
// }

export default function generateCode(sourceFile: ts.SourceFile, options: CodeGeneratorOptions = {}): string {

  let out = '';

  const generateIdField = true;
  const generateParentNodes = true;
  const generateVisitor = true;
  const rootNodeName = options.rootNodeName ?? 'Syntax';
  const resolver = new DeclarationResolver();
  const declarationsToSkip = [ `${rootNodeName}Kind` ];

  const printer = ts.createPrinter();

  function write(str: string): void {
    out += str;
  }

  function writeNode(node: ts.Node): void {
    write(printer.printNode(ts.EmitHint.Unspecified, node, sourceFile) + '\n\n');
  }

  const getAllMembers = memoise((nodeType: Symbol): Array<ts.ClassElement | ts.TypeElement> => {
    const result: Array<ts.ClassElement | ts.TypeElement> = [];
    for (const symbol of [nodeType, ...nodeType.allInheritsFrom]) {
      for (const declaration of symbol.declarations) {
        assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
        for (const member of declaration.members) {
          if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
            result.push(member);
          } else if (ts.isConstructorDeclaration(member)) {
            for (const param of member.parameters) {
              result.push(convertToClassElement(param));
            }
          }
        }
      }
    }
    return result;
  }, 'id');

  const isTypeNodeOnlyReferencingAST = (node: ts.Node): boolean => {
    if (ts.isUnionTypeNode(node)) {
      return node.types.every(isTypeNodeOnlyReferencingAST);
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = resolver.resolveTypeReferenceNode(node);
      return symbol !== null && (isAST(symbol));
    }
    return false;
  }

  const isVariant = memoise((symbol: Symbol): boolean => {
    if (!symbol.isTypeAlias()) {
      return false;
    }
    return isTypeNodeOnlyReferencingAST(symbol.asTypeAliasDeclaration().type)
  }, 'id');

  const isIntermediate = memoise((symbol: Symbol): boolean => {
    if (!symbol.isClassOrInterface()) {
      return false;
    }
    return symbol.allInheritsFrom.some(upSymbol => upSymbol === rootSymbol)
        && symbol.allExtendsTo.some(downSymbol => isNodeType(downSymbol));
  }, 'id')

  const isNodeType = memoise((symbol: Symbol): boolean => {
    if (!symbol.isClassOrInterface()) {
      return false;
    }
    return symbol.allInheritsFrom.some(upSymbol => upSymbol === rootSymbol)
        && !symbol.allExtendsTo.some(downSymbol => isNodeType(downSymbol));
  }, 'id');

  const getAllNodeTypesInside = memoise((symbol: Symbol): Symbol[] => {
    if (isNodeType(symbol)) {
      return [ symbol ]
    }
    if (isIntermediate(symbol)) {
      return symbol.allExtendsTo.filter(otherSymbol => isNodeType(otherSymbol))
    }
    if (isVariant(symbol)) {
    }
    return [];
  });

  const isAST = (symbol: Symbol): boolean => {
    return isVariant(symbol) || isIntermediate(symbol) || isNodeType(symbol);
  }

  const getAllNodeTypesInTypeNode = (typeNode: ts.TypeNode): Symbol[] => {
    if (ts.isTypeReferenceNode(typeNode)) {
      if (typeNode.typeName.getText() === 'Array'
          && typeNode.typeArguments !== undefined) {
        return getAllNodeTypesInTypeNode(typeNode.typeArguments[0]);
      }
      const symbol = resolver.resolveTypeReferenceNode(typeNode);
      if (symbol === null || !isAST(symbol)) {
        return [];
      }
      return [ symbol ]
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const result = [];
      for (const elementTypeNode of typeNode.types) {
        result.push(...getAllNodeTypesInTypeNode(elementTypeNode))
      }
      return result;
    }
    return [];
  }

  const getAllASTInFieldsOfSymbol = memoise((symbol: Symbol) => {
    const result = new Set<Symbol>();
    for (const param of getFieldsAsParameters(symbol)) {
      if (param.type !== undefined) {
        for (const referencedSymbol of resolver.getReferencedSymbolsInTypeNode(param.type)) {
          if (isAST(referencedSymbol)) {
            result.add(referencedSymbol);
          }
        }
      }
    }
    return [...result];
  }, 'id')

  const getAllNodeTypesHavingSymbolInField = memoise((nodeType: Symbol) => {
    const result = [];
    for (const otherSymbol of resolver.getAllSymbols()) {
      if (isNodeType(otherSymbol)) {
        for (const referencedSymbol of getAllASTInFieldsOfSymbol(otherSymbol)) {
          if (referencedSymbol.allExtendsTo.indexOf(nodeType) !== -1) {
            result.push(otherSymbol);
          }
        }
      }
    }
    return result;
  }, 'id');

  const getAutoCasts = (typeNode: ts.TypeNode): Array<[ts.TypeNode, Symbol]> => {
    const result: Array<[ts.TypeNode, Symbol]> = [];
    for (const symbol of getAllNodeTypesInTypeNode(typeNode)) {
      const typesToCheck: Array<[ts.TypeNode, Symbol]> = [];
      const nodeTypes = getAllNodeTypesInside(symbol)
      for (const nodeType of nodeTypes) {
        const requiredParameters = getFieldsAsParameters(nodeType).filter(p => p.questionToken === undefined && p.initializer === undefined)
        if (requiredParameters.length === 1) {
          const uniqueParameter = requiredParameters[0];
          if (uniqueParameter.type === undefined) {
            continue;
          }
          typesToCheck.push([uniqueParameter.type, nodeType])
        }
      }
      if (areTypesDisjoint(typesToCheck.map(first))) {
        result.push(...typesToCheck);
      }
    }
    return result;
  }

  function addAutoCastsToParameter(param: ts.ParameterDeclaration) {
    return ts.factory.createParameterDeclaration(
      param.decorators,
      param.modifiers,
      param.dotDotDotToken,
      param.name,
      param.questionToken,
      param.type !== undefined
        ? ts.factory.createUnionTypeNode([param.type, ...getAutoCasts(param.type).map(([typeNode, symbol]) => typeNode)])
        : undefined,
      param.initializer
    )
  }

  function getFieldsAsParameters(symbol: Symbol, isConstructor = false): Array<ts.ParameterDeclaration> {

    const result: Array<ts.ParameterDeclaration> = [];

    function generateParameters(isOptional: boolean) {
      const methodResolutionOrder = [symbol, ...symbol.allInheritsFrom.filter(upSymbol => upSymbol !== rootSymbol), rootSymbol!];
      if (!isOptional) {
        methodResolutionOrder.reverse();
      }
      for (const currSymbol of methodResolutionOrder) {
        for (const declaration of currSymbol.declarations) {
          if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
            for (const member of declaration.members) {
              if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
                assert(ts.isIdentifier(member.name));
                if ((member.questionToken !== undefined || member.initializer !== undefined) === isOptional) {
                  result.push(
                    ts.factory.createParameterDeclaration(
                      member.decorators,
                      isConstructor && currSymbol !== rootSymbol ? makePublic(member.modifiers) : removeClassModifiers(member.modifiers),
                      undefined,
                      member.name,
                      member.questionToken,
                      member.type,
                      member.initializer
                    )
                  );
                }
              } else if (ts.isConstructorDeclaration(member)) {
                for (const param of member.parameters) {
                  if ((param.questionToken !== undefined || param.initializer !== undefined) === isOptional) {
                    result.push(
                      ts.factory.createParameterDeclaration(
                        param.decorators,
                        isConstructor && currSymbol !== rootSymbol ? makePublic(param.modifiers) : removeClassModifiers(param.modifiers),
                        param.dotDotDotToken,
                        param.name,
                        param.questionToken,
                        param.type,
                        param.initializer
                      )
                    );
                  }
                }
              }
            }
          }
        }
      }
    }

    generateParameters(false),
    generateParameters(true)

    return result;

  }

  function buildPredicateFromTypeNode(type: ts.TypeNode, value: ts.Expression): ts.Expression {
    if (ts.isArrayTypeNode(type)) {
      return ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Array'), 'isArray'),
        undefined,
        [ value ]
      );
    } else if (ts.isUnionTypeNode(type)) {
      return buildBinaryExpression(
        ts.SyntaxKind.BarBarToken,
        type.types.map(elementType => buildPredicateFromTypeNode(elementType, value))
      )
    } else if (ts.isTypeReferenceNode(type)) {
      if (!ts.isIdentifier(type.typeName)) {
        throw new Error(`Node is too complex to be processed.`)
      }
      const referencedSymbol = resolver.resolveTypeReferenceNode(type);
      if (referencedSymbol === null) {
        throw new Error(`Could not find a declaration for '${type.typeName.getText()}'.`)
      }
      return ts.factory.createCallExpression(
        ts.factory.createIdentifier(`is${type.typeName.getText()}`),
        undefined,
        [ value ]
      );
    } else {
      switch (type.kind) {
        case ts.SyntaxKind.NeverKeyword:
          return ts.factory.createFalse();
        case ts.SyntaxKind.AnyKeyword:
          return ts.factory.createTrue();
        case ts.SyntaxKind.StringKeyword:
          return buildTypeOfEquality(value, ts.factory.createStringLiteral('string'));
        case ts.SyntaxKind.NullKeyword:
          return buildTypeOfEquality(value, ts.factory.createNull());
        case ts.SyntaxKind.BooleanKeyword:
          return buildTypeOfEquality(value, ts.factory.createStringLiteral('boolean'));
        case ts.SyntaxKind.NumberKeyword:
          return buildTypeOfEquality(value, ts.factory.createStringLiteral('number'));
      }
    }
    throw new Error(`Could not convert TypeScript type node to a type guard.`)
  }


  let nextTempId = 1;

  const rootSymbol = resolver.resolve(rootNodeName, sourceFile);

  if (rootSymbol === null) {
    throw new Error(`A declaration of a root node named '${rootNodeName} was not found. tsastgen needs a root node to generate an AST.`)
  }
  const rootDeclaration = rootSymbol.declarations[0];
  if (!(ts.isClassDeclaration(rootDeclaration) || ts.isInterfaceDeclaration(rootDeclaration))) {
    throw new Error(`The root node '${rootNodeName}' must be a class or interface declaration.`)
  }

  let rootConstructor = null;
  if (ts.isClassDeclaration(rootSymbol.declarations[0])) {
    rootConstructor = rootDeclaration;
  }

  function generateTemporaryId(): string {
    return `__tempid${nextTempId++}`
  }

  function parameterToReference(param: ts.ParameterDeclaration): ts.Identifier {
    assert(ts.isIdentifier(param.name));
    return param.name;
  }

  const nodeTypes = [...resolver.getAllSymbols()].filter(isNodeType);

  const generate = (node: ts.Node) => {

    if (node === rootDeclaration) {
      writeNode(
        ts.factory.createClassDeclaration(
          rootDeclaration.decorators,
          rootDeclaration.modifiers,
          `${rootNodeName}Base`,
          rootDeclaration.typeParameters,
          rootDeclaration.heritageClauses,
          [...rootDeclaration.members].map(convertToClassElement),
        )
      );
      return;
    }

    if (ts.isSourceFile(node)) {
      for (const statement of node.statements) {
        generate(statement);
      }
      return;
    }

    const symbol = resolver.getSymbolForNode(node);

    if (symbol === null) {
      writeNode(node);
      return;
    }

    if (isIntermediate(symbol)) {

      assert(ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node));
      assert(node.name !== undefined);

      const nodeTypes = symbol.allExtendsTo.filter(isNodeType)

      // export type X
      //   = A
      //   | B
      //   ...
      writeNode(
        ts.factory.createTypeAliasDeclaration(
          undefined,
          node.modifiers,
          node.name,
          undefined,
          ts.factory.createUnionTypeNode(
            nodeTypes.map(symbol => ts.factory.createTypeReferenceNode(symbol.name))
          )
        )
      );

      // export function isY(value: any): value is Y {
      //   return value.kind === SyntaxKind.A
      //       || value.kind === SyntaxKind.B
      //       || ...
      // }
      writeNode(
        ts.factory.createFunctionDeclaration(
          node.decorators,
          node.modifiers,
          undefined,
          `is${symbol.name}`,
          undefined,
          [
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              undefined,
              'value',
              undefined,
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
            )
          ],
          ts.factory.createTypePredicateNode(
            undefined,
            'value',
            ts.factory.createTypeReferenceNode(symbol.name, undefined)
          ),
          ts.factory.createBlock([
            ts.factory.createReturnStatement(
              buildBinaryExpression(
                ts.SyntaxKind.BarBarToken,
                nodeTypes.map(nodeTypeSymbol => 
                  buildEquality(
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier('value'),
                      undefined,
                      'kind'
                    ),
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier('SyntaxKind'),
                      undefined,
                      nodeTypeSymbol.name
                    )
                  )
                )
              )
            )
          ])
        )
      );

      return;

    }

    if (isVariant(symbol)) {

      writeNode(node);

      const finalNodes = resolver.getReferencedSymbolsInTypeNode(symbol.asTypeAliasDeclaration().type)
        .filter(symbol => isNodeType(symbol) || isVariant(symbol));

      // export function isY(value: any): value is Y {
      //   return value.kind === SyntaxKind.A
      //       || value.kind === SyntaxKind.B
      //       || ...
      // }
      writeNode(
        ts.factory.createFunctionDeclaration(
          undefined,
          [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
          undefined,
          `is${symbol.name}`,
          undefined,
          [
            ts.factory.createParameterDeclaration(
              undefined,
              undefined,
              undefined,
              'value',
              undefined,
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)
            )
          ],
          ts.factory.createTypePredicateNode(
            undefined,
            'value',
            ts.factory.createTypeReferenceNode(symbol.name, undefined)
          ),
          ts.factory.createBlock([
            ts.factory.createReturnStatement(
              buildBinaryExpression(
                ts.SyntaxKind.BarBarToken,
                finalNodes.map(node => 
                  buildEquality(
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier('value'),
                      undefined,
                      'kind'
                    ),
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier('SyntaxKind'),
                      undefined,
                      node.name
                    )
                  )
                )
              )
            )
          ])
        )
      );

      return;

    }

    if (isNodeType(symbol)) {

      const parentSymbols = getAllNodeTypesHavingSymbolInField(symbol);
      const childSymbols = getAllASTInFieldsOfSymbol(symbol);
      const membersWithAST = getAllMembers(symbol).filter(member =>
        (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member))
        && member.type !== undefined
        && getAllNodeTypesInTypeNode(member.type).length > 0) as ts.PropertyDeclaration[];

      function buildChildrenOfStatement(type: ts.TypeNode, value: ts.Expression): ts.Statement | null {
        if (ts.isUnionTypeNode(type)) {
          const isNullable = type.types.find(t => ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) !== undefined;
          const remainingTypes = type.types.filter(t => t.kind !== ts.SyntaxKind.NullKeyword);
          const mapped: Array<[ts.TypeNode, ts.Statement]> = [];
          for (const elementTypeNode of remainingTypes) {
            const yieldStatement = buildChildrenOfStatement(elementTypeNode, value);
            if (yieldStatement !== null) {
              mapped.push([ elementTypeNode, yieldStatement ]);
            }
          }
          if (mapped.length === 0) {
            return null;
          }
          if (mapped.length > (isNullable ? 2 : 1)) {
            for (let i = 0; i < mapped.length; i++) {
              const [elementTypeNode, yieldStatement] = mapped[i];
              if (yieldStatement !== null) {
                mapped[i][1] = (
                  ts.factory.createIfStatement(
                    buildPredicateFromTypeNode(elementTypeNode, value),
                    yieldStatement
                  )
                )
              }
            }
          }
          let result: ts.Statement = mapped.length === 1
            ? mapped[0][1]
            : ts.factory.createBlock(mapped.map(pair => pair[1]));
          if (isNullable) {
            result = ts.factory.createIfStatement(
              ts.factory.createBinaryExpression(
                value,
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.factory.createNull()
              ),
              result,
            )
          }
          return result;
        }
        if (ts.isTypeReferenceNode(type)
            && type.typeName.getText() === 'Array'
            && type.typeArguments !== undefined) {
          const yieldStatements = buildChildrenOfStatement(type.typeArguments[0], ts.factory.createIdentifier('element'))
          if (yieldStatements === null) {
            return null;
          }
          return ts.factory.createForOfStatement(
            undefined,
            ts.factory.createVariableDeclarationList([
              ts.factory.createVariableDeclaration('element')
            ], ts.NodeFlags.Let),
            value,
            yieldStatements,
          )
        }
        if (ts.isArrayTypeNode(type)) {
          const yieldStatements = buildChildrenOfStatement(type.elementType, ts.factory.createIdentifier('element'));
          if (yieldStatements === null) {
            return null;
          }
          return ts.factory.createForOfStatement(
            undefined,
            ts.factory.createVariableDeclarationList([
              ts.factory.createVariableDeclaration('element')
            ], ts.NodeFlags.Let),
            value,
            yieldStatements
          )
        }
        if (ts.isTypeReferenceNode(type)) {
          return ts.factory.createExpressionStatement(ts.factory.createYieldExpression(undefined, value));
        }
        return null;
      }

      const classMembers = [];

      classMembers.push(
        // public readonly kind = SyntaxKind.X;
        ts.factory.createPropertyDeclaration(
          undefined,
          [ ts.factory.createToken(ts.SyntaxKind.ReadonlyKeyword) ],
          'kind',
          undefined,
          undefined,
          ts.factory.createPropertyAccessChain(
            ts.factory.createIdentifier('SyntaxKind'),
            undefined,
            symbol.name
          ),
        )
      )

      if (generateParentNodes) {
        classMembers.push(
          // public parentNode: XParent | null = null;
          ts.factory.createPropertyDeclaration(
            undefined,
            undefined,
            `parentNode`,
            undefined,
            ts.factory.createUnionTypeNode([
              ts.factory.createLiteralTypeNode(
                ts.factory.createNull()
              ),
              ts.factory.createTypeReferenceNode(`${symbol.name}Parent`, undefined)
            ]),
            ts.factory.createNull(),
          )
        )
      }

      const constructorParameters = getFieldsAsParameters(symbol, true);

      classMembers.push(
        // constructor(public field: T, ...) { super(field...) }
        ts.factory.createConstructorDeclaration(
          undefined,
          undefined,
          [
            ...constructorParameters,
          ],
          ts.factory.createBlock([
            ts.factory.createExpressionStatement(
              ts.factory.createCallExpression(
                ts.factory.createSuper(),
                undefined,
                constructorParameters.filter(param => !hasClassModifier(param.modifiers)).map(parameterToReference)
              )
            )
          ])
        )
      )

      classMembers.push(
        // public *getChildNodes(): Iterable<XChild> { ... }
        ts.factory.createMethodDeclaration(
          undefined,
          undefined,
          ts.factory.createToken(ts.SyntaxKind.AsteriskToken),
          `getChildNodes`,
          undefined,
          undefined,
          [],
          ts.factory.createTypeReferenceNode(
            `Iterable`,
            [ ts.factory.createTypeReferenceNode(`${symbol.name}Child`, undefined) ]
          ),
          ts.factory.createBlock(
            membersWithAST.map(member => 
              buildChildrenOfStatement(
                member.type!,
                ts.factory.createPropertyAccessChain(
                  ts.factory.createThis(),
                  undefined,
                  member.name as ts.Identifier
                )
              )!
            )
          )
        )
      )

      if (ts.isClassDeclaration(node)) {
        classMembers.push(
          ...node.members.filter(member => !ts.isConstructorDeclaration(member))
        )
      }

      writeNode(
        // class X extends SyntaxBase {
        //   ...
        // }
        ts.factory.createClassDeclaration(
          undefined,
          [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
          symbol.name,
          undefined,
          [
            ts.factory.createHeritageClause(
              ts.SyntaxKind.ExtendsKeyword,
              [
                ts.factory.createExpressionWithTypeArguments(
                  ts.factory.createIdentifier(`${rootNodeName}Base`),
                  undefined,
                )
              ]
            )
          ],
          classMembers,
        )
      );

      // export type XParent
      //   = A
      //   | B
      //   ...
      writeNode(
        ts.factory.createTypeAliasDeclaration(
          undefined,
          undefined,
          `${symbol.name}Parent`,
          undefined,
          ts.factory.createUnionTypeNode(
            [
              ...parentSymbols.map(parentSymbol => ts.factory.createTypeReferenceNode(parentSymbol.name, undefined)),
             ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
            ]
          )
        )
      );


      // export type XChild
      //   = A
      //   | B
      //   ...
      writeNode(
        ts.factory.createTypeAliasDeclaration(
          undefined,
          undefined,
          `${symbol.name}Child`,
          undefined,
          ts.factory.createUnionTypeNode(
            [
              ...childSymbols.map(childSymbol => ts.factory.createTypeReferenceNode(childSymbol.name, undefined)),
             ts.factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
            ]
          )
        )
      );

      const factoryParameters = getFieldsAsParameters(symbol)
      const autoCastStatements = [];

      for (const param of factoryParameters) {
        if (param.type === undefined) {
          continue;
        }
        assert(ts.isIdentifier(param.name));
        for (const [typeToCastFrom, nodeType]  of getAutoCasts(param.type)) {
          autoCastStatements.push(
            ts.factory.createIfStatement(
              buildPredicateFromTypeNode(typeToCastFrom, param.name),
              ts.factory.createExpressionStatement(
                ts.factory.createAssignment(
                  param.name,
                  ts.factory.createCallExpression(
                    ts.factory.createIdentifier(`create${nodeType.name}`),
                    undefined,
                    [
                      param.name as ts.Identifier,
                    ]
                  )
                )
              )
            )
          );
        }
      }

      // export function createX(fields: T...): Y {
      //   return new X(fields...);
      // }
      writeNode(
        ts.factory.createFunctionDeclaration(
          undefined,
          node.modifiers,
          undefined,
          `create${symbol.name}`,
          undefined,
          [
            ...factoryParameters.map(addAutoCastsToParameter),
          ],
          ts.factory.createTypeReferenceNode(symbol.name, undefined),
          ts.factory.createBlock([
            ...autoCastStatements,
            ts.factory.createReturnStatement(
              ts.factory.createNewExpression(
                ts.factory.createIdentifier(symbol.name),
                undefined,
                [
                  ...factoryParameters.map(parameterToReference)
                ]
              )
            )
          ])
        )
      );

      return;

    }

    // We only get here if the node resolves to a symbol but is not an AST node
    // type nor an AST variant type. In this case, we just pass through the
    // TypeScript node as-is.
    writeNode(node);

  }

  // export function isSyntax(value: any): value is Syntax {
  //   return value !== null
  //       && tyeof(value) === 'object'
  //       && value instanceof SyntaxBase;
  // }
  writeNode(
    ts.factory.createFunctionDeclaration(
      undefined,
      [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
      undefined,
      `is${rootNodeName}`,
      undefined,
      [
        ts.factory.createParameterDeclaration(
        undefined,
        undefined,
        undefined,
        'value',
        undefined,
        ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword))
      ],
      ts.factory.createTypePredicateNode(
        undefined,
        'value',
        ts.factory.createTypeReferenceNode(rootNodeName, undefined)
      ),
      ts.factory.createBlock(
        [
          ts.factory.createReturnStatement(
            buildBinaryExpression(
              ts.SyntaxKind.AmpersandAmpersandToken,
             [
              buildEquality(
                ts.factory.createTypeOfExpression(ts.factory.createIdentifier('value')),
                ts.factory.createStringLiteral('object')
              ),
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier('value'),
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.factory.createNull(),
              ),
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier('value'),
                ts.SyntaxKind.InstanceOfKeyword,
                ts.factory.createIdentifier(`${rootNodeName}Base`)
              )
             ] 
            )
          )
        ]
      )
    )
  )

  // if (generateVisitor) {
  //   // class Visitor {
  //   //   visit(node: Syntax): void {
  //   //     switch (node.kind) {
  //   //       case SyntaxKind.A:
  //   //         return this.visitA(node);
  //   //       case SyntaxKind.B:
  //   //         return this.visitB(node);
  //   //       ...
  //   //     }
  //   //   }
  //   //   visitX(node: X): void;
  //   // }
  //   writeNode(
  //     ts.factory.createClassDeclaration(
  //       undefined,
  //       [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
  //       'Visitor',
  //       undefined,
  //       undefined,
  //       [
  //         ts.factory.createMethodDeclaration(
  //           undefined,
  //           undefined,
  //           undefined,
  //           `visit`,
  //           undefined,
  //           undefined,
  //           [
  //             ts.factory.createParameterDeclaration(
  //               undefined,
  //               undefined,
  //               undefined,
  //               `node`,
  //               undefined,
  //               ts.factory.createTypeReferenceNode(rootNodeName, undefined)
  //             )
  //           ],
  //           ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
  //           ts.factory.createBlock([
  //             ts.factory.createSwitchStatement(
  //               ts.factory.createPropertyAccessChain(ts.factory.createIdentifier('node'), undefined, 'kind'),
  //               ts.factory.createCaseBlock([
  //                 ...finalSymbols.map(nodeType => 
  //                   ts.factory.createCaseClause(
  //                     ts.factory.createPropertyAccessChain(
  //                       ts.factory.createIdentifier('SyntaxKind'),
  //                       undefined,
  //                       nodeType.name
  //                     ),
  //                     [
  //                       ts.factory.createExpressionStatement(
  //                         ts.factory.createCallExpression(
  //                           ts.factory.createPropertyAccessChain(
  //                             ts.factory.createThis(),
  //                             undefined,
  //                             `visit${nodeType.name}`
  //                           ),
  //                           undefined,
  //                           [
  //                             ts.factory.createAsExpression(
  //                               ts.factory.createIdentifier('node'),
  //                               ts.factory.createTypeReferenceNode(nodeType.name, undefined)
  //                             )
  //                           ]
  //                         )
  //                       ),
  //                       ts.factory.createBreakStatement(),
  //                     ]
  //                   )
  //                 )
  //               ])
  //             )
  //           ])
  //         ),
  //         ts.factory.createMethodDeclaration(
  //           undefined,
  //           [ ts.factory.createToken(ts.SyntaxKind.ProtectedKeyword) ],
  //           undefined,
  //           `visit${rootNodeName}`,
  //           undefined,
  //           undefined,
  //           [
  //             ts.factory.createParameterDeclaration(
  //               undefined,
  //               undefined,
  //               undefined,
  //               `node`,
  //               undefined,
  //               ts.factory.createTypeReferenceNode(rootNodeName, undefined))
  //           ],
  //           ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
  //           ts.factory.createBlock([])
  //         ),
  //         ...finalSymbols.map(nodeType => ts.factory.createMethodDeclaration(
  //           undefined,
  //           [ ts.factory.createToken(ts.SyntaxKind.ProtectedKeyword) ],
  //           undefined,
  //           `visit${nodeType.name}`,
  //           undefined,
  //           undefined,
  //           [
  //             ts.factory.createParameterDeclaration(
  //               undefined,
  //               undefined,
  //               undefined,
  //               'node',
  //               undefined,
  //               ts.factory.createTypeReferenceNode(nodeType.name, undefined)
  //             )
  //           ],
  //           ts.factory.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
  //           ts.factory.createBlock(
  //             nodeType.predecessors.length === 0
  //               ? [ ts.factory.createExpressionStatement(buildThisCall(`visit${rootNodeName}`, [ 'node' ])) ]
  //               : nodeType.predecessors.map(predecessor => 
  //                 ts.factory.createExpressionStatement(buildThisCall(`visit${predecessor.name}`, [ 'node' ])))
  //           )
  //         ))
  //       ]
  //     )
  //   )
  // }

  generate(sourceFile);

  // export function kindToString(kind: SyntaxKind): string {
  //   if (SyntaxKind[kind] === undefined) {
  //     throw new Error('This SyntaxKind value that was passed in is not valid.');
  //   }
  //   return SyntaxKind[kind];
  // }
  writeNode(
    ts.factory.createFunctionDeclaration(
      undefined,
      [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
      undefined,
      'kindToString',
      undefined,
      [
        ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          undefined,
          'kind',
          undefined,
          ts.factory.createTypeReferenceNode('SyntaxKind', undefined)
        )
      ],
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      ts.factory.createBlock([
        ts.factory.createIfStatement(
          buildEquality(
            ts.factory.createElementAccessChain(
              ts.factory.createIdentifier('SyntaxKind'),
              undefined,
              ts.factory.createIdentifier('kind')
            ),
            ts.factory.createIdentifier('undefined')
          ),
          buildThrowError('The SyntaxKind value that was passed in is not valid.')
        ),
        ts.factory.createReturnStatement(
          ts.factory.createElementAccessChain(
            ts.factory.createIdentifier('SyntaxKind'),
            undefined,
            ts.factory.createIdentifier('kind')
          )
        )
      ])
    )
  )

  const rootUnionModfiers = [];
  if (hasModifier(rootDeclaration.modifiers, ts.SyntaxKind.ExportKeyword)) {
    rootUnionModfiers.push(ts.factory.createToken(ts.SyntaxKind.ExportKeyword));
  }

  // export type Syntax
  //   = A
  //   | B
  //   ...
  writeNode(
    ts.factory.createTypeAliasDeclaration(
      undefined,
      rootUnionModfiers,
      rootNodeName,
      undefined,
      ts.factory.createUnionTypeNode(
        nodeTypes.map(nodeType => ts.factory.createTypeReferenceNode(nodeType.name, undefined))
      )
    )
  )

  // export const NODE_TYPES = {
  //   A,
  //   B,
  //   ...
  // }
  writeNode(
    ts.factory.createVariableStatement(
      [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            'NODE_TYPES',
            undefined,
            undefined,
            ts.factory.createObjectLiteralExpression(
              nodeTypes.map(nodeType => ts.factory.createShorthandPropertyAssignment(nodeType.name, undefined))
            )
          )
        ],
        ts.NodeFlags.Const,
      )
    )
  );

  // export enum SyntaxKind {
  //   A,
  //   B,
  //   ...
  // }
  writeNode(
    ts.factory.createEnumDeclaration(
      undefined,
      [ ts.factory.createToken(ts.SyntaxKind.ExportKeyword) ],
      'SyntaxKind',
      nodeTypes.map(nodeType => ts.factory.createEnumMember(nodeType.name)),
    )
  )

  write(`
export function setParents(node: ${rootNodeName}, parentNode: ${rootNodeName} | null = null): void {
  // We cast to any here because parentNode is strongly typed and not generic
  // enough to accept arbitrary AST nodes
  node.parentNode = parentNode as any;
  for (const childNode of node.getChildNodes()) {
    setParents(childNode, node);
  }
}
`);

  return out;

}

