#!/usr/bin/env node

// AST defitions generator 
//
// (c) Copyright Sam Vervaeck 2019
//
// Beware, here be dragons. Over time more and more features were added. The
// rough sketch is this: parse a definition file, separate the union types from
// the interface declarations, and generate two graphs to keep track of
// dependencies. Next generate lots of code, by making use of some functions
// defined at the end of this file. If a function is used
// regularly with the same input, in theory it should be memoised.
//
// Some remarks:
//
// - We don't want to expose private APIs that are used to communicate between
//   classes. Therefore, we do a silly any-cast and access the private properties
//   from there.

import * as path from "path"
import * as fs from "fs-extra"
import { parse } from "../typescript-simple"
import * as minimist from "minimist"
import { DepGraph } from "../util"
import { singular } from "pluralize"
import { DirectedLabeledGraph } from "yagl"

const argv = minimist(process.argv.slice(2));

const useSourceLocation = true;

const content = fs.readFileSync(argv._[0]);

let ast
try {
  ast = parse(content.toString('utf8'));
} catch (e) {
  if (e.location) {
    console.error(`${argv._[0]}:${e.location.start.line}:${e.location.start.column}: ${e.message}`);
    process.exit(1);
  } else {
    throw e;
  }
}

// interface TypeBase {
//   type: string;
//   name: string;
//   parentTypes: Type[];
//   childTypes: Type[];
// }
// 
// interface DisjunctType extends TypeBase {
//   type: 'Disjunct';
// }
// 
// interface NodeType extends TypeBase {
//   type: 'Node';
//   referenced: Property[];
// }
// 
// interface Property {
//   name: string;
//   nodeType: NodeType;
//   typeDecl: any;
// }
// 
// type Type = DisjunctType | NodeType

const preOrderMask   = 0x1;
const postOrderMask  = 0x2;

interface MapLike<T> { [key: string]: T }

interface Index {
  paths: Property[][];
  name: string;
  prop: Property;
}

interface Property {
  name: string;
  typeDecl: any;
  interface: Interface;
  indices: { index: Index, path: Property[] }[];
}

interface Union {
  name: string;
  typeDecl: any;
}

interface Interface {
  hasTransitiveSelfReference: boolean;
  id: number;
  name: string;
  referenced: Property[][];
  properties: Property[];
  indices: Index[];
  propertyMap: MapLike<any>;
}

let nextKindID = 0;
const unions = new Map<string, Union>();
const interfaces = new Map<string, Interface>();
const types = new Map<string, any>();
const inheritanceGraph = new DepGraph<string>()
const referenceGraph = new DirectedLabeledGraph<string, any>();

for (const node of ast) {
  switch (node.type) {
    case 'TypeAlias':
      unions.set(node.name, node);
      for (const el of node.typeDecl.elements) {
        inheritanceGraph.add(el.name, node.name);
        referenceGraph.addEdge(node.name, el.name, undefined);
        referenceGraph.addEdge(el.name, node.name, undefined);
      }
      break;
    case 'InterfaceDeclaration':
      interfaces.set(node.name, node);
      node.id = nextKindID++;
      node.referenced = [];
      if (node.extendsClause) {
        inheritanceGraph.add(node.name, node.extendsClause);
      }
      node.propertyMap = Object.create(null);
      for (const prop of node.properties) {
        prop.interface = node;
        node.propertyMap[prop.name] = prop;
        prop.indices = [];
      }
      break;
    default:
      throw new Error(`Unknown node type ${node.type}.`)
  }
}

// Populate the interface's indices
// This must happen after `interfaces` has been set.
for (const node of ast) {
  if (node.type === 'InterfaceDeclaration') {
    node.indices = getAllIndices(node);
  }
}

for (const intf of interfaces.values()) {
  // if (isLeafNode(intf.name)) {
    for (const prop of getAllProperties(intf)) {
      const nodeType = findNodeTypeInTypeDecl(prop.typeDecl);
      if (nodeType) {
        referenceGraph.addEdge(intf.name, nodeType, prop);
      }
    }
  // }
}

const nodeToSCC = new Map<string, Set<string>>();
for (const scc of referenceGraph.getSCCs()) {
  const sccSet = new Set(scc);
  for (const nodeName of scc) {
    nodeToSCC.set(nodeName, sccSet);
    for (const nodeType of getAllLeafNodes(nodeName)) {
      // nodeToSCC.set(nodeType, sccSet);
      interfaces.get(nodeType).hasTransitiveSelfReference = true; // TODO delete me
    }
  }
}

function areNodesConnected(a: string, b: string) {
  return nodeToSCC.get(a).has(b);
}

// This function does the bulk of the work.
// It traverses properties, and fails to add a reference if a cycle is
// detected.
function addReferences(intf: Interface) {
  let path = [];
  for (const prop of getPropertiesUsing(intf.name)) {
    let visited = new Set<Property>();
    const recurse = (prop: Property) => {
      path.unshift(prop);
      if (!inheritanceGraph.hasChildren(prop.interface.name) && !areNodesConnected(prop.interface.name, intf.name)) {
        intf.referenced.push(path.slice());
      }
      for (const prop2 of getPropertiesUsing(prop.interface.name)) {
        recurse(prop2);
      }
      path.shift();
    }
    recurse(prop);
  }
}

for (const intf of interfaces.values()) {

  // Add paths to nodes that reference this node
  addReferences(intf);

  // Add corresponding index to the relevant properties
  for (const index of intf.indices) {
    for (const path of index.paths) {
      const intf2 = path[0].interface;
      path[path.length-1].indices.push({ index, path });
    }
  }

}

const nodeTypes = [...interfaces.values()].filter(intf => isLeafNode(intf.name));

const srcDir = argv['src-dir'] || 'src';
const libDir = argv['lib-dir'] || 'lib';
const declFilePath = argv['decl-out'] || path.join(srcDir, argv['decl-filename'] || 'ast.d.ts');
const implFilePath = argv['impl-out'] || path.join(libDir, path.dirname(path.relative(srcDir, declFilePath)), argv['impl-filename'] || 'ast.js');

console.log('Processing ...')
const declContent = generateDeclarations();
const implContent = generateImplementation();

console.log(`Writing ${declFilePath} ...`)
fs.mkdirpSync(path.dirname(declFilePath));
fs.writeFileSync(declFilePath, declContent, 'utf8');

console.log(`Writing ${implFilePath} ...`)
fs.mkdirpSync(path.dirname(implFilePath));
fs.writeFileSync(implFilePath, implContent, 'utf8');

