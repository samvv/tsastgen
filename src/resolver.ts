
import ts from "typescript";
import { getArrayElementType, isArrayType, isKeywordType } from "./helpers";
import { assert, FastMap, implementationLimitation } from "./util";

let nextSymbolId = 0;

export class Symbol {

  public readonly id = nextSymbolId++;

  private derivedClassesOrInterfaces?: Symbol[];
  private inheritedClassesOrInterfaces?: Symbol[];

  constructor(public name: string, public declarations: ts.Node[], private symbolTable: SymbolTable) {
    
  }

  private get globalSymbolTable() {
    // Currently, the local symbol table is also the global symbol table.
    return this.symbolTable;
  }

  public get isClassOrInterface(): boolean {
    return this.declarations.every(node =>
      ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))
  }

  public get isTypeAlias(): boolean {
    return this.declarations.length === 1
        && this.declarations.every(ts.isTypeAliasDeclaration);
  }

  public asTypeAliasDeclaration(): ts.TypeAliasDeclaration {
    return this.declarations[0] as ts.TypeAliasDeclaration;
  }

  /**
   * Get the classes and interfaces that inherit from this symbol.
   * 
   * This property is only available to symbols that map to class or interface declarations.
   */
  public getDerivedClassesOrInterfaces(): Array<Symbol> {

    // We memoise the result because this computation can be quite expensive.
    if (this.derivedClassesOrInterfaces !== undefined) {
      return this.derivedClassesOrInterfaces;
    }

    // This array will contain our list of symbols that inherit from this symbol.
    const result = [];

    // We iterate over each and every symbol we can find, because after all an
    // interface can decide to extend from another interface anywhere in the code.
    for (const otherSymbol of this.globalSymbolTable.values()) {

      // Each declaration needs to be checked individually, becuase not every
      // interface declaration is required to extend the same parent interface.
      for (const declaration of otherSymbol.declarations) {

        // Because we're iterating over every symbol, there will be a lot of
        // 'junk' that we just should skip over.
        if (!(ts.isClassDeclaration(declaration) ||
              ts.isInterfaceDeclaration(declaration))) {
          continue;
        }

        // Nothing to do if the class/interface we're visiting does not extend
        // anything.
        if (declaration.heritageClauses === undefined) {
          continue;
        }

        // Now find our symbol in the heritage clauses and add the
        // class/interface we're visiting to the result if our symbol was
        // found.
        for (const heritageClause of declaration.heritageClauses) {
          for (const exprWithTypeArgs of heritageClause.types) {
            assert(ts.isIdentifier(exprWithTypeArgs.expression));
            const inheritedSymbol = this.symbolTable.get(exprWithTypeArgs.expression.getText());
            if (inheritedSymbol !== undefined && inheritedSymbol === this) {
              result.push(otherSymbol);
            }
          }
        }

      }

    }

    // Save the result and make sure to also return it to the caller.
    return this.derivedClassesOrInterfaces = result;
  }

  /**
   * Get the classes and interfaces that this symbol inherits from.
   * 
   * This property is only available to symbols that map to class or interface
   * declarations.
   */
  public getInheritedClassesOrInterfaces(): Array<Symbol> {

    // We memoise the result because this computation can be quite expensive.
    if (this.inheritedClassesOrInterfaces !== undefined) {
      return this.inheritedClassesOrInterfaces;
    }

    // This array will contain each and every class/interface this symbol inherits from.
    const result = [];

    // We start by iterating over each declaration that may have a heritage clause.
    for (const declaration of this.declarations) {

      // This makes sure our type checker remains happy. Also, it does not make
      // sense to call this function on a symbol containing something else than classes/interfaces.
      assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));

      // Nothing to do if the current declaration does not extend anything.
      if (declaration.heritageClauses === undefined) {
        continue;
      }

      // Just iterate through all the heritage clauses and resolve any
      // identifier we find on the way to the correct symbol. The resulting
      // symbol will be returned at the end of this method.
      for (const heritageClause of declaration.heritageClauses) {
        for (const exprWithTypeArgs of heritageClause.types) {
          assert(ts.isIdentifier(exprWithTypeArgs.expression));
          const inheritedSymbol = this.symbolTable.get(exprWithTypeArgs.expression.getText());
          if (inheritedSymbol !== undefined) {
            result.push(inheritedSymbol);
          }
        }
      }

    }

    return this.inheritedClassesOrInterfaces = result;
  }

  /**
   * Get the classes and interfaces that inherit from this symbol, either
   * directly or indirectly.
   * 
   * This property is only available to symbols that map to class or interface
   * declarations.
   */
  public getAllDerivedClassesOrInterfaces(): Symbol[] {
    const visited = new Set<Symbol>();
    const result = []
    const toVisit = [...this.getDerivedClassesOrInterfaces()];
    while (toVisit.length > 0) {
      const maybeFinalSymbol = toVisit.shift()!;
      if (!visited.has(maybeFinalSymbol)) {
        visited.add(maybeFinalSymbol);
        result.push(maybeFinalSymbol);
        toVisit.push(...maybeFinalSymbol.getDerivedClassesOrInterfaces());
      }
    }
    return result;
  }

  /**
   * Get all the classes and interfaces that this symbol inherits from, either
   * directly or indirectly.
   * 
   * This property is only available to symbols that map to class or interface
   * declarations.
   * 
   * @returns A list of inherited symbols in method resolution order.
   */
  public getAllInheritedClassesOrInterfaces(): Symbol[] {
    const visited = new Set<Symbol>();
    const result = []
    const toVisit = [...this.getInheritedClassesOrInterfaces()];
    while (toVisit.length > 0) {
      const inherited = toVisit.shift()!;
      if (!visited.has(inherited)) {
        visited.add(inherited);
        result.push(inherited);
        toVisit.push(...inherited.getInheritedClassesOrInterfaces());
      }
    }
    return result;
  }

  /**
   * Get the classes or interfaces that do not inherit from another class or
   * interface and are considered to be top-level.
   * 
   * @returns A list of symbols that point to specific classes or interfaces
   */
  public getBaseClassesOrInterfaces(): Symbol[] {
    return this.getAllInheritedClassesOrInterfaces().filter(baseSymbol => baseSymbol.getInheritedClassesOrInterfaces.length === 0);
  }

  /**
   * Get all members from a class or interface declaration, no matter where they are (re)defined.
   */
  public getMembers() {
    assert(this.isClassOrInterface);
    const result = []
    for (const declaration of this.declarations) {
      assert(ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration));
      for (const member of declaration.members) {
        result.push(member);
      }
    }
    return result;
  }

  /**
   * Get the chain of classes/interfaces for which the inheritance leads to the given symbol.
   * 
   * @param target The class or interface that inherits this symbol, directly or indirectly.
   * @returns An inheritance chain including this symbol and the target symbol or nothing if the target symbol was not found.
   * @deprecated
   */
  public getInheritsFromChain(target: Symbol): Symbol[] | null {
    const visit = (symbol: Symbol, path: Symbol[]): Symbol[] | null => {
      if (symbol === target) {
        return path;
      }
      for (const inheritedSymbol of symbol.getInheritedClassesOrInterfaces()) {
        const result = visit(inheritedSymbol, [...path, inheritedSymbol ]);
        if (result !== null) {
          return result;
        }
      }
      return null;
    }
    return visit(this, [ this ]);
  }

}

