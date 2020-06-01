
import ts from "typescript"

import { map, assert, FastMap, fatal, depthFirstSearch, hasSome, filter } from "./util";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
}

function hasModifier(node: ts.Node, kind: ts.Modifier['kind']): boolean {
  if (node.modifiers === undefined) {
    return false;
  }
  return [...node.modifiers].find(m => m.kind === kind) !== undefined;
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
      || ts.isTypeAliasDeclaration(node);
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
  let rootNode: ClassDeclaration | InterfaceDeclaration | null = null;

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
      const declaration = stack.pop()!;
      if (visited.has(declaration)) {
        continue;
      }
      visited.add(declaration);
      if (ts.isTypeAliasDeclaration(declaration.declaration)) {
        for (const successor of declaration.successors) {
          stack.push(successor as SpecialDeclaration);
        }
      } else {
        for (const referencedNode of getAllNodesInFieldsOfNode(declaration)) {
          for (const predecessor of getAllSuccessorsIncludingSelf(referencedNode)) {
            if (predecessor === node) {
              yield declaration;
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

  function *createPublicFieldParameters(node: SpecialDeclaration): IterableIterator<ts.ParameterDeclaration> {
    for (const member of getAllMembers(node)) {
      if (ts.isPropertySignature(member)) {
        yield ts.createParameter(
          undefined,
          [ ts.createToken(ts.SyntaxKind.PublicKeyword) ],
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

      if (isSpecialDeclaration(node)) {

        const name = getNameOfDeclarationAsString(node);

        if (declarationsToSkip.indexOf(name) !== -1) {
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

        if (name === rootNodeName) {
          rootNode = newInfo as ClassDeclaration | InterfaceDeclaration;
        }

      }

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

  function transform(node: ts.Node) {

    
    if (!isSpecialDeclaration(node)) {
      writeNode(node);
      return;
    }

    const name = getNameOfDeclarationAsString(node);

    if (declarationsToSkip.indexOf(name) !== -1) {
      return;
    }

    const info = declarations.get(name)!;

    if (info === undefined) {
      writeNode(node)
      return;
    }
    
    if (info === rootNode) {
      writeNode(
        ts.createClassDeclaration(
          info.declaration.decorators,
          info.declaration.modifiers,
          `${rootNodeName}Base`,
          info.declaration.typeParameters,
          info.declaration.heritageClauses,
          [...info.declaration.members].map(convertToClassElement),
        )
      )
      return;
    }
    
    if (ts.isTypeAliasDeclaration(node) || info.successors.length > 0) {

      const finalNodes = [...mapToFinalNodes([info][Symbol.iterator]())];

      if (ts.isTypeAliasDeclaration(node)) {
        writeNode(node);
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
                  ts.createBinary(
                    ts.createPropertyAccess(ts.createIdentifier('value'), 'kind'),
                    ts.SyntaxKind.EqualsEqualsEqualsToken,
                    ts.createPropertyAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier(node.name))
                  )
                )
              )
            )
          ])
        )
      )

    } else {

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
                  ts.createIdentifier(`${rootNode!.name}Base`)
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
                ...createPublicFieldParameters(info),
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
                getAllRelevantMembers(info).map(member => {
                  if (isNodeArray(member.type!)) {
                    return ts.createForOf(
                      undefined,
                      ts.createVariableDeclarationList([
                        ts.createVariableDeclaration('element')
                      ]),
                      ts.createPropertyAccess(ts.createThis(), member.name as ts.Identifier),
                      ts.createBlock([
                        isNullable(getArrayElementType(member.type!)!)
                          ? ts.createIf(
                              ts.createBinary(ts.createIdentifier('element'), ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.createNull()),
                              ts.createExpressionStatement(ts.createYield(ts.createIdentifier('element'))),
                            )
                          : ts.createExpressionStatement(ts.createYield(ts.createIdentifier('element')))
                      ])
                    )
                  }
                  const prop = ts.createPropertyAccess(ts.createThis(), member.name as ts.Identifier);
                  if (isNullable(member.type!)) {
                    return ts.createIf(
                      ts.createBinary(prop, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.createNull()),
                      ts.createExpressionStatement(ts.createYield(prop)),
                    )
                  }
                  return ts.createExpressionStatement(ts.createYield(prop))
                })
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

  // Add all top-level interfaces and type aliases to the symbol table.
  scanForSymbols();

  if (rootNode === null) {
    fatal(`A node named '${rootNodeName}' was not found, while it is required to serve as the root of the AST hierarchy.`)
  }

  // Link the symbols to each other.
  linkDeclarations();

  let rootConstructor = null;
  for (const member of rootNode!.declaration.members) {
    if (member.kind === ts.SyntaxKind.Constructor) {
      rootConstructor = member as ts.ConstructorDeclaration;
    }
  }

  const rootClassParams: ts.ParameterDeclaration[] = [];
  if (rootConstructor !== null){
    for (const param of rootConstructor.parameters) {
      if (ts.isIdentifier(param.name)) {
        rootClassParams.push(param)
      } else {
        rootClassParams.push(ts.createParameter(undefined, undefined, undefined, generateTemporaryId(), undefined, param.type, param.initializer))
      }
    }
  }

  ts.forEachChild(sourceFile, transform);

  const finalDeclarations = [...filter(declarations.values(), d => d.successors.length === 0)];

  const enumMembers = []
  for (const declaration of declarations.values()) {
    if (declaration.successors.length === 0) {
      enumMembers.push(ts.createEnumMember(declaration.name))
    }
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
              ts.createBinary(
                ts.createTypeOf(ts.createIdentifier('value')),
                ts.SyntaxKind.EqualsEqualsEqualsToken,
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
      [...map(declarations.values(), declaration => ts.createMethod(
        undefined,
        [ ts.createToken(ts.SyntaxKind.ProtectedKeyword) ],
        undefined,
        `visit${declaration.name}`,
        undefined,
        undefined,
        [ ts.createParameter(undefined, undefined, undefined, 'node', undefined, ts.createTypeReferenceNode(declaration.name, undefined)) ],
        ts.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword),
        ts.createBlock(
          declaration.predecessors.map(predecessor => 
          ts.createExpressionStatement(ts.createCall(ts.createPropertyAccess(ts.createThis(), `visit${predecessor.name}`), undefined, [ ts.createIdentifier('node')])))
        )
      ))]
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
          ts.createBinary(ts.createElementAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier('kind')), ts.SyntaxKind.EqualsEqualsEqualsToken, ts.createIdentifier('undefined')),
          buildThrowError('The SyntaxKind value that was passed in was not found.')
        ),
        ts.createReturn(ts.createElementAccess(ts.createIdentifier('SyntaxKind'), ts.createIdentifier('kind')))
      ])
    )
  )

  const rootUnionModfiers = [];
  if (hasModifier(rootNode!.declaration, ts.SyntaxKind.ExportKeyword)) {
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