function generateImplementation() {

  let out = '';

  write(`\n`)

  write(`const SyntaxKind = {\n`)
  for (const nodeType of nodeTypes) {
    write(`  ${nodeType.name}: ${nodeType.id},\n`)
  }
  write(`};\n\n`)
  write(`exports.SyntaxKind = SyntaxKind;\n`)

  write(`
const PROPERTY_EDGE_TRAIT_TAG = 1;

const ARRAY_EDGE_TRAIT_TAG    = 2;

class PropertyEdge {

  TRAIT_TYPE = PROPERTY_EDGE_TRAIT_TAG;

  constructor(node, propertyName, value, isNullable) {
    Object.defineProperty(this, 'node', { configurable: true, enumerable: true, value: node });
    Object.defineProperty(this, 'propertyName', { configurable: true, enumerable: true, value: propertyName });
    Object.defineProperty(this, '_value', { configurable: true, writable: true, value: value }); 
    Object.defineProperty(this, 'isNullable', { configurable: true, enumerable: true, value: isNullable });
    Object.defineProperty(this, '_proxy', { configurable: true, writable: true, value: null });
    if (value !== null) {
      (value._proxied ? value._proxied : value)._parentEdge = this;
    }
  }

  getValue() {
    return this._value;
  }

  isEmpty() {
    return this._value === null;
  }

  // TODO integrate this with indices
  // remove() {
  //   this._value = null;
  //   this._node._markModified();
  // }
  // 
  // setValue(newValue) {
  //   this._value = newValue;
  //   this.node._markModified();
  // }

  _getProxy() {
    return this._proxy !== null
      ? this._proxy
      : this._proxy = new PropertyEdgeProxy(this);
  }

}

class ArrayEdge {

  TRAIT_TYPE = ARRAY_EDGE_TRAIT_TAG;

  constructor(node, propertyName, elements, isNullable) {
    Object.defineProperty(this, 'node', { configurable: true, enumerable: true, value: node });
    Object.defineProperty(this, 'propertyName', { configurable: true, enumerable: true, value: propertyName });
    Object.defineProperty(this, '_elements', { configurable: true, writable: true, value: elements });
    Object.defineProperty(this, 'isNullable', { configurable: true, enumerable: true, value: isNullable });
    Object.defineProperty(this, '_proxy', { configurable: true, writable: true, value: null });
    if (elements !== null) {
      for (const element of elements) {
        (element._proxied ? element._proxied : element)._parentEdge = this;
      }
    }
  }

  count() {
    return this._elements.length;
  }

  get [Symbol.iterator]() {
    return this._elements[Symbol.iterator];
  }

  getAt(index) {
    if (index < 0 || index >= this._elements.length) {
      throw new RangeError(\`Element index \${index} for property \${this.propertyName} out of bounds.\`);
    }
    return this._elements[index];
  }

  _getProxy() {
    return this._proxy !== null
      ? this._proxy
      : this._proxy = new ArrayEdgeProxy(this);
  }

}

function mapNullable(val, proc) {
  if (val === null)
    return null
  return proc(val);
}

class SyntaxBase {

  getEdge(propertyName) {
    const edge  = this._edgeMap[propertyName];
    if (edge === undefined) {
      throw new Error(\`Edge '\${propertyName}' not found on this node.\`);
    }
    return edge;
  }

  *getEdges() {
    for (const propertyName of Object.keys(this._edgeMap)) {
      yield this._edgeMap[propertyName];
    }
  }

  getParentOfKind(kind) {
    let curr = this;
    while (curr !== null && curr.kind !== kind) {
      curr = curr.parent;
    }
    return curr;
  }

  traverse(traverseStyle, proc) {

    const stack = [this];

    while (stack.length > 0) {
      const currNode = stack.pop();
      if (traverseStyle & ${preOrderMask}) {
        if (proc(currNode) === false) {
          continue;
        }
      }
      for (const edge of currNode.getEdges()) {
        switch (edge.TRAIT_TYPE) {
          case ARRAY_EDGE_TRAIT_TAG:
            for (let i = 0; i < edge.count(); i++) {
              stack.push(edge.getAt(i));
            }
            break;
          case PROPERTY_EDGE_TRAIT_TAG:
            stack.push(edge.getValue());
            break;
        }
      }
      if (traverseStyle & ${postOrderMask}) {
        proc(currNode);
      }
    }

  }

  transform(traverseStyle, proc) {

    const root = this._getProxy();
    const stack = [this];

    while (stack.length > 0) {
      const currNode = stack.pop();
      const currNodeProxy = currNode._getProxy();
      if (traverseStyle & ${preOrderMask}) {
        if (proc(currNodeProxy) === false) {
          continue;
        }
      }
      for (const edge of currNode.getEdges()) {
        switch (edge.TRAIT_TYPE) {
          case ARRAY_EDGE_TRAIT_TAG:
            for (let i = 0; i < edge.count(); i++) {
              const child = edge.getAt(i);
              stack.push(child);
            }
            break;
          case PROPERTY_EDGE_TRAIT_TAG:
            const child = edge.getValue();
            stack.push(child);
            break;
        }
      }
      if (traverseStyle & ${postOrderMask}) {
        proc(currNodeProxy);
      }
    }

    return root._build();

  }

}

`)


  for (const intf of nodeTypes) {

    const props = getAllProperties(intf);
    const indexProps = props.filter(p => p.indices.length > 0);

    write(`class ${intf.name} extends SyntaxBase {\n\n`);

    if (intf.indices.length > 0) {
      for (const index of intf.indices) {
          write(`  _${lcfirst(index.name)}Index = Object.create(null);\n`)
      }
      write(`\n`)
    }

    write(`  constructor(\n`)
    for (const prop of props) {
      write(`    ${prop.name},\n`)
    }
    write(`    origNode = null,\n`)
    if (useSourceLocation) {
      write(`    span = null,\n`)
    }
    write(`    parentEdge = null,\n`)
    write(`  ) {\n`)
    write(`    super();\n`)
    write(`    Object.defineProperty(this, '_proxy',  { writable: true, value: null });\n`)
    write(`    Object.defineProperty(this, '_parentEdge',  { writable: true, value: parentEdge });\n`)
    write(`    Object.defineProperty(this, 'origNode',  { writable: true, enumerable: true, value: origNode });\n`)
    write(`    Object.defineProperty(this, 'span',  { writable: true, enumerable: true, value: span });\n`)
    write(`    Object.defineProperty(this, 'kind', { enumerable: true, value: ${intf.id} });\n`)
    write(`    Object.defineProperty(this, '_edgeMap', {\n`)
    write(`      value: {\n`)
    for (const prop of props) {
      if (hasNodeReference(prop.typeDecl)) {
        const nullable = isNullable(prop.typeDecl);
        write(`        ${prop.name}: `)
        if (hasArray(prop.typeDecl)) {
          write(`new ArrayEdge(this, '${prop.name}', ${prop.name}, ${nullable})`)
        } else {
          write(`new PropertyEdge(this, '${prop.name}', ${prop.name}, ${nullable})`)
        }
        write(`,\n`)
      }
    }
    write(`      }\n`)
    write(`    });\n`)
    for (const prop of props) {
      if (!hasNodeReference(prop.typeDecl)) {
        write(`    this._${prop.name} = ${prop.name};\n`)
      }
    }
    for (const index of intf.indices) {
      write(`    for (const value of ${index.prop.name}) {\n`)
      for (const path of index.paths) {
        write(`      if (is${path[0].interface.name}(value)) {\n`)
        write(`        this._${lcfirst(index.name)}Index[value._${path[path.length-1].name}] = value;\n`)
        write(`        continue;\n`)
        write(`      }\n`)
      }
      write(`    }\n`)
    }
    write(`  }\n\n`)

    if (indexProps.length > 0) {
      write(`  _addToParentIndices() {\n`)
      for (const prop of props) {
        for (const { index, path } of prop.indices) {
          write(`    ${parentAccessor(path)}._addTo${index.name}Index(this._${prop.name}, this);\n`)
        }
      }
      write(`  }\n\n`)
    }

    if (indexProps.length > 0) {
      write(`  _removeFromParentIndices() {\n`)
      for (const prop of props) {
        for (const { index, path } of prop.indices) {
          write(`    ${parentAccessor(path)}._removeFrom${lcfirst(index.name)}Index(this._${prop.name});\n`)

        }
      }
      write(`  }\n\n`)
    }

    write(`  get parent() {\n`)
    write(`    return this._parentEdge !== null ? this._parentEdge.node : null;\n`)
    write(`  }\n\n`)

    write(`  _getProxy() {\n`)
    write(`    if (this._proxy !== null) {\n`)
    write(`      return this._proxy;\n`)
    write(`    }\n`)
    write(`    return this._proxy = new ${intf.name}Proxy(this);\n`)
    write(`  }\n\n`)

    for (const path of intf.referenced) {
      write(`  get${path[0].interface.name}() {\n`)
      write(`    return this.${new Array(path.length).fill('parent').join('.')};\n`)
      write(`  }\n\n`)
    }

    for (const index of intf.indices) {

      write(`  get${index.name}(key) {\n`)
      write(`    const value = this._${lcfirst(index.name)}Index[key];\n`)
      write(`    if (value === undefined) {\n`)
      write(`      throw new Error(\`Could not find \${key} in the requested index.\`)`)
      write(`    }\n`)
      write(`    return value;\n`)
      write(`  }\n\n`)

      write(`  _addTo${index.name}Index(key, value) {\n`)
      write(`     this._${lcfirst(index.name)}Index[key] = value;\n`)
      write(`  }\n\n`)

      write(`  _removeFrom${index.name}Index(key, value) {\n`)
      write(`     delete this._${lcfirst(index.name)}Index[key];\n`)
      write(`  }\n\n`)

    }

    write(`  toJSON() {\n`)
    write(`    return {\n`)
    write(`      kind: "${intf.name}",\n`)
    for (const prop of props) {
      const nullable = isNullable(prop.typeDecl);
      write(`      ${prop.name}: `)
      if (hasNodeReference(prop.typeDecl)) {
        if (hasArray(prop.typeDecl)) {
          if (nullable) write(`mapNullable(this._edgeMap['${prop.name}']._elements, els => els.map(el => el.toJSON()))`)
          else write(`this._edgeMap['${prop.name}']._elements.map(el => el.toJSON())`)
        } else  {
          if (nullable) write(`mapNullable(this._edgeMap['${prop.name}']._value, val => val.toJSON())`)
          else  write(`this._edgeMap['${prop.name}']._value.toJSON()`)
        }
      } else {
        if (hasArray(prop.typeDecl)) {
          if (nullable) write(`mapNullable(this._${prop.name}, els => els.slice())`)
          else write(`this._${prop.name}.slice()`)
        } else {
          write(`this._${prop.name}`)
        }
      }
      write(`,\n`)
    }
    write(`    }\n`)
    write(`  }\n\n`)

    for (const prop of props) {
      const isEdge = hasNodeReference(prop.typeDecl);
      if (hasArray(prop.typeDecl)) {
        const name = ucfirst(singular(prop.name));
        write(`  get${name}At(index) {\n`)
        if (isEdge) {
          write(`    return this.getEdge('${prop.name}').getAt(index);\n`)
        } else {
          write(`    return this._${prop.name}[index];`)
        }
        write(`  }\n\n`)
        write(`  get${ucfirst(prop.name)}() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}']._elements[Symbol.iterator]();\n`)
        } else {
          write(`    return this._${prop.name}[Symbol.iterator]();\n`)
        }
        write(`   }\n`)
        write(`  get${name}Count() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'].count();\n`)
        } else {
          write(`    return this._${prop.name}.length;`)
        }
        write(`  }\n\n`)
      } else {
        write(`  get${ucfirst(prop.name)}() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'].getValue();\n`)
        } else {
          write(`    return this._${prop.name};\n`)
        }
        write(`  }\n\n`)
      }
    }

    write(`  _build() {\n`)
    write(`    if (this._proxy !== null) {\n`)
    write(`      return this._proxy._build();\n`)
    write(`    }`)
    write(`    return this;`)
    write(`  }\n\n`)

    write(`}\n\n`);

    write(`exports.${intf.name} = ${intf.name};\n\n`)

  }

  write(`
class PropertyEdgeProxy {

  TRAIT_TYPE = PROPERTY_EDGE_TRAIT_TAG;

  constructor(edge) {
    Object.defineProperty(this, '_edge', { configurable: true, value: edge });
    Object.defineProperty(this, '_value', { configurable: true, writable: true });
    edge._proxy = this;
  }

  get node() {
    return this._edge.node._getProxy();
  }

  get propertyName() {
    return this._edge.propertyName;
  }

  getValue() {
    if (this._value !== undefined) {
      return this._value;
    }
    return this._edge._value !== null
       ? this._edge._value._getProxy()
       : null;
  }

  remove() {
    if (!this._edge.isNullable) {
      throw new Error(\`Edge \${this.propertyName} cannot be removed.\`)
    }
    if (this._value !== null) {
      this._value._removeFromParentIndices();
    }
    this._value = null;
    this.node._markModified();
  }

  setValue(newValue) {
    this._value = newValue;
    this.node._markModified();
  }

  _rawValue() {
    return this._value !== undefined ? this._value : this._edge._value;
  }

  _build() {
    if (this._value === undefined) {
      return this._edge._value !== null 
        ? this._edge._value._build()
        : null;
    }
    this._edge._proxy = null;
    return this._value === null ? null : this._value._build();
  }

}

class ArrayEdgeProxy {

  TRAIT_TYPE = ARRAY_EDGE_TRAIT_TAG;

  constructor(edge) {
    Object.defineProperty(this, '_edge', { configurable: true, value: edge });
    Object.defineProperty(this, '_elements', { configurable: true, writable: true })
    edge._proxy = this;
  }

  get node() {
    return this._edge.node._getProxy();
  }

  get propertyName() {
    return this._edge.propertyName;
  }

  getAt(index) {
    if (this._elements === undefined) {
      return this._edge.getAt(index)._getProxy();
    }
    if (index < 0 || index >= this._elements.length) {
      throw new RangeError(\`Element index \${index} for property \${this.propertyName} out of bounds.\`);
    }
    return this._elements[index];
  }

  *[Symbol.iterator]() {
    if (this._elements !== undefined) {
      for (let i = 0; i < this._elements.length; i++) {
        yield this._elements[i];
      }
    } else {
      for (const el of this._edge._elements) {
        yield el._getProxy();
      }
    }
  }

  count() {
    if (this._elements === undefined) {
      return this._edge.count();
    }
    return this._elements.length;
  }

  append(element) {
    if (this._elements === undefined) {
      this._elements = this._edge._elements.map(el => el._getProxy());
    }
    this._elements.push(element);
    element._parentEdge = this;
    element._addToParentIndices();
    this.node._markModified();
  }

  prepend(element) {
    if (this._elements === undefined) {
      this._elements = this._edge._elements.map(el => el._getProxy());
    }
    this._elements.unshift(element);
    element._parentEdge = this;
    element._addToParentIndices();
    this.node._markModified();
  }

  _rawValue() {
    return this._elements !== undefined ? this._elements : this._edge._elements;
  }

  remove(element) {
    if (this._elements === undefined) {
      for (let i = 0; i < this._edge._elements.length; i++) {
        if (this._edge._elements[i] === element || this._edge._elements[i]._proxy === element) {
            // TODO is it more efficient to reconstruct the array in-place?
            this._elements = this._edge._elements.map(el => el._getProxy());
            this._elements[i]._removeFromParentIndices();
            this._elements.splice(i, 1);
            this.node._markModified();
        }
      }
    } else {
      const matches = i => {
        if (this._elements[i] === undefined) {
          return this._edge._elements[i] === element || this._edge._elements[i]._proxy === element;
        } else {
          return         }
      }
      for (let i = 0; i < this._elements.length; i++) {
        if (this._elements[i] === element || this._elements[i]._proxied === element) {
          this._elements[i]._removeFromParentIndices();
          this._elements.splice(i, 1);
          this.node._markModified();
          return;
        }
      }
    }
  }

  _build() {
    if (this._elements === undefined) {
      return this._edge._elements.map(el => el._build());
    }
    this._edge._proxy = null;
    return this._elements.map(el => el._build());
  }

}

`)

  for (const intf of nodeTypes) {

    const props = getAllProperties(intf); 
    const indexProps = props.filter(p => p.indices.length > 0);
    const edgeProps = props.filter(prop => hasNodeReference(prop.typeDecl));

    write(`class ${intf.name}Proxy extends SyntaxBase {\n\n`);

    if (intf.indices.length > 0) {
      for (const index of intf.indices) {
          write(`  _${lcfirst(index.name)}Index;\n`)
      }
      write(`\n`)
    }

    write(`  constructor(proxied) {\n`)
    write(`    super();\n`)
    write(`    Object.defineProperty(this, 'kind', { enumerable: true, value: ${intf.id} });\n`)
    write(`    Object.defineProperty(this, '_proxied', { configurable: true, value: proxied });\n`)
    write(`    Object.defineProperty(this, '_builtNode', { configurable: true, writable: true });\n`)
    write(`    Object.defineProperty(this, '_modified', { configurable: true, writable: true, value: false });\n`)
    // if (edgeProps.length > 0) {
      write(`    Object.defineProperty(this, '_edgeMap', {\n`)
      write(`      value: {\n`)
      for (const prop of edgeProps) {
        write(`        ${prop.name}: new ${hasArray(prop.typeDecl) ? 'ArrayEdgeProxy' : 'PropertyEdgeProxy'}(proxied._edgeMap['${prop.name}']),\n`)
      }
      write(`      }\n`)
      write(`    });\n`)
    // }
    write(`  }\n\n`)

    write(`  get _parentEdge() {\n`)
    write(`    return this._proxied._parentEdge !== null ? this._proxied._parentEdge._getProxy() : null;\n`)
    write(`  }\n\n`)

      for (const index of intf.indices) {
        write(`  _clone${index.name}Index() {\n`)
        write(`    this._${lcfirst(index.name)}Index = Object.create(null);\n`)
        write(`    for (const value of this._proxied._edgeMap['${index.prop.name}']) {\n`)
        for (const path of index.paths) {
          write(`      if (is${path[0].interface.name}(value)) {\n`)
          write(`        this._${lcfirst(index.name)}Index[value._${path[path.length-1].name}] = value._proxy;\n`)
          write(`        continue;\n`)
          write(`      }\n`)
        }
        write(`    }\n`)
        write(`  }\n\n`)
      }

    for (const index of intf.indices) {

      write(`  get${index.name}(key) {\n`)
      write(`    if (this._${lcfirst(index.name)}Index === undefined) {\n`)
      write(`      return this._proxied.get${index.name}(key)._getProxy();`)
      write(`    }\n`)
      write(`    const value = this._${lcfirst(index.name)}Index[key];\n`)
      write(`    if (value === undefined) {\n`)
      write(`      throw new Error(\`Could not find \${key} in the requested index.\`)`)
      write(`    }\n`)
      write(`    return value;\n`)
      write(`  }\n\n`)

      write(`  _addTo${index.name}Index(key, value) {\n`)
      write(`    if (this._${lcfirst(index.name)}Index === undefined)\n`)
      write(`      this._clone${index.name}Index();\n` )
      write(`     this._${lcfirst(index.name)}Index[key] = value;\n`)
      write(`  }\n\n`)

      write(`  _removeFrom${index.name}Index(key, value) {\n`)
      write(`    if (this._${lcfirst(index.name)}Index === undefined)\n`)
      write(`      this._clone${index.name}Index();\n` )
      write(`     delete this._${lcfirst(index.name)}Index[key];\n`)
      write(`  }\n\n`)

    }

    write(`  _addToParentIndices() {\n`)
    for (const prop of props) {
      for (const { index, path } of prop.indices) {
        write(`    ${parentAccessor(path)}._addTo${index.name}Index(this.get${ucfirst(prop.name)}, this);\n`)
      }
    }
    write(`  }\n\n`)

    write(`  _removeFromParentIndices() {\n`)
    for (const prop of props) {
      let i = 0;
      for (const { index, path } of prop.indices) {
        write(`    const parent${i} = ${parentAccessor(path)};\n`)
        // We're sure that the parent is a proxy, so it might not have cloned the index
        // Therefore, we need to clone it in this method
        write(`    if (parent${i}._${lcfirst(index.name)}Index === undefined)\n`)
        write(`      parent${i}._clone${index.name}Index();\n` )
        write(`    delete parent${i}._${lcfirst(index.name)}Index[this.get${ucfirst(prop.name)}];\n`)
        i++;
      }
    }
    write(`  }\n\n`)

    write(`  get parent() {\n`)
    write(`    return this._parentEdge === null ? null : this._parentEdge.node;\n`)
    write(`  }\n\n`)

    for (const path of intf.referenced) {
      write(`  get${path[0].interface.name}() {\n`)
      write(`    return ${parentAccessor(path)};\n`)
      write(`  }\n\n`)
    }

    write(`  isModified() { return this._modified; }\n\n`)

    write(`   _markModified() {\n`)
    write(`    this._modified = true;\n`)
    write(`    if (this.parent !== null) {\n`)
    write(`      this.parent._markModified();\n`)
    write(`    }\n`)
    write(`  }\n\n`)

    write(`  toJSON() {\n`)
    write(`    return {\n`)
    write(`      kind: "${intf.name}",\n`)
    for (const prop of props) {
      const nullable = isNullable(prop.typeDecl);
      write(`      ${prop.name}: `)
      if (hasNodeReference(prop.typeDecl)) {
        if (hasArray(prop.typeDecl)) {
          if (nullable) write(`mapNullable(this._edgeMap['${prop.name}']._rawValue(), els => els.map(el => el.toJSON()))`)
          else write(`this._edgeMap['${prop.name}']._rawValue().map(el => el.toJSON())`)
        } else  {
          if (nullable) write(`mapNullable(this._edgeMap['${prop.name}']._rawValue(), val => val.toJSON())`)
          else write(`this._edgeMap['${prop.name}']._rawValue().toJSON()`)
        }
      } else {
        if (hasArray(prop.typeDecl)) {
          if (nullable) write(`mapNullable(this._${prop.name} !== undefined ? this._${prop.name} : this._proxied._${prop.name}, els => els.slice())`)
          else write(`(this._${prop.name} !== undefined ? this._${prop.name} : this._proxied._${prop.name}).slice()`)
        } else {
          write(`this._${prop.name} !== undefined ? this._${prop.name} : this._proxied._${prop.name}`)
        }
      }
      write(`,\n`)
    }
    write(`    }\n`)
    write(`  }\n\n`)

    // TODO only generate when one of the direct referenced is nullable or an array
    // if (parents.length > 0) {
      write(`  remove() {\n`)
      write(`    if (this._parentEdge === null) {\n`)
      write(`      throw new Error(\`Cannot delete the root node.\`);\n`)
      write(`    }\n`)
      write(`    this._parentEdge.remove(this);\n`)
      write(`  }\n\n`)
    // }

    for (const prop of props) {

      const isEdge = hasNodeReference(prop.typeDecl);

      // Write accessors

      if (hasArray(prop.typeDecl)) {
        const name = ucfirst(singular(prop.name));
        write(`  get${name}At(index) {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'].getAt(index);\n`)
        } else {
          write(`    if (this._${prop.name} !== undefined) {\n`)
          write(`      if (index < 0 || index >= this._elements.length) {\n`)
          write(`        throw new RangeError(\`Element index \${index} for property \${this.propertyName} out of bounds.\`);\n`)
          write(`      }\n`)
          write(`      return this._${prop.name}[index];\n`)
          write(`    }\n`)
          write(`    return this._proxied.get${name}At(index);\n`)
        }
        write(`  }\n\n`)
        write(`  get${ucfirst(prop.name)}() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'][Symbol.iterator]();\n`)
        } else {
          write(`    if (this._${prop.name} !== undefined)\n`)
          write(`       return this._${prop.name}[Symbol.iterator]();\n`)
          write(`    this._proxied._${prop.name}[Symbol.iterator]();\n`)
        }
        write(`   }\n`)
        write(`  get${name}Count() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'].count();\n`)
        } else {
          write(`    if (this._${prop.name} !== undefined)\n`)
          write(`      return this._${prop.name}.length;\n`)
          write(`    return this._proxied._${prop.name}.length;\n`)
        }
        write(`  }\n\n`)
      } else {
        write(`  get${ucfirst(prop.name)}() {\n`)
        if (isEdge) {
          write(`    return this._edgeMap['${prop.name}'].getValue();\n`)
        } else {
          write(`    if (this._${prop.name} !== undefined)\n`)
          write(`      return this._${prop.name};\n`)
          write(`    return this._proxied.get${ucfirst(prop.name)}();\n`)
        }
        write(`  }\n\n`)
      }

      // Write mutators

      if (hasArray(prop.typeDecl)) {
        const argName = singular(prop.name)
        const name = ucfirst(argName);
        write(`  prepend${name}(${argName}) {\n`)
        if (isEdge) {
          write(`    this._edgeMap['${prop.name}'].prepend(${argName});\n`)
          write(`    return this;\n`)
        } else {
          write(`    if (this._${prop.name} === undefined) {\n`)
          write(`      this._${prop.name} = this._proxied._${prop.name}.slice();\n`)
          write( `   }\n`)
          write(`    this._${prop.name}.unshift(${argName})\n`)
          write(`    this._markModified();\n`)
          write(`    return this;\n`)
        }
        write(`  }\n\n`)
        write(`  append${name}(${argName}) {\n`)
        if (isEdge) {
          write(`    this._edgeMap['${prop.name}'].append(${argName});\n`)
          write(`    return this;\n`)
        } else {
          write(`    if (this._${prop.name} === undefined) {\n`)
          write(`      this._${prop.name} = this._proxied._${prop.name}.slice();\n`)
          write( `   }\n`)
          write(`    this._${prop.name}.push(${argName})\n`)
          write(`    this._markModified();\n`)
          write(`    return this;\n`)
        }
        write(`  }\n\n`)
      } else {
        const name = ucfirst(prop.name);
        write(`  set${name}(${prop.name}) {\n`)
        if (isEdge) {
          write(`    this._edgeMap['${prop.name}'].setValue(${prop.name});\n`)
          write(`    return this;\n`)
        } else {
          let i = 0;
          for (const { index, path } of prop.indices) {
            write(`    const index${i} = ${parentAccessor(path)}._${lcfirst(index.name)}Index;\n`)
            write( `   delete index${i}[this._${prop.name}]\n` )
            write(`    index${i}[${prop.name}] = this;\n`)
            i++;
          }
          write(`    this._${prop.name} = ${prop.name};\n`)
          write(`    this._markModified();\n`)
          write(`    return this;\n`)
        }
        write(`  }\n\n`)
        if (isNullable(prop.typeDecl)) {
          write(`  remove${name}() {\n`)
          if (isEdge) {
            write(`    this._edgeMap['${prop.name}'].remove();\n`)
            write(`    return this;\n`);
          } else {
            write(`    delete this._${prop.name};\n`)
            write(`    this._markModified();\n`)
            write(`    return this;\n`);
          }
          write(`  }\n\n`)
        }
      }

    }

    write(`  _build() {\n`)
    write(`    if (!this._modified) {\n`)
    write(`      return this._proxied;\n`)
    write(`    }\n`)
    write(`    const newNode = new ${intf.name}(\n`)
    for (const prop of props) {
      if (hasNodeReference(prop.typeDecl)) {
        write(`      this._edgeMap['${prop.name}']._build(),\n`)
      } else {
        write(`      this._${prop.name} !== undefined ? this._${prop.name} : this._proxied._${prop.name},\n`)
      }
    }
    write(`      /* origNode */ this._proxied,\n`)
    write(`      /* span */     null,\n`)
    write(`      /* parent */   this.parent !== null ? this.parent._builtNode : null\n`)
    write(`    );\n`)
    write(`    this._builtNode = newNode;\n`)
    write(`    this._proxied._proxy = null;\n`)
    write(`    return newNode;`)
    write(`  }\n\n`)

    write(`}\n\n`)

  }

  for (const intf of nodeTypes) {
    write(`function is${intf.name}(value) {\n`)
    write(`  return value.kind === SyntaxKind.${intf.name};\n`)
    write(`}\n\n`)
    write(`exports.is${intf.name} = is${intf.name};\n\n`)
  }

  for (const union of unions.values()) {
    write(`function is${union.name}(value) {\n`)
    write(`  return ${union.typeDecl.elements.map(el => `value.kind === mage.SyntaxKind.${el.name}`).join('\n      || ')};\n`)
    write(`}\n\n`)
    write(`exports.is${union.name} = is${union.name};\n\n`)
  }

  return out;

  // for (const intf of interfaces.values()) {
  //   if (isLeafNode(intf.name)) {
  //     write(`export function create${intf.name}(\n`)
  //     const props = getAllProperties(intf)
  //     for (const prop of props) {
  //       if (hasNodeReference(prop.typeDecl)) {
  //         write(`  ${prop.name}: ${typeToString(prop.typeDecl)} | ${typeToString(makeProxy(prop.typeDecl))},\n`)
  //       } else {
  //         write(`  ${prop.name}: ${typeToString(prop.typeDecl)},\n`)
  //       }
  //     }
  //     write(`): ${intf.name}Proxy {\n`)
  //     write(`  return new ${intf.name}Proxy(new ${intf.name}(${props.map(prop => prop.name).join(', ')}), null)`)
  //     write(`}\n\n`)
  //   }
  // }

  function write(str: string) {
    out += str;
  }

  function parentAccessor(path) {
    return path.slice(0, -1).some(p => hasTransitiveSelfReference(findNodeTypeInTypeDecl(p.typeDecl)))
      ? `this.getParentOfKind(SyntaxKind.${path[0].interface.name})`
      : `this.${new Array(path.length).fill('parent').join('.')}`;
  }

}

