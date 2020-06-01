
import ts from "typescript"

import { error, hasSome, map, assert, MultiMap, FastMap, fatal, depthFirstSearch } from "./util";
import { BiDGraph } from "./graph";
import { BitMaskIndex } from "./bitMaskIndex";

export interface CodeGeneratorOptions {
  rootNodeName?: string;
}

function hasFlag(mask: number, flag: number): boolean {
  return (mask & flag) > 0;
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

enum NodeFlags {
  IsTrait = 0x1,
  IsRoot  = 0x2,
  IsFinal = 0x4,
  IsAST   = 0x8,
}

interface DeclarationInfo<T extends ts.Node = ts.Node> {
  name: string;
  declaration: T;
  flags: NodeFlags;
  predecessors: DeclarationInfo[];
  successors: DeclarationInfo[];
}

type ClassDeclaration = DeclarationInfo<ts.ClassDeclaration>;
type InterfaceDeclaration = DeclarationInfo<ts.InterfaceDeclaration>
type TypeAliasDeclaration = DeclarationInfo<ts.TypeAliasDeclaration>
type SpecialDeclaration = ClassDeclaration | InterfaceDeclaration | TypeAliasDeclaration;

export default function generateCode(sourceFile: ts.SourceFile, options?: CodeGeneratorOptions): string {

  let out = '';
  const rootNodeName = options?.rootNodeName ?? 'Syntax';
  const declarations = new FastMap<string, SpecialDeclaration>();
  const symbolFlagIndex = new BitMaskIndex<SpecialDeclaration>();
  let rootNode: ClassDeclaration | InterfaceDeclaration | null = null;

  const printer = ts.createPrinter();

  function writeNode(node: ts.Node): void {
    out += printer.printNode(ts.EmitHint.Unspecified, node, sourceFile) + '\n\n'
  }

   function leadsToRootNode(node: SpecialDeclaration): boolean {

     // In order to avoid infinite loops in the case a TypeScript program was malformed, we keep track
     // of the nodes we visited and will refuse to add nodes that were already visited.
     const visited = new Set();

     // The initial list of nodes to be verified is simply the nodes that have the same name as the name
     // that was passed in.
     const stack: DeclarationInfo[] = [ node ]

     while (stack.length > 0) {
       const currNode = stack.pop()!;
       if (currNode === rootNode) {
         return true;
       }
       if (visited.has(currNode)) {
         continue; 
       }
       visited.add(currNode);
       for (const predecessor of node.predecessors) {
         stack.push(predecessor)
       }
     }

     // We only get here if the list of nodes to visit was empty, which means that no node led to 
     // the root node.
     return false;
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
          if (ts.isPropertySignature(member)) {
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
    for (const member of getAllRelevantMembers(node)) {
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

        if (declarations.has(name)) {
          fatal(`A symbol named '${name}' was already added. In order to keep things simple, duplicate declarations are not allowed.`)
        }

        const newInfo = {
          declaration: node,
          flags: 0,
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

    const info = declarations.get(getNameOfDeclarationAsString(node))!;

    if (info === undefined) {
      writeNode(node);
      return;
    }

    if (ts.isTypeAliasDeclaration(node) || info.successors.length > 0) {

      writeNode(
        ts.createFunctionDeclaration(
          undefined,
          [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
          undefined,
          `is${info.name}`,
          undefined,
          [ ts.createParameter(undefined, undefined, undefined, 'value') ],
          ts.createTypePredicateNode('value', ts.createTypeReferenceNode(info.name, undefined)),
          ts.createBlock([
            ts.createReturn(
              ts.createBinary(ts.createIdentifier('value'), ts.SyntaxKind.InstanceOfKeyword, ts.createIdentifier(info.name)))
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
                  ts.createIdentifier(rootNode!.name)
                )
              ]
            )
          ],
          [
            ts.createConstructor(
              undefined,
              undefined,
              [
                ...createPublicFieldParameters(info),
                ...baseClassParams,
              ],
              ts.createBlock([
                ts.createExpressionStatement(
                  ts.createCall(ts.createSuper(), undefined, mapParametersToReferences(baseClassParams))
                )
              ])
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

  const baseClassParams: ts.ParameterDeclaration[] = [];
  if (rootConstructor !== null){
    for (const param of rootConstructor.parameters) {
      if (ts.isIdentifier(param.name)) {
        baseClassParams.push(param)
      } else {
        baseClassParams.push(ts.createParameter(undefined, undefined, undefined, generateTemporaryId(), undefined, param.type, param.initializer))
      }
    }
  }

  ts.forEachChild(sourceFile, transform);

  const enumMembers = []
  for (const declaration of declarations.values()) {
    if (declaration.successors.length === 0) {
      enumMembers.push(ts.createEnumMember(declaration.name))
    }
  }

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

