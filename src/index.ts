
import ts, { createBinary } from "typescript"

import { map, assert, FastMap, fatal, depthFirstSearch, hasSome, filter } from "./util";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
}

function isClassSpecificMemberModifier(modifier: ts.Modifier): boolean {
  return modifier.kind === ts.SyntaxKind.AbstractKeyword
      || modifier.kind === ts.SyntaxKind.PublicKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword
      || modifier.kind === ts.SyntaxKind.PrivateKeyword
}

function hasModifier(node: ts.Node, kind: ts.Modifier['kind']): boolean {
  if (node.modifiers === undefined) {
    return false;
  }
  return [...node.modifiers].find(m => m.kind === kind) !== undefined;
}

function buildThisCall(memberName: string, args: (string | ts.Expression)[]): ts.CallExpression {
  return ts.createCall(
    ts.createPropertyAccess(
      ts.createThis(),
      memberName
    ),
    undefined,
    args.map(arg => typeof(arg) === 'string' ? ts.createIdentifier(arg) : arg),
  )
}

function convertToClassElement(node: ts.ClassElement | ts.TypeElement): ts.ClassElement {
  if (ts.isClassElement(node)) {
    return node;
  }
  if (ts.isPropertySignature(node)) {
    const newModifiers = node.modifiers === undefined ? [] : [...node.modifiers];
    if (hasModifier(node, ts.SyntaxKind.AbstractKeyword)) {
      newModifiers.push(ts.createToken(ts.SyntaxKind.AbstractKeyword));
    }
    return ts.createProperty(
      node.decorators,
      newModifiers,
      node.name,
      node.questionToken,
      node.type,
      undefined,
    )
  }
  throw new Error(`Support for converting an interface declaration to an abstract class is very limited right now.`)
}

function buildCond(cases: [ts.Expression, ts.Statement][]): ts.IfStatement {
  const [test, then] = cases[cases.length-1]
  let result = ts.createIf(test, then)
  for (let i = cases.length-1; i >= 0; i++) {
    const [test, then] = cases[i];
    result = ts.createIf(test, then, result)
  }
  return result;
}

function buildEquality(left: ts.Expression, right: ts.Expression): ts.Expression {
  return ts.createBinary(
    left,
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    right
  )
}

function buildThrowError(message: string) {
  return ts.createThrow(
    ts.createNew(
      ts.createIdentifier('Error'),
      undefined,
      [ ts.createStringLiteral(message) ]
    )
  )
}

function buildBinaryExpression(operator: ts.BinaryOperator, args: ts.Expression[]) {
  let result = args[0]
  for (let i = 1; i < args.length; i++) {
    result = ts.createBinary(result, operator, args[i]);
  }
  return result;
}

function hasHeritageClauses(node: ts.Node): node is ts.ClassLikeDeclaration {
  return (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))
      && node.heritageClauses !== undefined;
}

function isSpecialDeclaration(node: ts.Node): node is ts.ClassLikeDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return (ts.isClassDeclaration(node) && node.name !== undefined)
      || ts.isInterfaceDeclaration(node)
      || (ts.isTypeAliasDeclaration(node) && node.typeParameters === undefined);
}

function mayIntroduceNewASTNode(node: ts.Node): node is ts.ClassLikeDeclaration | ts.InterfaceDeclaration {
  return (ts.isClassDeclaration(node) && node.name !== undefined)
      || ts.isInterfaceDeclaration(node);
}

function getNameOfDeclarationAsString(node: ts.NamedDeclaration): string {
  assert(node.name !== undefined)
  return node.name!.getText();
}

function isNodeExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
    (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
  );
}

interface DeclarationInfo<T extends ts.Node = ts.Node> {
  name: string;
  declaration: T;
  predecessors: DeclarationInfo[];
  successors: DeclarationInfo[];
}