function generateDeclarations() {

  let out = '';

  write(`
type IsNullable<T> = null extends T ? false : true

interface MapLike<T> { [key: string]: T }

export interface TextPos {
  offset: number;
  line: number;
  column: number;
}

export interface Span {
  start: TextPos;
  end: TextPos;
}

interface PropertyEdge<N extends Syntax, P extends string, R extends Syntax> {
  getValue(): R;
  isEmpty(): boolean;
  setValue(newValue: R): void;
  remove(): void;
}

interface ArrayEdge<N extends Syntax, P extends string, R extends Syntax> {
  count(): number;
  getAt(index: number): R;
  append(element: R): void;
  prepend(element: R): void;
  remove(element: R): void;
}

export const enum TraverseStyle {
  PreOrder  = ${preOrderMask},
  PostOrder = ${postOrderMask},
}

export type TraverseCallback = (node: Syntax) => false | void;

`)


  write(`export const enum SyntaxKind {\n`)
  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      write(`  ${intf.name} = ${intf.id},\n`);
    }
  }
  write(`}\n\n`);

  write(`export type Syntax\n`)
  let first = true;
  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      write(`  ${first ? '=' : '|'} ${intf.name}\n`);
      if (first) first = false;
    }
  }
  write('  ;\n')

  for (const union of unions.values()) {
    write(`export type ${union.name}\n`)
    let first = true;
    for (const typeDecl of union.typeDecl.elements) {
      write(`  ${first ? '=' : '|'} ${typeToString(typeDecl)}\n`)
      first = false;
    }
    write(`  ;\n\n`)
  }

  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      write(`type ${intf.name}Parent\n`);
      const nodes = getLeafNodesUsing(intf.name);
      if (nodes.length === 0) 
        write('  = never\n')
      else
        nodes.forEach((name, i) => {
          if (i === 0) write('  = ')
          else write('  | ')
          write(`${name}\n`)
        })
      write('  ;\n\n')
    }
  }

  write(`type EdgesOf<T> =\n`)
  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      write(`  T extends ${intf.name} ? ${intf.name}EdgeMap[keyof ${intf.name}EdgeMap] :\n`)
    }
  }
  write(`  never;\n\n`)

  write(`type SyntaxForKind<K extends SyntaxKind> =\n`)
  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      write(`  K extends SyntaxKind.${intf.name} ? ${intf.name} :\n`)
    }
  }
  write(`  never;\n\n`)

  write(`interface SyntaxBase {\n`)
  write(`}\n\n`)

  for (const intf of nodeTypes) {

    const props = getAllProperties(intf); 
    const edgeProps = props.filter(prop => hasNodeReference(prop.typeDecl));

    // if (edgeProps.length > 0) {
      write(`interface ${intf.name}EdgeMap {\n`)
      for (const prop of edgeProps) {
        write(`  ${prop.name}: `)
        write(getEdgeType(intf, prop))
        write(`;\n`)
      }
      write(`}\n\n`)
    // }

    write(`export class ${intf.name} {\n\n`);

    write(`  constructor(\n`)
    for (const prop of props) {
      write(`    ${prop.name}: ${typeToString(prop.typeDecl)},\n`)
    }
    write(`    parent?: ${intf.name}Parent | null,\n`)
    write(`    origNode?: Syntax | null`)
    if (useSourceLocation) {
      write(`,\n`)
      write(`    span?: Span | null\n`)
    } else {
      write(`\n`)
    }
    write(`  );\n\n`)

    write(`  readonly kind: SyntaxKind.${intf.name};\n`)
    write(`  readonly parent: ${intf.name}Parent | null;\n\n`)
    write(`  readonly origNode: Syntax | null;\n\n`)

    for (const path of intf.referenced) {
      const returnType = path.some(prop => isNullable(prop.typeDecl)) ? `${path[0].interface.name} | null` : path[0].interface.name;
      write(`  get${path[0].interface.name}(): ${returnType};\n`)
    }

    write(`  isModified(): boolean;\n`)
    write(`  getParentOfKind<K extends SyntaxKind>(kind: K): SyntaxForKind<K> | null;\n`)
    write(`  transform(traverseStyle: TraverseStyle, proc: TraverseCallback): Syntax;\n`)
    write(`  traverse(traverseStyle: TraverseStyle, proc: TraverseCallback): void;\n`)
    write(`  toJSON(): MapLike<any>;\n`)

    for (const index of intf.indices) {
      const returnType = index.paths.map(path => path[0].interface.name).join(' | ');
      const keyType = index.paths.map(path => typeToString(path[path.length-1].typeDecl)).join(' | ');
      write(`  get${index.name}(key: ${keyType}): ${returnType};\n\n`)
    }

    // TODO only generate this when parent member could be an array
    // if (intf.referenced.length > 0) {
      write(`  remove(): this;\n`)
    // }

    if (edgeProps.length > 0) {
      for (const prop of edgeProps) {
        write(`  getEdge(propertyName: '${prop.name}'): `)
        write(getEdgeType(intf, prop));
        write(';\n')
      }
      write(`  getEdge(propertyName: string): never;\n`)
    }

    for (const prop of props) {

      const isEdge = hasNodeReference(prop.typeDecl);

      // Write accessors

      if (hasArray(prop.typeDecl)) {
        const name = ucfirst(singular(prop.name));
        const returnType = typeToString(getArrayElementType(prop.typeDecl));
        write(`  get${name}At(index: number): ${returnType};\n\n`)
        write(`  get${ucfirst(prop.name)}(): IterableIterator<${returnType}>;\n`)
        write(`  get${name}Count(): number;\n\n`)
      } else {
        write(`  get${ucfirst(prop.name)}(): ${typeToString(prop.typeDecl)};\n`)
      }

      // Write mutators

      if (hasArray(prop.typeDecl)) {
        const argName = singular(prop.name)
        const name = ucfirst(argName);
        const elementType = getArrayElementType(prop.typeDecl);
        const acceptType = typeToString(elementType);
        write(`  prepend${name}(${argName}: ${acceptType}): this;\n`)
        write(`  append${name}(${argName}: ${acceptType}): this;\n`)
      } else {
        const name = ucfirst(prop.name);
        write(`  set${name}(${prop.name}: ${typeToString(prop.typeDecl)}): this;\n`)
        if (isNullable(prop.typeDecl)) {
          write(`  remove${name}(): this;\n`)
        }
      }

    }

    write(`}\n\n`)

  }

  for (const intf of nodeTypes) {
    write(`export function is${intf.name}(value: Syntax): value is ${intf.name};\n`)
  }

  for (const union of unions.values()) {
    write(`export function is${union.name}(value: Syntax): value is ${union.name};\n`)
  }

  write(`\n`)

  return out;

  function write(str: string) {
    out += str;
  }

}

