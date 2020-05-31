
import ts from "typescript"

import { DepTree } from "./deptree"
import { MapLike, error, hasSome, map, assert } from "./util";

export interface ASTGeneratorOptions {
  isSpecificationFile?(fileName: string): boolean;
  getOutputPath?(fileName: string): string | null;
}

type NodeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.ClassDeclaration;

function values<T extends object>(obj: T): T[keyof T][] {
  const result = [];
  for (const key of Object.keys(obj)) {
    result.push(obj[key as keyof T]);
  }
  return result;
}

function isNodeExported(node: ts.Node): boolean {
  return (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0 ||
    (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
  );
}

function stripSuffix(fileName: string, suffix: string) {
  if (!fileName.endsWith(suffix)) {
    return fileName;
  }
  return fileName.substring(0, fileName.length-suffix.length);
}

export default function createTransformer(options?: ASTGeneratorOptions): ts.TransformerFactory<ts.SourceFile> {

  let isSpecificationFile: (fileName: string) => boolean;
  let getOutputPath: (fileName: string) => string | null;

  if (options?.isSpecificationFile === undefined && options?.getOutputPath === undefined) {
    isSpecificationFile = fileName => fileName.endsWith('-ast-spec.ts');
    getOutputPath = fileName => stripSuffix(fileName, '-ast-spec.ts') + '.ts';
  } else {
    isSpecificationFile = options?.isSpecificationFile ?? (fileName => false);
    getOutputPath = options?.getOutputPath ?? (fileName => null);
  }

  function isInsideSpecificationFile(node: ts.Node) {
    const fileName = node.getSourceFile().fileName;
    return isSpecificationFile(fileName);
  }

  function writeTransformedSourceFile(node: ts.SourceFile) {
    const outputPath = getOutputPath(node.fileName)
    if (outputPath === null) {
      return;
    }
    const printer = ts.createPrinter();
    let text;
    if (ts.isSourceFile(node)) {
      text = printer.printFile(node);
    } else {
      text = printer.printBundle(node);
    }
    ts.sys.writeFile(outputPath, text);
  }
  
  const transformer: ts.TransformerFactory<ts.SourceFile> = context => {

    let rootNode: ts.ClassDeclaration | null = null;
    const symbols: MapLike<NodeDeclaration[]> = Object.create(null);
    const inheritanceTree = new DepTree<string>();

    function indexNodeByName(name: string, node: NodeDeclaration): void {
        if (name in symbols) {
          symbols[name].push(node);
        } else {
          symbols[name] = [ node ]
        }
    }

    function *getAllRegisteredNodes(): IterableIterator<NodeDeclaration> {
      for (const key of Object.keys(symbols)) {
        for (const node of symbols[key]) {
          yield node;
        }
      }
    }

    function deleteNode(node: NodeDeclaration): void {
      const name = getNodeName(node);
      if (name !== null && symbols[name] !== undefined) {
        const i = symbols[name].indexOf(node);
        if (i !== -1) {
          symbols[name].splice(i, 1);
        }
      }
    }

    function leadsToRootNode(nodeName: string): boolean {

      // In order to avoid infinite loops in the case a TypeScript program was malformed, we keep track
      // of the nodes we visited and will refuse to add nodes that were already visited.
      const visited = new Set();

      // The initial list of nodes to be verified is simply the nodes that have the same name as the name
      // that was passed in.
      const stack = [ nodeName ]

      while (stack.length > 0) {
        const currNodeName = stack.pop()!;
        if (currNodeName === rootNode?.name?.getText()) {
          return true;
        }
        if (visited.has(currNodeName)) {
          continue; 
        }
        visited.add(currNodeName);
        for (const currNode of getNodesNamed(currNodeName)) {
          if (ts.isInterfaceDeclaration(currNode)) {
            if (currNode.heritageClauses !== undefined) {
              for (const heritageClause of currNode.heritageClauses) {
                for (const type of heritageClause.types) {
                  if (ts.isIdentifier(type.expression)) {
                    stack.push(type.expression.getText())
                  }
                }
              }
            }
          }
        }
      }

      // We only get here if the list of nodes to visit was empty, which means that no node led to 
      // the root node.
      return false;
    }

    function registerNode(node: NodeDeclaration): void {
      assert(node.name !== undefined);
      indexNodeByName(node.name!.getText(), node);
    }

    function *getAllReferencedNodesInHeritageClause(node: NodeDeclaration): IterableIterator<NodeDeclaration> {
      if (!ts.isInterfaceDeclaration(node)) {
        return;
      }
      if (node.heritageClauses !== undefined) {
        for (const heritageClause of node.heritageClauses) {
          for (const type of heritageClause.types) {
            if (ts.isIdentifier(type.expression)) {
              for (const parentNode of getNodesNamed(type.expression.getText())) {
                yield parentNode;
              }
            }
          }
        }
      } 
    }

    function *getAllFinalNodes(): IterableIterator<ts.InterfaceDeclaration> {
      for (const node of getAllRegisteredNodes()) {
        if (isFinalNode(node)) {
          yield node;
        }
      }
    }

    function *getAllNodesHavingNodeInField(node: NodeDeclaration): IterableIterator<NodeDeclaration> {
      outer: for (const otherNode of getAllFinalNodes()) {
        for (const referencedNode of getAllNodesInFieldsOfNode(otherNode)) {
          // for (const parentNode of getAllReferencedNodesInHeritageClause(referencedNode)) {
          //   if (parentNode === node) {
          //     yield otherNode;
          //     continue outer;
          //   }
          // }
          if (referencedNode === node) {
            yield otherNode;
            continue outer;
          }
          for (const childNode of getAllNodesInheritingFromNode(referencedNode)) {
            if (childNode === node) {
              yield otherNode
              continue outer;
            }
          }
        }
      }
    }

    function *getAllFinalNodesHavingNodeInField(node: NodeDeclaration): IterableIterator<ts.InterfaceDeclaration> {
      for (const referencedNode of getAllNodesHavingNodeInField(node)) {
        yield* getFinalNodes(referencedNode);
      }
    }

    function getNodeName(node: NodeDeclaration): string {
      assert(node.name !== undefined);
      return node.name!.getText();
    }

    function *getAllNodesInheritingFromNode(node: NodeDeclaration): IterableIterator<ts.Node> {
      for (const dependantName of inheritanceTree.getAllDependants(getNodeName(node))) {
        yield* getNodesNamed(dependantName);
      }
    }

    function *getNodesNamed(name: string): IterableIterator<NodeDeclaration> {
      if (name in symbols) {
        yield* symbols[name]; 
      }
    }

    function *getFinalNodes(node: NodeDeclaration): IterableIterator<ts.InterfaceDeclaration> {
      if (isFinalNode(node)) {
        yield node;
        return;
      }
      for (const dependantName of inheritanceTree.getAllDependants(getNodeName(node))) {
        for (const dependantNode of getNodesNamed(dependantName)) {
          if (isFinalNode(dependantNode)) {
            yield dependantNode as ts.InterfaceDeclaration;
          }
        }
      }
    }

    function *getAllReferencedNodesInTypeNode(node: ts.TypeNode): IterableIterator<NodeDeclaration> {
      if (ts.isTypeReferenceNode(node)) {
        if (ts.isIdentifier(node.typeName)) {
          for (const referencedNode of getNodesNamed(node.typeName.getText())) {
            yield referencedNode;
          }
        }
      } else if (ts.isUnionTypeNode(node)) {
        for (const elementTypeNode of node.types) {
          yield* getAllReferencedNodesInTypeNode(elementTypeNode);
        }
      }
    }

    function *getAllFieldsOfNode(node: NodeDeclaration): IterableIterator<ts.TypeElement> {
      // FIMXE Gets into an infinite loop when cycles are present
      if (ts.isInterfaceDeclaration(node)) {
        yield* node.members;
        for (const parentNode of getAllReferencedNodesInHeritageClause(node)) {
          yield* getAllFieldsOfNode(parentNode);
        }
      } else if (ts.isTypeAliasDeclaration(node)) {
        for (const childNode of getAllReferencedNodesInTypeNode(node.type)) {
          yield* getAllFieldsOfNode(childNode);
        }
      } else {
        assert(false);
      }
    }

    function *getAllNodesInFieldsOfNode(node: NodeDeclaration): IterableIterator<NodeDeclaration> {
      if (!ts.isInterfaceDeclaration(node)) {
        return;
      }
      for (const member of getAllFieldsOfNode(node)) {
        if (ts.isPropertySignature(member) && member.type !== undefined) {
          for (const node of getAllReferencedNodesInTypeNode(member.type)) {
            yield node;
          }
        }
      }
    }

    function *getAllFinalNodesInFieldsOfNode(node: NodeDeclaration): IterableIterator<ts.InterfaceDeclaration> {
      for (const referencedNode of getAllNodesInFieldsOfNode(node)) {
        yield* getFinalNodes(referencedNode);
      }
    }

    function isFinalNode(node: ts.Node): node is ts.InterfaceDeclaration {
      return ts.isInterfaceDeclaration(node)  
        && isNodeExported(node)
        && !hasSome(getAllNodesInheritingFromNode(node))
    }

    function *createPublicFieldParameters(node: ts.InterfaceDeclaration): IterableIterator<ts.ParameterDeclaration> {
      for (const member of getAllFieldsOfNode(node)) {
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
      // for (const parentNode of getAllReferencedNodesInHeritageClause(node)) {
      //   yield* createPublicFieldParameters(parentNode);
      // }
    }

    let nextTempId = 1;

    function generateTemporaryId(): string {
      return `__tempid${nextTempId++}`
    }

    function mapParametersToReferences(params: ts.ParameterDeclaration[]): ts.Identifier[] {
      return params.map(p => p.name as ts.Identifier);
    }

    return node => {

      if (!isInsideSpecificationFile(node)) {
        return node;
      }

      const prescan: ts.Visitor = node => {
        if (ts.isClassDeclaration(node)) {
          rootNode = node;
          return node; 
        }
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
          registerNode(node);
          return node;
        }
        return ts.visitEachChild(node, prescan, context);
      }

      // Add all top-level interfaces and type aliases to `nodesByName` and set the root node
      ts.visitNode(node, prescan);

      // Here we are going to clean up the TypeScript nodes that have been added to `nodesByName`.
      // Some nodes do not actually take part in the AST tree but are only supplementary, so we need to
      // check this.
      for (const node of getAllRegisteredNodes()) {

        if (ts.isInterfaceDeclaration(node)) {

          if (node.heritageClauses !== undefined) {

            let hasRootNode = false;

            // Scan the heritage clause for references to nodes that lead to the root node
            for (const heritageClause of node.heritageClauses) {

              for (const typeNode of heritageClause.types) {

                if (ts.isIdentifier(typeNode.expression)) {

                  const parentNodeName = typeNode.expression.getText();

                  if (!leadsToRootNode(parentNodeName)) {
                    continue;
                  }

                  // All good; we are now sure that this node takes part in the AST to be generated.
                  // We store the relation between the interface and its parent node for future reference.
                  inheritanceTree.addDependency(parentNodeName, node.name.getText());

                } else {

                  // We only get here if there was a complex expression such as Node<T, K> 
                  // Instead of terminating the program, it is much friendlier to just show an error message and let the transpilation continue
                  error(`An inheritance clause of interface ${node.name.getText()} is too complex to be processed. It was skipped.`)

                }

              }

            }
            
          }

        }

      }

      const rootConstructor = rootNode!.members.find(member => member.kind === ts.SyntaxKind.Constructor) as ts.ConstructorDeclaration | undefined;
      const baseClassParams: ts.ParameterDeclaration[] = [];
      if (rootConstructor !== undefined){
        for (const param of rootConstructor.parameters) {
          if (ts.isIdentifier(param.name)) {
            baseClassParams.push(param)
          } else {
            baseClassParams.push(ts.createParameter(undefined, undefined, undefined, generateTemporaryId(), undefined, param.type, param.initializer))
          }
        }
      }

      const transform: ts.Visitor = node => {

        if (node === rootNode) {
          return [
            node,
            ts.createEnumDeclaration(
              undefined,
              [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
              'SyntaxKind',
              [...map(getAllFinalNodes(), node => ts.createEnumMember(node.name.getText()))]
            )
          ]
        }

        if (isFinalNode(node)) {
          const intf = node as ts.InterfaceDeclaration;
          const nodeName = intf.name.getText()
          return [
            ts.createClassDeclaration(
              undefined,
              [ ts.createToken(ts.SyntaxKind.ExportKeyword) ],
              intf.name.getText(),
              undefined,
              [
                ts.createHeritageClause(
                  ts.SyntaxKind.ExtendsKeyword,
                  [
                    ts.createExpressionWithTypeArguments(
                      undefined,
                      ts.createIdentifier(rootNode!.name!.getText())
                    )
                  ]
                )
              ],
              [
                ts.createConstructor(
                  undefined,
                  undefined,
                  [
                    ...createPublicFieldParameters(intf),
                    ...baseClassParams,
                  ],
                  ts.createBlock([
                    ts.createExpressionStatement(
                      ts.createCall(ts.createSuper(), undefined, mapParametersToReferences(baseClassParams))
                    )
                  ])
                )
              ]
            ),
            ts.createTypeAliasDeclaration(
              undefined,
              undefined,
              `${nodeName}Parent`,
              undefined,
              ts.createUnionTypeNode(
                [
                  ...map(getAllFinalNodesHavingNodeInField(node), node => ts.createTypeReferenceNode(node.name, undefined)),
                 ts.createTypeReferenceNode('never', undefined)
                ]
              )
            ),
            ts.createTypeAliasDeclaration(
              undefined,
              undefined,
              `${nodeName}Child`,
              undefined,
              ts.createUnionTypeNode(
                [
                  ...map(getAllFinalNodesInFieldsOfNode(node), node => ts.createTypeReferenceNode(node.name, undefined)),
                 ts.createTypeReferenceNode('never', undefined)
                ]
              )
            )
          ]
        }

        return ts.visitEachChild(node, transform, context);
      }

      const transformed = ts.visitNode(node, transform);
      writeTransformedSourceFile(transformed);
      return node;
    }

  }

  return transformer;

}