type SymbolTable = FastMap<string, Symbol>;

function getPathToNode(node: ts.Node) {
  const path = [];
  let currNode: ts.Node | null = node;
  do {
    if (ts.isInterfaceDeclaration(currNode)
      || ts.isClassDeclaration(currNode)
      || ts.isTypeAliasDeclaration(currNode)) {
      assert(currNode.name !== undefined);
      path.unshift(currNode.name.getText())
    }
    currNode = currNode.parent;
  } while (currNode !== undefined);
  return path;
}

function introducesSymbol(node: ts.Node): boolean {
  return ts.isInterfaceDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isTypeAliasDeclaration(node)
      || ts.isVariableDeclaration(node);
}

function getSymbolName(node: ts.Node): string | null{
  if (ts.isClassDeclaration(node)
      || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node)) {
    assert(node.name !== undefined)
    return node.name.getText();
  }
  return null;
}

function introducesScope(node: ts.Node): boolean {
  return ts.isInterfaceDeclaration(node)
      || ts.isClassDeclaration(node)
      || ts.isClassExpression(node)
      || ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
}

export class DeclarationResolver {

  private globalSymbolTable = new FastMap<string, Symbol>();

  private scanForSymbols(node: ts.Node, symbols: SymbolTable): void {
    if (introducesSymbol(node)) {
      const path = getPathToNode(node);
      const globalName = path.join('.');
      const localName = path[path.length-1]
      let symbol;
      if (this.globalSymbolTable.has(globalName)) {
        symbol = this.globalSymbolTable.get(globalName)!;
        symbol.declarations.push(node);
      } else {
        symbol = new Symbol(localName, [ node ], symbols);
        this.globalSymbolTable.add(globalName, symbol);
      }
      symbols.add(localName, symbol);
    } else {
      ts.forEachChild(node, childNode => this.scanForSymbols(childNode, symbols));
    }
  }

