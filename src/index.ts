
import ts from "typescript"
import { convertToReference, areTypesDisjoint, convertToClassElement, findConstructor, hasClassModifier, hasModifier, isKeywordType, isNodeExported, addPublicModifier, removeClassModifiers, makePublic, isSuperCall, convertToParameter, clearModifiers } from "./helpers";

import { DeclarationResolver, Symbol } from "./resolver";
import { assert, implementationLimitation, memoise } from "./util";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
  parentMemberName?: string | null;
  idMemberName?: string | null;
  generateVisitor?: boolean;
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

export default function generateCode(sourceFile: ts.SourceFile, {
  idMemberName = 'id',
  parentMemberName = null,
  rootNodeName = 'Syntax',
  generateVisitor = true,
}: CodeGeneratorOptions = {}): string {

  let out = '';

  const resolver = new DeclarationResolver();

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

  const isTypeNodeOnlyReferencingAST = (node: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(node)) {
      return node.types.every(isTypeNodeOnlyReferencingAST);
    }
    if (ts.isTypeReferenceNode(node)) {
      const symbol = resolver.resolveTypeReferenceNode(node);
      return symbol !== null && isAST(symbol);
    }
    return false;
  }

  const isVariant = memoise((symbol: Symbol): boolean => {
    return symbol.isTypeAlias()
        && isTypeNodeOnlyReferencingAST(symbol.asTypeAliasDeclaration().type);
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
      const result = new Set<Symbol>();
      for (const referencedSymbol of getAllNodeTypesInTypeNode(symbol.asTypeAliasDeclaration().type)) {
        for (const derivedSymbol of getAllNodeTypesDerivingFrom(referencedSymbol)) {
          result.add(derivedSymbol)
        }
      }
      return [...result];
    }
    return [];
  }, 'id');

  const isAST = (symbol: Symbol): boolean => {
    return symbol === rootSymbol || isVariant(symbol) || isIntermediate(symbol) || isNodeType(symbol);
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

  const getAllASTTypesInTypeNode = (typeNode: ts.TypeNode): Symbol[] => {
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
        result.push(...getAllASTTypesInTypeNode(elementTypeNode))
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
    for (const declaration of getAllFieldDeclarations(symbol)) {
      if (declaration.type !== undefined) {
        for (const referencedSymbol of resolver.getReferencedSymbolsInTypeNode(declaration.type)) {
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

  const getCoercions = (typeNode: ts.TypeNode): Array<[ts.TypeNode, Symbol]> => {
    const result: Array<[ts.TypeNode, Symbol]> = [];
    for (const symbol of getAllASTTypesInTypeNode(typeNode)) {
      const typesToCheck: Array<[ts.TypeNode, Symbol]> = [];
      const nodeTypes = getAllNodeTypesDerivingFrom(symbol)
      for (const nodeType of nodeTypes) {
        const requiredParameters = getFactoryParameters(nodeType).filter(p => p.questionToken === undefined && p.initializer === undefined)
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

  function addCoercionsToParameter(param: ts.ParameterDeclaration) {
    return ts.factory.createParameterDeclaration(
      param.decorators,
      param.modifiers,
      param.dotDotDotToken,
      param.name,
      param.questionToken,
      param.type !== undefined
        ? ts.factory.createUnionTypeNode([param.type, ...getCoercions(param.type).map(([typeNode, symbol]) => typeNode)])
        : undefined,
      param.initializer
    )
  }

  /**
   * Visits all inheritance chains of the given symbol one-by-one and skip the
   * current chain if the visitor returned false.
   */
  function visitInheritanceChains(symbol: Symbol, visit: (inheritedSymbol: Symbol) => boolean | void) {

    const inheritanceChains: Symbol[][] = [];

    const generateInheritanceChains = (symbol: Symbol, currChain: Symbol[]) => {
      if (symbol.inheritsFrom.length === 0) {
        inheritanceChains.push(currChain);
      }
      for (const inheritedSymbol of symbol.inheritsFrom) {
        generateInheritanceChains(inheritedSymbol, [...currChain, inheritedSymbol ])
      }
    }

    generateInheritanceChains(symbol, [ symbol ]);

    const visitBottomUp = () => {

      // First we visit the symbol itself and add any members we're interested
      // in to the result.
      if (visit(symbol) === false) {
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
          if (!visit(inheritedSymbol)) {
            break;
          }
        }

      }

    }

    visitBottomUp();

  }

  /**
   * Finds all declarations that would be required when constructing the given node type.
   * 
   * Declarations that should be part of the node type passed in are made
   * 'public', while the rest do not have any class modifiers. 
   */
  const getFactoryParameters = memoise((symbol: Symbol): Array<ts.PropertySignature | ts.PropertyDeclaration | ts.ParameterDeclaration> => {

    const result: Array<ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration> = [];

    visitInheritanceChains(symbol, (inheritedSymbol: Symbol) => {

      // Find any constructor signature or declaration. If found, we will use
      // the construtor's parameters as the last parameters of this inheritance chain.
      for (const declaration of inheritedSymbol.declarations) {
        assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
        const constructor = findConstructor(declaration);
        if (constructor !== null) {
          for (const param of constructor.parameters) {
            result.push(inheritedSymbol === symbol
              ? param
              : clearModifiers(param) as ts.ParameterDeclaration);
          }
          return false;
        }
      }

      // The curent symbol did not have a constructor, so we assume that
      // all members are added as-is to the fields of the node type.
      // We perform some small checks to make sure we have only nodes we're
      // interested in and add 'public' to indicate this parameter belongs to
      // the original symbol.
      for (const declaration of inheritedSymbol.declarations) {
        assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
        for (const member of declaration.members) {
          if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
            implementationLimitation(ts.isIdentifier(member.name));
            result.push(makePublic(member) as ts.PropertySignature | ts.PropertyDeclaration);
          }
        }
      }

    });

    return result;

  }, 'id');

  const getAllFieldDeclarations = memoise((symbol: Symbol): Array<ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration> => {

    const result: Array<ts.PropertyDeclaration| ts.PropertySignature | ts.ParameterDeclaration> = [];

    visitInheritanceChains(symbol, (currSymbol: Symbol) => {

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
        // signature serves as the list of parameters this part of the node type accepts.
        for (const param of constructorDeclaration.parameters) {
          if (param.name.getText() === parentMemberName) {
            continue;
          }
          result.push(param);
        }

        // A constructor should contain all parameters of all the base
        // classes, so we shouldn't contiue with searching for more base classes.
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
              if (member.name.getText() === parentMemberName) {
                continue;
              }
              result.push(member);
            }
          }
        }

      }

    });

    return [
      ...result.filter(node => node.questionToken === undefined && node.initializer === undefined),
      ...result.filter(node => node.questionToken !== undefined || node.initializer !== undefined)
    ];

  }, 'id');

  function transformHeritageClauses(heritageClauses: ts.NodeArray<ts.HeritageClause> | undefined) {

    // No heritage clauses means no transformed heritage clauses.
    if (heritageClauses === undefined) {
      return []
    }

    // This will contain the elements of the 'extends' and 'implements'
    // heritage clauses, respectively.
    const extendsExprs = [];
    const implementsExprs = [];

    for (const heritageClause of heritageClauses) {

      for (const exprWithArgs of heritageClause.types) {

        implementationLimitation(ts.isIdentifier(exprWithArgs.expression))

        const symbol = resolver.resolve(exprWithArgs.expression.getText(), exprWithArgs);

        if (symbol == null || !isAST(symbol)) {

          const shouldUseImplements = symbol !== null && symbol.declarations.every(ts.isInterfaceDeclaration);

          // We only get here if a declaration for the given 'extends' or
          // 'implements' type element was not found. If this is case, we just
          // pass trough the element to the right place.
          if (heritageClause.token === ts.SyntaxKind.ImplementsKeyword || shouldUseImplements) {
            implementsExprs.push(exprWithArgs);
          } else {
            extendsExprs.push(exprWithArgs);
          }

          continue;

        }

        // If the symbol refers to a declaration that was explicitly defined
        // as a class, then we should use the 'extends' keyword. If it was an
        // interface, we can safely skip over it.  As an exception, the root
        // symbol always refers to a class even if it was declared as an
        // interface.
        if (symbol.declarations.some(ts.isClassDeclaration) || symbol === rootSymbol) {
          extendsExprs.push(
            ts.factory.createExpressionWithTypeArguments(
              ts.factory.createIdentifier(`${symbol.name}Base`),
              exprWithArgs.typeArguments
            )
          );
        } else {
          extendsExprs.push(
            ts.factory.createExpressionWithTypeArguments(
              ts.factory.createIdentifier(`${symbol.name}Base`),
              exprWithArgs.typeArguments
            )
          );
        }

      }

    }

    const result = []
    if (extendsExprs.length > 0) {
      result.push(
        ts.factory.createHeritageClause(
          ts.SyntaxKind.ExtendsKeyword,
          extendsExprs
        )
      )
    }
    if (implementsExprs.length > 0) {
      result.push(
        ts.factory.createHeritageClause(
          ts.SyntaxKind.ImplementsKeyword,
          implementsExprs
        )
      )
    }
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
    if (isKeywordType(type)) {
      return null;
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

      implementationLimitation(node.name !== undefined)
      // export class XBase extends ... {
      //   ...
      // }
      writeNode(
        ts.factory.createClassDeclaration(
          node.decorators,
          node.modifiers,
          `${node.name.getText()}Base`,
          node.typeParameters,
          transformHeritageClauses(node.heritageClauses),
          ts.isClassDeclaration(node) ? node.members : [],
        )
      )

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
              ts.factory.createTypeReferenceNode(rootNodeName)
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
                      ts.factory.createIdentifier(`${rootNodeName}Kind`),
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
              ts.factory.createTypeReferenceNode(rootNodeName)
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
                getAllNodeTypesDerivingFrom(symbol).map(node => 
                  buildEquality(
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier('value'),
                      undefined,
                      'kind'
                    ),
                    ts.factory.createPropertyAccessChain(
                      ts.factory.createIdentifier(`${rootNodeName}Kind`),
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
      const membersWithAST = getFactoryParameters(symbol)
        .filter(member => hasClassModifier(member.modifiers))
        .filter(member => getAllNodeTypesInTypeNode(member.type!).length > 0);

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
            ts.factory.createIdentifier(`${rootNodeName}Kind`),
            undefined,
            symbol.name
          ),
        )
      )

      if (parentMemberName !== null) {
        classMembers.push(
          // public parentNode: XParent | null = null;
          ts.factory.createPropertyDeclaration(
            undefined,
            undefined,
            parentMemberName,
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
      }

      if (constructor === null) {
        const constructorParameters = getFactoryParameters(symbol);
        classMembers.push(
          // constructor(public field: T, ...) { super(field...) }
          ts.factory.createConstructorDeclaration(
            undefined,
            undefined,
            [
              ...constructorParameters.map(convertToParameter),
            ],
            ts.factory.createBlock([
              ts.factory.createExpressionStatement(
                ts.factory.createCallExpression(
                  ts.factory.createSuper(),
                  undefined,
                  constructorParameters.filter(param => !hasClassModifier(param.modifiers)).map(convertToReference)
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
          if (member.name !== undefined
              && member.name.getText() === parentMemberName) {
            continue;
          }
          classMembers.push(member);
        }
      }

      writeNode(
        // class X extends SyntaxBase {
        //   ...
        // }
        ts.factory.createClassDeclaration(
          undefined,
          node.modifiers,
          symbol.name,
          undefined,
          transformHeritageClauses(node.heritageClauses),
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

      const factoryParameters = getFactoryParameters(symbol)
        .map(convertToParameter)
        .map(clearModifiers) as ts.ParameterDeclaration[];
      const coercionStatements = [];

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
                  ts.factory.createIdentifier(`${rootNodeName}Kind`),
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
        for (const [typeToCastFrom, nodeType]  of getCoercions(param.type)) {
          coercionStatements.push(
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
            ...factoryParameters.map(addCoercionsToParameter),
          ],
          ts.factory.createTypeReferenceNode(symbol.name, undefined),
          ts.factory.createBlock([
            ...coercionStatements,
            ts.factory.createReturnStatement(
              ts.factory.createNewExpression(
                ts.factory.createIdentifier(symbol.name),
                undefined,
                factoryParameters.map(convertToReference)
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
  //                       ts.factory.createIdentifier(`${rootNodeName}Kind`),
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
          ts.factory.createTypeReferenceNode(`${rootNodeName}Kind`, undefined)
        )
      ],
      ts.factory.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      ts.factory.createBlock([
        ts.factory.createIfStatement(
          buildEquality(
            ts.factory.createElementAccessChain(
              ts.factory.createIdentifier(`${rootNodeName}Kind`),
              undefined,
              ts.factory.createIdentifier('kind')
            ),
            ts.factory.createIdentifier('undefined')
          ),
          buildThrowError('The SyntaxKind value that was passed in is not valid.')
        ),
        ts.factory.createReturnStatement(
          ts.factory.createElementAccessChain(
            ts.factory.createIdentifier(`${rootNodeName}Kind`),
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
      `${rootNodeName}Kind`,
      nodeTypes.map(nodeType => ts.factory.createEnumMember(nodeType.name)),
    )
  )

  if (parentMemberName !== null) {
    write(`
export function setParents(node: ${rootNodeName}, parentNode: ${rootNodeName} | null = null): void {
  // We cast to any here because parentNode is strongly typed and not generic
  // enough to accept arbitrary AST nodes
  (node as any).${parentMemberName} = parentNode;
  for (const childNode of node.getChildNodes()) {
    setParents(childNode, node);
  }
}
`);
  }

  return out;

}