function getEdgeType(intf, prop, suffix = '') {
  if (hasArray(prop.typeDecl)) {
    return `ArrayEdge${suffix}<${intf.name}${suffix}, '${prop.name}', ${typeToString(getArrayElementType(prop.typeDecl))}${suffix}>`;
  } else {
    return `PropertyEdge${suffix}<${intf.name}${suffix}, '${prop.name}', ${typeToString(prop.typeDecl)}${suffix}>`;
  }
}

function getAllIndices(intf) {

  const out = [];

  for (const prop of getAllProperties(intf)) {
    for (const attr of prop.attributes) {
      if (attr.type === 'IndexAttribute') {
        attr.prop = prop;
        attr.paths = attr.paths.map(expandPath);
        out.push(attr)
      }
    }
  }
  return out;

  function expandPath(path) {
    const out = [];
    let intf = interfaces.get(path[0]);
    for (let i = 1; i < path.length; i++) {
      const prop = intf.propertyMap[path[i]]
      out.push(prop);
      intf = interfaces.get(findNodeTypeInTypeDecl(prop.typeDecl));
    }
    return out;
  }

}

function getAllLeafNodes(name: string) {
  if (isLeafNode(name)) {
    return [name]
  } else {
    return inheritanceGraph.getAllChildren(name).filter(isLeafNode);
  }
}