type ClassDeclaration = DeclarationInfo<ts.ClassDeclaration>;
type InterfaceDeclaration = DeclarationInfo<ts.InterfaceDeclaration>
type TypeAliasDeclaration = DeclarationInfo<ts.TypeAliasDeclaration>
type SpecialDeclaration = ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration;

export default function generateCode(sourceFile: ts.SourceFile, options?: CodeGeneratorOptions): string {

  let out = '';
  const declarationsToSkip = [ 'SyntaxKind' ];
  const rootNodeName = options?.rootNodeName ?? 'SyntaxBase';
  const declarations = new FastMap<string, SpecialDeclaration>();
  let rootNode: ts.ClassDeclaration | ts.InterfaceDeclaration | null = null;

  const printer = ts.createPrinter();

  function writeNode(node: ts.Node): void {
    out += printer.printNode(ts.EmitHint.Unspecified, node, sourceFile) + '\n\n'
  }

  function getAllSuccessorsIncludingSelf(node: SpecialDeclaration): IterableIterator<SpecialDeclaration> {
    return depthFirstSearch(node, 
      node => node.successors as SpecialDeclaration[]);
  }

  function *getAllNodesHavingNodeInField(node: SpecialDeclaration): IterableIterator<SpecialDeclaration> {
    const visited = new Set<SpecialDeclaration>();
    const stack = [...declarations.values()]
    outer: while (stack.length > 0) {
      const info = stack.pop()!;
      if (visited.has(info)) {
        continue;
      }
      visited.add(info);
      if (info.successors.length > 0) {
        for (const successor of info.successors) {
          stack.push(successor as SpecialDeclaration);
        }
      } else {
        for (const referencedNode of getAllNodesInFieldsOfNode(info)) {
          for (const predecessor of getAllSuccessorsIncludingSelf(referencedNode)) {
            if (predecessor === node) {
              yield info;
              continue outer;
            }
          }
        }
      }
    }
  }

  function *getAllReferencedNodesInTypeNode(node: ts.TypeNode): IterableIterator<SpecialDeclaration> {
    if (ts.isTypeReferenceNode(node)) {
      if (ts.isIdentifier(node.typeName)) {
        const referencedNode = declarations.get(node.typeName.getText());
        if (referencedNode !== undefined) {
          yield referencedNode;
        }
      }
    } else if (ts.isUnionTypeNode(node)) {
      for (const elementTypeNode of node.types) {
        yield* getAllReferencedNodesInTypeNode(elementTypeNode);
      }
    } else if (ts.isArrayTypeNode(node)) {
      yield* getAllReferencedNodesInTypeNode(node.elementType);
    }
  }

  function getAllRelevantMembers(node: SpecialDeclaration): ts.PropertySignature[] {
    return getAllMembers(node).filter(member => hasSome(getAllReferencedNodesInTypeNode(member.type!)));
  }

  function getAllMembers(node: SpecialDeclaration): ts.PropertySignature[] {

    const visited = new Set();

    // We use a queue and not a stack because we will perform a breadth-first search as opposed to a depth-first search.
    // Doing this ensures that the members are produces in the order they are inherited.
    const queue: DeclarationInfo[] = [ node ];

    const results = [];

    while (queue.length > 0) {

      const currNode = queue.shift()!;

      if (visited.has(currNode)) {
        continue;
      }
      visited.add(currNode);

      if (mayIntroduceNewASTNode(currNode.declaration)) {

        // Whether it be an abstract class or a simple interface, we only care about the property signatures that are public.
        for (const member of currNode.declaration.members) {
          if (ts.isPropertySignature(member) && member.type !== undefined) {
            results.push(member);
          }
        }

        // We should not forget to scan for fields in one of the declarations this declaration inherited from.
        for (const predecessor of currNode.predecessors) {
          queue.push(predecessor);
        }

      } else {

        // If it is not a class-like declaration, it can only be a type declaration. Most likely,
        // it is a union of sever other AST node declarations.
        // It does not make sense to find the nodes that extend this type. Instead, we should look for the
        // deepest successors in the inheritance tree, which correspond to the union type's final elements (if any).
        for (const successor of currNode.successors) {
          queue.push(successor);
        }

      }

    }

    return results;
  }

  function *getAllNodesInFieldsOfNode(node: SpecialDeclaration): IterableIterator<SpecialDeclaration> {
    for (const member of getAllRelevantMembers(node)) {
      if (member.type !== undefined) {
        for (const node of getAllReferencedNodesInTypeNode(member.type)) {
          yield node;
        }
      }
    }
  }

  function spread<T>(iterator: Iterator<T>): T[] {
    const result = []
    while (true) {
      const { done, value } = iterator.next();
      if (done) {
        break;
      }
      result.push(value);
    }
    return result;
  }

  function *mapToFinalNodes(declarations: Iterator<SpecialDeclaration>): IterableIterator<SpecialDeclaration> {
    const visited = new Set();
    const stack = spread(declarations);
    while (stack.length > 0) {
      const declaration = stack.pop()!;
      if (visited.has(declaration)) {
        continue;
      }
      visited.add(declaration);
      if (declaration.successors.length === 0) {
        yield declaration; 
      } else {
        for (const successor of declaration.successors) {
          stack.push(successor as SpecialDeclaration);
        }
      }
    }
  }

  function buildPredicateFromTypeNode(type: ts.TypeNode, value: ts.Expression): ts.Expression {
    if (ts.isArrayTypeNode(type)) {
      return createBinary(
        ts.createCall(ts.createIdentifier('isArray'), undefined, [ value ]),
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.createCall(
          ts.createPropertyAccess(value, 'every'),
          undefined,
          [
            ts.createArrowFunction(
              undefined,
              undefined,
              [ ts.createParameter(undefined, undefined, undefined, 'element'), ts.createParameter(undefined, undefined, undefined, 'i') ],
              undefined,
              undefined,
              buildPredicateFromTypeNode(type.elementType, ts.createElementAccess(value, ts.createIdentifier('i')))
            )
          ]
        )
      )
    } else if (ts.isUnionTypeNode(type)) {
      return buildBinaryExpression(
        ts.SyntaxKind.BarBarToken,
        type.types.map(elementType => buildPredicateFromTypeNode(elementType, value))
      )
    } else if (ts.isTypeReferenceNode(type)) {
      if (!ts.isIdentifier(type.typeName)) {
        throw new Error(`Node is too complex to be processed.`)
      }
      const info = declarations.get(type.typeName.getText());
      if (info === undefined) {
        throw new Error(`Could not find a declaration for '${type.typeName.getText()}'.`)
      }
      return ts.createBinary(value, ts.SyntaxKind.InstanceOfKeyword, type.typeName)
    } else {
      switch (type.kind) {
        case ts.SyntaxKind.NeverKeyword:
          return ts.createFalse();
        case ts.SyntaxKind.AnyKeyword:
          return ts.createTrue();
        case ts.SyntaxKind.StringKeyword:
          return buildEquality(value, ts.createStringLiteral('string'));
        case ts.SyntaxKind.NullKeyword:
          return buildEquality(value, ts.createNull());
        case ts.SyntaxKind.BooleanKeyword:
          return buildEquality(value, ts.createStringLiteral('boolean'));
        case ts.SyntaxKind.NumberKeyword:
          return buildEquality(value, ts.createStringLiteral('number'));
      }
    }
    throw new Error(`Could not convert TypeScript type node to a type guard.`)
  }

  function *buildFieldParameters(node: SpecialDeclaration, modifiers: ts.Modifier[] = []): IterableIterator<ts.ParameterDeclaration> {
    for (const member of getAllMembers(node)) {
      if (ts.isPropertySignature(member)) {
        yield ts.createParameter(
          undefined,
          modifiers,
          undefined,
          member.name as ts.Identifier,
          undefined,
          member.type,
          undefined,
        )
      }
    }
  }

  function hasDirectReferenceToNode(node: ts.TypeNode): boolean {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && declarations.has(node.typeName.getText())) {
      return true;
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.some(node => hasDirectReferenceToNode(node));
    }
    // FIXME Type aliases are not resolved.
    return false;
  }

  function getArrayElementType(node: ts.TypeNode): ts.TypeNode | null {
    if (ts.isArrayTypeNode(node) && hasDirectReferenceToNode(node.elementType)) {
      return node.elementType;
    }
    if (ts.isUnionTypeNode(node)) {
      for (const type of node.types) {
        if (type !== null) {
          return type;
        }
      }
    }
    // FIXME Type aliases are not resolved.
    return null;
  }

  function isNullable(node: ts.TypeNode): boolean {
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return true;
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.some(node => isNullable(node));
    }
    // FIXME Type aliases are not resolved.
    return false;
  }

  function isNodeArray(node: ts.TypeNode): boolean {
    if (ts.isArrayTypeNode(node) && hasDirectReferenceToNode(node.elementType)) {
      return true;
    }
    if (ts.isUnionTypeNode(node)) {
      return node.types.some(node => isNodeArray(node));
    }
    // FIXME Type aliases are not resolved.
    return false;
  }

  let nextTempId = 1;

  function generateTemporaryId(): string {
    return `__tempid${nextTempId++}`
  }

  function mapParametersToReferences(params: ts.ParameterDeclaration[]): ts.Identifier[] {
    return params.map(p => p.name as ts.Identifier);
  }

  function scanForSymbols() {

    ts.forEachChild(sourceFile, node => {

      if (!isSpecialDeclaration(node)) {
        writeNode(node);
        return;
      }

      const name = getNameOfDeclarationAsString(node);

      // FIXME This should actually have to be the first statement.
      if (declarationsToSkip.indexOf(name) !== -1) {
        return;
      }

      if (name === rootNodeName) {
        
        if (!ts.isInterfaceDeclaration(node) && !ts.isClassDeclaration(node)) {
          throw new Error(`The root node '${name}' must be a class declaration or an interface declaration.`);
        }

        writeNode(
          ts.createClassDeclaration(
            node.decorators,
            node.modifiers,
            `${rootNodeName}Base`,
            node.typeParameters,
            node.heritageClauses,
            [...node.members].map(convertToClassElement),
          )
        )

        rootNode = node;
        return;
      }

      if (declarations.has(name)) {
        fatal(`A symbol named '${name}' was already added. In order to keep things simple, duplicate declarations are not allowed.`)
      }

      const newInfo = {
        declaration: node,
        name,
        predecessors: [],
        successors: [],
      } as SpecialDeclaration;

      declarations.add(name, newInfo);

    });

  }

  function linkDeclarations() {
    for (const node of declarations.values()) {
      if (hasHeritageClauses(node.declaration)) {
        for (const heritageClause of node.declaration.heritageClauses!) {
          for (const type of heritageClause.types) {
            if (ts.isIdentifier(type.expression)) {
              const otherNode = declarations.get(type.expression.getText());
              if (otherNode !== undefined) {
                node.predecessors.push(otherNode);
                otherNode.successors.push(node);
              }
            }
          }
        }
      } else if (ts.isTypeAliasDeclaration(node.declaration)) {
        for (const otherNode of getAllReferencedNodesInTypeNode(node.declaration.type)) {
          node.successors.push(otherNode);
          otherNode.predecessors.push(node);
        }
      }
    } 
  }


  // Add all top-level interfaces and type aliases to the symbol table.
  scanForSymbols();

  //if (rootNode === null) {
  //  fatal(`A node named '${rootNodeName}' was not found, while it is required to serve as the root of the AST hierarchy.`)
  //}

  // Link the symbols to each other.
  linkDeclarations();

  let rootConstructor = null;
  for (const member of rootNode!.members) {
    if (member.kind === ts.SyntaxKind.Constructor) {
      rootConstructor = member as ts.ConstructorDeclaration;
    }
  }
  const rootClassParams: ts.ParameterDeclaration[] = [];
  if (rootConstructor !== null){
    for (const param of rootConstructor.parameters) {
      rootClassParams.push(
        ts.createParameter(
          undefined,
          param.modifiers?.filter(p => !isClassSpecificMemberModifier(p)),
          param.dotDotDotToken,
          ts.isIdentifier(param.name) ? param.name : generateTemporaryId(),
          param.questionToken,
          param.type,
          param.initializer
        )
      )
    }
  }
    
  for (const info of declarations.values()) {

    if (info.successors.length > 0) {

      const finalNodes = [...mapToFinalNodes([info][Symbol.iterator]())];

      if (ts.isTypeAliasDeclaration(info.declaration)) {
        writeNode(info.declaration);
      } else {
        writeNode(
          ts.createTypeAliasDeclaration(
            undefined,
            [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
            info.name,
            undefined,
            ts.createUnionTypeNode(finalNodes.map(n => ts.createTypeReferenceNode(n.name, undefined)))
          )
        )
      }

    } else {

      function buildChildrenOfStatement(type: ts.TypeNode, value: ts.Expression): ts.Statement {
        if (ts.isUnionTypeNode(type) && type.types.find(t => t.kind === ts.SyntaxKind.NullKeyword) !== undefined) {
          const remainingTypes = type.types.filter(t => t.kind !== ts.SyntaxKind.NullKeyword);
          assert(remainingTypes.length === 1);
          return ts.createIf(
            ts.createBinary(value, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.createNull()),
            buildChildrenOfStatement(
              remainingTypes[0],
              value
            )
          )
        }
        if (ts.isArrayTypeNode(type)) {
          return ts.createForOf(
            undefined,
            ts.createVariableDeclarationList([
              ts.createVariableDeclaration('element')
            ], ts.NodeFlags.Let),
            value,
            buildChildrenOfStatement(type.elementType, ts.createIdentifier('element'))
          )
        }
        if (ts.isTypeReferenceNode(type)) {
          return ts.createExpressionStatement(ts.createYield(value));
        }
        throw new Error(`Could not build a guarded yield statement for a certain TypeScript node.`)
      }

      writeNode(
        ts.createClassDeclaration(
          undefined,
          [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
          info.name,
          undefined,
          [
            ts.createHeritageClause(
              ts.SyntaxKind.ExtendsKeyword,
              [
                ts.createExpressionWithTypeArguments(
                  undefined,
                  ts.createIdentifier(`${rootNodeName}Base`)
                )
              ]
            )
          ],
          [
            ts.createProperty(
              undefined,
              undefined,
              `parentNode`,
              undefined,
              ts.createUnionTypeNode([ts.createNull(), ts.createTypeReferenceNode(`${info.name}Parent`, undefined)]),
              ts.createNull(),
            ),
            ts.createProperty(
              undefined,
              undefined,
              'kind',
              undefined,
              ts.createExpressionWithTypeArguments(
                undefined,
                ts.createPropertyAccess(ts.createIdentifier('SyntaxKind'), info.name),
              ),
              ts.createPropertyAccess(ts.createIdentifier('SyntaxKind'), info.name),
            ),
            ts.createConstructor(
              undefined,
              undefined,
              [
                ...buildFieldParameters(info, [ ts.createToken(ts.SyntaxKind.PublicKeyword) ]),
                ...rootClassParams,
              ],
              ts.createBlock([
                ts.createExpressionStatement(
                  ts.createCall(ts.createSuper(), undefined, mapParametersToReferences(rootClassParams))
                )
              ])
            ),
            ts.createMethod(
              undefined,
              undefined,
              ts.createToken(ts.SyntaxKind.AsteriskToken),
              `getChildNodes`,
              undefined,
              undefined,
              [],
              ts.createTypeReferenceNode(`IterableIterator`, [ ts.createTypeReferenceNode(`${info.name}Child`, undefined) ]),
              ts.createBlock(
                getAllRelevantMembers(info).map(member => 
                  buildChildrenOfStatement(
                    member.type!,
                     ts.createPropertyAccess(ts.createThis(), member.name as ts.Identifier)
                  )
                )
              )
            )
          ]
        )
      );

      const parentNodes = mapToFinalNodes(getAllNodesHavingNodeInField(info));

      writeNode(
        ts.createTypeAliasDeclaration(
          undefined,
          undefined,
          `${info.name}Parent`,
          undefined,
          ts.createUnionTypeNode(
            [
              ...map(parentNodes, node => ts.createTypeReferenceNode(node.name, undefined)),
             ts.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
            ]
          )
        )
      );

      const childNodes = mapToFinalNodes(getAllNodesInFieldsOfNode(info));

      writeNode(
        ts.createTypeAliasDeclaration(
          undefined,
          undefined,
          `${info.name}Child`,
          undefined,
          ts.createUnionTypeNode(
            [
              ...map(childNodes, node => ts.createTypeReferenceNode(node.name, undefined)),
             ts.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)
            ]
          )
        )
      );

    }
  
  }

  const finalDeclarations = [...filter(declarations.values(), d => d.successors.length === 0)];

  const enumMembers = []
  for (const declaration of declarations.values()) {
    if (declaration.successors.length === 0) {
      enumMembers.push(ts.createEnumMember(declaration.name))
    }
  }

  for (const declaration of finalDeclarations) {
    writeNode(
      ts.createFunctionDeclaration(
        undefined,
        [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
        undefined,
        `create${declaration.name}`,
        undefined,
        [
          ...buildFieldParameters(declaration),
          ...rootClassParams,
        ],
        ts.createTypeReferenceNode(declaration.name, undefined),
        ts.createBlock([
          ts.createReturn(
            ts.createNew(
              ts.createIdentifier(declaration.name),
              undefined,
              [
                ...getAllMembers(declaration).map(d => d.name as ts.Identifier),
                ...rootClassParams.map(p => p.name as ts.Identifier)
              ]
            )
          )
        ])
      )
    )
  }
    
  for (const info of declarations.values()) {
    const finalNodes = [...mapToFinalNodes([info][Symbol.iterator]())];
    writeNode(
      ts.createFunctionDeclaration(
        undefined,
        [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
        undefined,
        `is${info.name}`,
        undefined,
        [ ts.createParameter(undefined, undefined, undefined, 'value', undefined, ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)) ],
        ts.createTypePredicateNode('value', ts.createTypeReferenceNode(info.name, undefined)),
        ts.createBlock([
          ts.createReturn(
            buildBinaryExpression(
              ts.SyntaxKind.BarBarToken,
              finalNodes.map(node => 
                buildEquality(
                  ts.createPropertyAccess(ts.createIdentifier('value'), 'kind'),
                  ts.createPropertyAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier(node.name))
                )
              )
            )
          )
        ])
      )
    )
  }

  writeNode(
    ts.createFunctionDeclaration(
      undefined,
      [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
      undefined,
      `is${rootNodeName}`,
      undefined,
      [ ts.createParameter(undefined, undefined, undefined, 'value', undefined, ts.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)) ],
      ts.createTypePredicateNode('value', ts.createTypeReferenceNode(rootNodeName, undefined)),
      ts.createBlock(
        [
          ts.createReturn(
            buildBinaryExpression(
              ts.SyntaxKind.AmpersandAmpersandToken,
             [
              buildEquality(
                ts.createTypeOf(ts.createIdentifier('value')),
                ts.createStringLiteral('object')
              ),
              ts.createBinary(
                ts.createIdentifier('value'),
                ts.SyntaxKind.ExclamationEqualsEqualsToken,
                ts.createNull(),
              ),
              ts.createBinary(
                ts.createIdentifier('value'),
                ts.SyntaxKind.InstanceOfKeyword,
                ts.createIdentifier(`${rootNodeName}Base`)
              )
             ] 
            )
          )
        ]
      )
    )
  )

  writeNode(
    ts.createClassDeclaration(
      undefined,
      [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
      'Visitor',
      undefined,
      undefined,
      [
        ts.createMethod(
          undefined,
          undefined,
          undefined,
          `visit`,
          undefined,
          undefined,
          [ ts.createParameter(undefined, undefined, undefined, `node`, undefined, ts.createTypeReferenceNode(`Syntax`, undefined)) ],
          ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ts.createBlock([
            ts.createSwitch(
              ts.createPropertyAccess(ts.createIdentifier('node'), 'kind'),
              ts.createCaseBlock([
                ...finalDeclarations.map(fn => 
                  ts.createCaseClause(
                    ts.createPropertyAccess(ts.createIdentifier('SyntaxKind'), fn.name),
                    [
                      ts.createExpressionStatement(
                        ts.createCall(
                          ts.createPropertyAccess(ts.createThis(), `visit${fn.name}`),
                          undefined,
                          [ ts.createAsExpression(ts.createIdentifier('node'), ts.createTypeReferenceNode(fn.name, undefined)) ]
                        )
                      ),
                      ts.createBreak(),
                    ]
                  )
                )
              ])
            )
          ])
        ),
        ts.createMethod(
          undefined,
          [ ts.createToken(ts.SyntaxKind.ProtectedKeyword) ],
          undefined,
          `visit${rootNodeName}`,
          undefined,
          undefined,
          [ ts.createParameter(undefined, undefined, undefined, `node`, undefined, ts.createTypeReferenceNode(rootNodeName, undefined)) ],
          ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ts.createBlock([])
        ),
        ...map(declarations.values(), declaration => ts.createMethod(
          undefined,
          [ ts.createToken(ts.SyntaxKind.ProtectedKeyword) ],
          undefined,
          `visit${declaration.name}`,
          undefined,
          undefined,
          [ ts.createParameter(undefined, undefined, undefined, 'node', undefined, ts.createTypeReferenceNode(declaration.name, undefined)) ],
          ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
          ts.createBlock(
            declaration.predecessors.length === 0
              ? [ ts.createExpressionStatement(buildThisCall(`visit${rootNodeName}`, [ 'node' ])) ]
              : declaration.predecessors.map(predecessor => 
                ts.createExpressionStatement(buildThisCall(`visit${predecessor.name}`, [ 'node' ])))
          )
        ))
      ]
    )
  )

  writeNode(
    ts.createFunctionDeclaration(
      undefined,
      [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
      undefined,
      'kindToString',
      undefined,
      [ ts.createParameter(undefined, undefined, undefined, 'kind', undefined, ts.createTypeReferenceNode('SyntaxKind', undefined)) ],
      ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
      ts.createBlock([
        ts.createIf(
          buildEquality(ts.createElementAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier('kind')), ts.createIdentifier('undefined')),
          buildThrowError('The SyntaxKind value that was passed in was not found.')
        ),
        ts.createReturn(ts.createElementAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier('kind')))
      ])
    )
  )

  const rootUnionModfiers = [];
  if (hasModifier(rootNode!, ts.SyntaxKind.ExportKeyword)) {
    rootUnionModfiers.push(ts.createToken(ts.SyntaxKind.ExportKeyword));
  }

  writeNode(
    ts.createTypeAliasDeclaration(
      undefined,
      rootUnionModfiers,
      rootNodeName,
      undefined,
      ts.createUnionTypeNode(
        finalDeclarations.map(d => ts.createTypeReferenceNode(d.name, undefined))
      )
    )
  )

  writeNode(
    ts.createEnumDeclaration(
      undefined,
      [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
      'SyntaxKind',
      enumMembers,
    )
  )

  return out;
}

