
import ts from "typescript"
import { areTypesDisjoint, convertToClassElement, findConstructor, hasClassModifier, hasModifier, isKeywordType, isNodeExported, makePublic, removeClassModifiers } from "./helpers";

import { DeclarationResolver, Symbol } from "./resolver";
import { assert, implementationLimitation, memoise } from "./util";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
}

function first<T1, T2>(tuple: [T1, T2]): T1 {
  return tuple[0];
}

function second<T1, T2>(tuple: [T1, T2]): T2 {
  return tuple[1];
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

export default function generateCode(sourceFile: ts.SourceFile, options: CodeGeneratorOptions = {}): string {

  let out = '';

  const generateIdField = true;
  const parentMemberName = 'parentNode';
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

  function writeCustomNode(node: ts.Node): void {
    if (!hasModifier(node.modifiers, ts.SyntaxKind.DeclareKeyword)) {
      writeNode(node);
    }
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
              if (hasClassModifier(param.modifiers)) {
                const classElement = convertToClassElement(param);
                implementationLimitation(classElement !== null);
                result.push(classElement);
              }
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

  const getAllNodeTypesDerivingFrom = memoise((symbol: Symbol): Symbol[] => {
    if (isNodeType(symbol)) {
      return [ symbol ]
    }
    if (isIntermediate(symbol)) {
      return symbol.allExtendsTo.filter(otherSymbol => isNodeType(otherSymbol))
    }
    if (isVariant(symbol)) {
    }
    return [];
  }, 'id');

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
    if (ts.isArrayTypeNode(typeNode)) {
      return getAllNodeTypesInTypeNode(typeNode.elementType);
    }
    if (ts.isLiteralTypeNode(typeNode) || isKeywordType(typeNode)) {
      return [];
    }
    throw new Error(`Could not find references to AST nodes in type: type ${ts.SyntaxKind[typeNode.kind]} is too complex to process by this tool`);
  }

  const getAllToplevelNodeTypesInTypeNode = (typeNode: ts.TypeNode): Symbol[] => {
    if (ts.isTypeReferenceNode(typeNode)) {
      const symbol = resolver.resolveTypeReferenceNode(typeNode);
      if (symbol === null || !isAST(symbol)) {
        return [];
      }
      return [ symbol ]
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const result = [];
      for (const elementTypeNode of typeNode.types) {
        result.push(...getAllToplevelNodeTypesInTypeNode(elementTypeNode))
      }
      return result;
    }
    if (ts.isArrayTypeNode(typeNode) || ts.isLiteralTypeNode(typeNode) || isKeywordType(typeNode)) {
      return [];
    }
    throw new Error(`Could not find references to AST nodes in type: type ${ts.SyntaxKind[typeNode.kind]} is too complex to process by this tool`);
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
          const referencedNodeTypes = getAllNodeTypesDerivingFrom(referencedSymbol);
          if (referencedNodeTypes.indexOf(nodeType) !== -1) {
            result.push(otherSymbol);
          }
        }
      }
    }
    return result;
  }, 'id');

  const getAutoCasts = (typeNode: ts.TypeNode): Array<[ts.TypeNode, Symbol]> => {
    const result: Array<[ts.TypeNode, Symbol]> = [];
    for (const symbol of getAllToplevelNodeTypesInTypeNode(typeNode)) {
      const typesToCheck: Array<[ts.TypeNode, Symbol]> = [];
      const nodeTypes = getAllNodeTypesDerivingFrom(symbol)
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

    const visitSymbol = (currSymbol: Symbol, onlyOptional: boolean, ownMember: boolean) => {

      // Find any constructor signature or declaration. If found, we will use
      // the parameters of this constructor as the parameters that should be
      // returned by this function.
      let constructorDeclaration = null;
      for (const declaration of currSymbol.declarations) {
        assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
        const constructor = findConstructor(declaration);
        if (constructor !== null) {
          constructorDeclaration = constructor;
          break;
        }
      }

      if (constructorDeclaration !== null) {

        // If we found a constructor or a constructor signature, then the
        // signature serves as the list of parameters this node type accepts.
        // We perform some small checks to make sure we have only nodes we're
        // interested in and add the 'public' if requested.
        for (const param of constructorDeclaration.parameters) {
          if ((param.questionToken !== undefined || param.initializer !== undefined) === onlyOptional) {
            result.push(
              ts.factory.createParameterDeclaration(
                param.decorators,
                isConstructor && ownMember ? makePublic(param.modifiers) : removeClassModifiers(param.modifiers),
                param.dotDotDotToken,
                param.name,
                param.questionToken,
                param.type,
                param.initializer
              )
            );
          }
        }

        // A constructor should contain all parameters of all the base
        // classes, so we shouldn't contiue with searching for more.
        return false;

      } else {

        // The curent symbol did not have a constructor, so we assume that
        // all members are added as-is to the fields of the node type.
        // We perform some small checks to make sure we have only nodes we're
        // interested in and add the 'public' if requested.
        for (const declaration of currSymbol.declarations) {
          assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
          for (const member of declaration.members) {
            if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
              implementationLimitation(ts.isIdentifier(member.name));
              if ((member.questionToken !== undefined || member.initializer !== undefined) === onlyOptional) {
                result.push(
                  ts.factory.createParameterDeclaration(
                    member.decorators,
                    isConstructor && ownMember ? makePublic(member.modifiers) : removeClassModifiers(member.modifiers),
                    undefined,
                    member.name,
                    member.questionToken,
                    member.type,
                    member.initializer
                  )
                );
              }
            }
          }
        }

      }

      // If we got here there were no early returns indicating that the visitor
      // should stop visiting the current inheritance chain. Just signal the visitor
      // that it may continue.
      return true;
    }

    const inheritanceChains: Symbol[][] = [];

    const generateInheritanceChains = (symbol: Symbol, path: Symbol[]) => {
      if (symbol.inheritsFrom.length === 0) {
        inheritanceChains.push(path);
      }
      for (const inheritedSymbol of symbol.inheritsFrom) {
        generateInheritanceChains(inheritedSymbol, [...path, inheritedSymbol ])
      }
    }

    generateInheritanceChains(symbol, [ symbol ]);

    const visitBottomUp = (onlyOptional = false) => {

      // First we visit the symbol itself and add any members we're interested
      // in to the result.
      if (!visitSymbol(symbol, onlyOptional, true)) {
        return;
      }

      const visited = new Set<Symbol>();

      // Next we walk though each individual inheritance chain, skipping a
      // chain if `visitSymbol` returned false. Usually, this means a
      // constructor was defined that consumes all parameters.
      for (const chain of inheritanceChains) {

        // Indicates whether the parameter belongs to `symbol` or to another base class.
        // Interfaces do not set this variable to false. Only class declarations can do that.
        let ownMembers = true;

        for (const inheritedSymbol of chain.slice(1)) {
          if (inheritedSymbol.declarations.some(ts.isClassDeclaration)) {
            ownMembers = false;
          }
          if (visited.has(inheritedSymbol)) {
            // We only get here if the remaining part of the inheritance chain
            // has already been visited.
            break;
          }
          visited.add(inheritedSymbol);
          if (!visitSymbol(inheritedSymbol, onlyOptional, ownMembers)) {
            break;
          }
        }
      }
    }

    visitBottomUp(false);
    visitBottomUp(true);

    return result;
  }

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

  function buildPredicateFromTypeNode(type: ts.TypeNode, value: ts.Expression): ts.Expression {
    if (ts.isArrayTypeNode(type)) {
      return ts.factory.createCallExpression(
        ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Array'), 'isArray'),
        undefined,
        [ value ]
      );
    }
    if (ts.isUnionTypeNode(type)) {
      return buildBinaryExpression(
        ts.SyntaxKind.BarBarToken,
        type.types.map(elementType => buildPredicateFromTypeNode(elementType, value))
      )
    }
    if (ts.isTypeReferenceNode(type)) {
      if (type.typeName.getText() === 'Array'
          && type.typeArguments !== undefined) {
        return ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Array'), 'isArray'),
          undefined,
          [ value ]
        );
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
    }
    if (isKeywordType(type)) {
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

  const rootSymbol = resolver.resolve(rootNodeName, sourceFile);

  if (rootSymbol === null) {
    throw new Error(`A declaration of a root node named '${rootNodeName} was not found. tsastgen needs a root node to generate an AST.`)
  }
  const rootDeclaration = rootSymbol.declarations[0];
  if (!(ts.isClassDeclaration(rootDeclaration) || ts.isInterfaceDeclaration(rootDeclaration))) {
    throw new Error(`The root node '${rootNodeName}' must be a class or interface declaration.`)
  }

  function parameterToReference(param: ts.ParameterDeclaration): ts.Identifier {
    implementationLimitation(ts.isIdentifier(param.name));
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
          rootDeclaration.members.map((decl: ts.ClassElement | ts.TypeElement) => {
            const classElement = convertToClassElement(decl);
            implementationLimitation(classElement !== null);
            return classElement;
          }),
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
      writeCustomNode(node);
      return;
    }

    const exportModifier = []
    if (isNodeExported(node)) {
      exportModifier.push(ts.factory.createModifier(ts.SyntaxKind.ExportKeyword));
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

      assert(ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node));

      const parentSymbols = getAllNodeTypesHavingSymbolInField(symbol);
      const childSymbols = getAllASTInFieldsOfSymbol(symbol);
      const membersWithAST = getAllMembers(symbol).filter(member =>
        (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member))
        && member.type !== undefined
        && getAllNodeTypesInTypeNode(member.type).length > 0) as ts.PropertyDeclaration[];

      let constructor = null;
      for (const member of node.members) {
        if (ts.isConstructorDeclaration(member)) {
          constructor = member;
          break;
        }
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

      if (constructor === null) {
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
        );
      }

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
        for (const member of node.members) {
          if (generateParentNodes
              && member.name !== undefined
              && member.name.getText() === parentMemberName) {
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
            );
          } else {
            classMembers.push(member);
          }
        }
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
          exportModifier,
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
          exportModifier,
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

      // function isX(value: any) {
      //   return value.kind === SyntaxKind.X;
      // }
      writeNode(
        ts.factory.createFunctionDeclaration(
          undefined,
          exportModifier,
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
              ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword),
              undefined
            )
          ],
          ts.factory.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword),
          ts.factory.createBlock([
            ts.factory.createReturnStatement(
              buildEquality(
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier('value'),
                  'kind'
                ),
                ts.factory.createPropertyAccessExpression(
                  ts.factory.createIdentifier('SyntaxKind'),
                  symbol.name
                )
              )
            )
          ])
        )
      )

      for (const param of factoryParameters) {
        if (param.type === undefined) {
          continue;
        }
        implementationLimitation(ts.isIdentifier(param.name));
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
          exportModifier,
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
                factoryParameters.map(parameterToReference)
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
    writeCustomNode(node);

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

  if (generateParentNodes) {
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
  }

  return out;

}