function findNodeTypeInTypeDecl(typeDecl) {
  switch (typeDecl.type) {
    case 'TypeReference':
      if (isLeafNode(typeDecl.name) || inheritanceGraph.has(typeDecl.name)) {
        return typeDecl.name;
      } else {
        return null;
      }
    case 'ArrayType':
      return findNodeTypeInTypeDecl(typeDecl.elementType);
    case 'TupleType':
    case 'UnionType':
      for (const el of typeDecl.elements) {
        const name = findNodeTypeInTypeDecl(el);
        if (name) {
          return name;
        }
      }
      return null;
    case 'NullType':
    case 'StringType':
    case 'NumberType':
    case 'BooleanType':
      return null;
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function hasArray(typeDecl) {
  switch (typeDecl.type) {
    case 'TypeReference':
    case 'NullType':
    case 'BooleanType':
    case 'StringType':
    case 'NumberType':
      return false;
    case 'ArrayType':
      return true;
    case 'UnionType':
      return typeDecl.elements.some(hasArray);
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function getArrayElementType(typeDecl) {
  switch (typeDecl.type) {
    case 'TypeReference':
    case 'NullType':
    case 'BooleanType':
    case 'StringType':
    case 'NumberType':
      return null;
    case 'ArrayType':
      return typeDecl.elementType;
    case 'UnionType':
      for (const el of typeDecl.elements) {
        const ty = getArrayElementType(el);
        if (ty !== null) {
          return ty;
        }
      }
      return null;
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function isNullable(typeDecl) {
  switch (typeDecl.type) {
    case 'TypeReference':
    case 'BooleanType':
    case 'StringType':
    case 'NumberType':
    case 'ArrayType':
      return false;
    case 'NullType':
      return true;
    case 'UnionType':
      return typeDecl.elements.some(isNullable);
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function isLeafNode(typeName: string) {
  const intf = interfaces.get(typeName);
  return intf !== undefined && intf.isExported 
    && !inheritanceGraph.hasChildren(intf.name);
}

function hasNodeReference(typeDecl) {
  switch (typeDecl.type) {
    case 'TypeReference':
      return isLeafNode(typeDecl.name) || inheritanceGraph.has(typeDecl.name);
    case 'NullType':
    case 'BooleanType':
    case 'StringType':
    case 'NumberType':
      return false;
    case 'ArrayType':
      return hasNodeReference(typeDecl.elementType);
    case 'UnionType':
    case 'TupleType':
      return typeDecl.elements.some(hasNodeReference);
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function ucfirst(str: string) {
  return str[0].toUpperCase() + str.substring(1);
}

function lcfirst(str: string) {
  return str[0].toLowerCase() + str.substring(1);
}

function pushAll<T>(arr: T[], els: T[]) {
  for (const el of els) {
    arr.push(el);
  }
}

function getAllProperties(intf) {
  const parents =  inheritanceGraph.getAllParents(intf.name);
  parents.reverse();
  const out = Array.prototype.concat.apply([], 
    parents
      .filter(name => interfaces.has(name))
      .map(name => interfaces.get(name).properties));
  return out.concat(intf.properties);
}

function typeToString(node) {
  switch (node.type) {
    case 'TypeReference':
      return node.name
    case 'BooleanType':
      return 'boolean'
    case 'NumberType':
      return 'number';
    case 'StringType':
      return 'string';
    case 'NullType':
      return 'null';
    case 'ArrayType':
      if (node.elementType.type === 'UnionType')
        return '(' + typeToString(node.elementType) + ')[]'
      return typeToString(node.elementType) + '[]'
    case 'TupleType':
      return '[' + node.elements.map(typeToString).join(', ') + ']'
    case 'UnionType':
      return node.elements.map(typeToString).join(" | ")
    default:
      throw new Error(`Unknown node of type ${node.type}.`)
  }
}

function getPropertiesUsing(name: string) {
  const out: Property[] = [];
  for (const intf of interfaces.values()) {
    if (isLeafNode(intf.name)) {
      for (const prop of getAllProperties(intf)) {
        if (hasTypeReferenceSatisfying(prop.typeDecl, name)) {
          out.push(prop);
        }
      }
    }
  }
  return out;
}

function flatten1<T>(arr: T[][]): T[] {
  return Array.prototype.concat.apply([], arr);
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set<T>(arr)];
}

function getLeafNodesUsing(name: string) {
  return uniq(flatten1(getPropertiesUsing(name).map(prop => getAllLeafNodes(prop.interface.name))));
}

function hasTypeReferenceSatisfying(typeDecl, name: string) {
  switch (typeDecl.type) {
    case 'TypeReference':
      return name === typeDecl.name || inheritanceGraph.getAllParents(name).some(name => typeDecl.name === name);
    case 'ArrayType':
      return hasTypeReferenceSatisfying(typeDecl.elementType, name);
    case 'UnionType':
    case 'TupleType':
      return typeDecl.elements.some(el => hasTypeReferenceSatisfying(el, name));
    case 'NullType':
    case 'BooleanType':
    case 'StringType':
    case 'NumberType':
      return false;
    default:
      throw new Error(`Unknown node type ${typeDecl.type}.`)
  }
}

function resolvePropPath(intf, path) {
  for (const propName of path.slice(0, -1)) {
    const prop = intf.propertyMap[propName]; 
    if (prop === undefined) {
      throw new Error(`Property ${propName} does not exist on ${intf.name}.`)
    }
    const nodeName = findNodeTypeInTypeDecl(prop.typeDecl);
    if (!nodeName) {
      throw new Error(`No resolvable type found on ${intf.name}.${propName}.`);
    }
    const intf2 = interfaces.get(nodeName);
    if (intf2 !== undefined) {
      intf = intf2;
    } else {
      const children = inheritanceGraph.getAllChildren(nodeName)
        .filter(isLeafNode)
        .map(childName => interfaces.get(childName));
      if (children.length > 1) {
        throw new Error(`Property ${intf.name}.${propName} links to too much child nodes.`);
      }
      intf = children[0];
    }
  }
  const prop = intf.propertyMap[path[path.length-1]];
  if (prop === undefined) {
    throw new Error(`Property ${intf.name}.${path[path.length-1]} does not exist.`);
  }
  return prop;
}

function hasTransitiveSelfReference(node) {
  return unions.has(node)
    ? unions.get(node).typeDecl.elements.some(intfName => hasTransitiveSelfReference(intfName.name))
    : interfaces.get(node).hasTransitiveSelfReference;
}