  private getSymbolTable(node: ts.Node): SymbolTable {
    const sourceFile = node.getSourceFile(); 
    // HACK We are going to add our own properties and hope they will never
    //      collide with some property used by TypeScript internally.
    if ((sourceFile as any)._tsastgenSymbolTable === undefined) {
      const symbols = new FastMap<string, Symbol>();
      this.scanForSymbols(sourceFile, symbols);
      (sourceFile as any)._tsastgenSymbolTable = symbols;
      return symbols;
    }
    return (sourceFile as any)._tsastgenSymbolTable;
  }

  /**
   * Get a symbol with the given name as if it was search for beginning at the
   * given node.
   *
   * @param name The name of the symbol
   * @param fromNode The node referring to the lexical scope of the symbol
   */
  public resolve(name: string, fromNode: ts.Node): Symbol | null {
    const symbols = this.getSymbolTable(fromNode);
    return symbols.get(name) ?? null;
  }

  /**
   * Just returns all available symbols, no matter what file they are defined in.
   */
  public getAllSymbols() {
    return this.globalSymbolTable.values();
  }

  public getSymbolForNode(node: ts.Node): Symbol | null {
    const name = getSymbolName(node);
    if (name === null) {
      return null;
    }
    const symbols = this.getSymbolTable(node);
    return symbols.get(name) ?? null;
  }

  public getReferencedSymbolsInTypeNode(typeNode: ts.TypeNode): Symbol[] {
    if (ts.isTypeReferenceNode(typeNode)) {
      if (typeNode.typeName.getText() === 'Array'
          && typeNode.typeArguments !== undefined) {
        return this.getReferencedSymbolsInTypeNode(typeNode.typeArguments[0]);
      }
      const symbol = this.resolve(typeNode.typeName.getText(), typeNode);
      if (symbol === null) {
        return []
      }
      return [ symbol ]
    }
    if (ts.isUnionTypeNode(typeNode)) {
      const result = [];
      for (const elementTypeNode of typeNode.types) {
        result.push(...this.getReferencedSymbolsInTypeNode(elementTypeNode));
      }
      return result;
    }
    if (ts.isArrayTypeNode(typeNode)) {
      return this.getReferencedSymbolsInTypeNode(typeNode.elementType)
    }
    if (ts.isParenthesizedTypeNode(typeNode)) {
      return this.getReferencedSymbolsInTypeNode(typeNode);
    }
    if (ts.isLiteralTypeNode(typeNode) || isKeywordType(typeNode)) {
      return [];
    }
    throw new Error(`Could not collect referenced symbols in TypeScript type node: unhandled node type`)
  }

  public resolveTypeReferenceNode(typeNode: ts.TypeReferenceNode): Symbol | null {
    implementationLimitation(ts.isIdentifier(typeNode.typeName));
    return this.resolve(typeNode.typeName.getText(), typeNode);
  }

}
