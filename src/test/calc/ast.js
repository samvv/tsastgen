
const SyntaxKind = {
  BinaryAddition: 1,
  BinaryMultiplication: 2,
  NumberLiteral: 3,
};

exports.SyntaxKind = SyntaxKind;



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

  remove() {
    this._value = null;
    this._node._markModified();
  }

  setValue(newValue) {
    this._value = newValue;
    this.node._markModified();
  }

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

  getAt(index) {
    if (index < 0 || index >= this._elements.length) {
      throw new RangeError(`Element index ${index} for property ${this.propertyName} out of bounds.`);
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
      throw new Error(`Edge '${propertyName}' not found on this node.`);
    }
    return edge;
  }

  *getEdges() {
    for (const propertyName of Object.keys(this._edgeMap)) {
      yield this._edgeMap[propertyName];
    }
  }

  parentOfKind(kind) {
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
      if (traverseStyle & 1) {
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
      if (traverseStyle & 2) {
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
      if (traverseStyle & 1) {
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
      if (traverseStyle & 2) {
        proc(currNodeProxy);
      }
    }

    return root._build();

  }

}

class BinaryAddition extends SyntaxBase {

  constructor(
    left,
    right,
    origNode = null,
    span = null,
    parentEdge = null,
  ) {
    super();
    Object.defineProperty(this, '_proxy',  { writable: true, value: null });
    Object.defineProperty(this, '_parentEdge',  { writable: true, value: parentEdge });
    Object.defineProperty(this, 'origNode',  { writable: true, enumerable: true, value: origNode });
    Object.defineProperty(this, 'span',  { writable: true, enumerable: true, value: span });
    Object.defineProperty(this, 'kind', { enumerable: true, value: 1 });
    Object.defineProperty(this, '_edgeMap', {
      value: {
        left: new PropertyEdge(this, 'left', left, false),
        right: new PropertyEdge(this, 'right', right, false),
      }
    });
  }

  get parent() {
    return this._parentEdge !== null ? this._parentEdge.node : null;  }

  _getProxy() {
    if (this._proxy !== null) {
      return this._proxy;
    }
    return this._proxy = new BinaryAdditionProxy(this);
  }

  toJSON() {
    return {
      kind: "BinaryAddition",
      left: this._edgeMap['left']._value.toJSON(),
      right: this._edgeMap['right']._value.toJSON(),
    }
  }

  getLeft() {
    return this._edgeMap['left'].getValue();
  }

  getRight() {
    return this._edgeMap['right'].getValue();
  }

  _build() {
    if (this._proxy !== null) {
      return this._proxy._build();
    }    return this;  }

}

exports.BinaryAddition = BinaryAddition;

class BinaryMultiplication extends SyntaxBase {

  constructor(
    left,
    right,
    origNode = null,
    span = null,
    parentEdge = null,
  ) {
    super();
    Object.defineProperty(this, '_proxy',  { writable: true, value: null });
    Object.defineProperty(this, '_parentEdge',  { writable: true, value: parentEdge });
    Object.defineProperty(this, 'origNode',  { writable: true, enumerable: true, value: origNode });
    Object.defineProperty(this, 'span',  { writable: true, enumerable: true, value: span });
    Object.defineProperty(this, 'kind', { enumerable: true, value: 2 });
    Object.defineProperty(this, '_edgeMap', {
      value: {
        left: new PropertyEdge(this, 'left', left, false),
        right: new PropertyEdge(this, 'right', right, false),
      }
    });
  }

  get parent() {
    return this._parentEdge !== null ? this._parentEdge.node : null;  }

  _getProxy() {
    if (this._proxy !== null) {
      return this._proxy;
    }
    return this._proxy = new BinaryMultiplicationProxy(this);
  }

  toJSON() {
    return {
      kind: "BinaryMultiplication",
      left: this._edgeMap['left']._value.toJSON(),
      right: this._edgeMap['right']._value.toJSON(),
    }
  }

  getLeft() {
    return this._edgeMap['left'].getValue();
  }

  getRight() {
    return this._edgeMap['right'].getValue();
  }

  _build() {
    if (this._proxy !== null) {
      return this._proxy._build();
    }    return this;  }

}

exports.BinaryMultiplication = BinaryMultiplication;

class NumberLiteral extends SyntaxBase {

  constructor(
    value,
    origNode = null,
    span = null,
    parentEdge = null,
  ) {
    super();
    Object.defineProperty(this, '_proxy',  { writable: true, value: null });
    Object.defineProperty(this, '_parentEdge',  { writable: true, value: parentEdge });
    Object.defineProperty(this, 'origNode',  { writable: true, enumerable: true, value: origNode });
    Object.defineProperty(this, 'span',  { writable: true, enumerable: true, value: span });
    Object.defineProperty(this, 'kind', { enumerable: true, value: 3 });
    Object.defineProperty(this, '_edgeMap', {
      value: {
      }
    });
    this._value = value;
  }

  get parent() {
    return this._parentEdge !== null ? this._parentEdge.node : null;  }

  _getProxy() {
    if (this._proxy !== null) {
      return this._proxy;
    }
    return this._proxy = new NumberLiteralProxy(this);
  }

  toJSON() {
    return {
      kind: "NumberLiteral",
      value: this._value,
    }
  }

  getValue() {
    return this._value;
  }

  _build() {
    if (this._proxy !== null) {
      return this._proxy._build();
    }    return this;  }

}

exports.NumberLiteral = NumberLiteral;


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
      throw new Error(`Edge ${this.propertyName} cannot be removed.`)
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
      throw new RangeError(`Element index ${index} for property ${this.propertyName} out of bounds.`);
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
    this.node._markModified();
  }

  prepend(element) {
    if (this._elements === undefined) {
      this._elements = this._edge._elements.map(el => el._getProxy());
    }
    this._elements.unshift(element);
    this.node._markModified();
  }

  _rawValue() {
    return this._elements !== undefined ? this._elements : this._edge._elements;
  }

  remove(element) {
    if (this._elements === undefined) {
      for (let i = 0; i < this._edge._elements.length; i++) {
        if (this._edge._elements[i] === element || this._edge._elements[i]._proxied === element) {
            this._elements = this._edge._elements.map(el => el._getProxy());
            this._elements.splice(i, 1);
            this.node._markModified();
        }
      }
    } else {
      const matches = i => {
        if (this._elements[i] === undefined) {
          return this._edge._elements[i] === element || this._edge._elements[i]._proxy === element;
        } else {
          return this._elements[i] === element || this._elements[i]._proxied === element
        }
      }
      for (let i = 0; i < this._elements.length; i++) {
        if (matches(i)) {
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

  class BinaryAdditionProxy extends SyntaxBase {

  constructor(proxied) {
    super();
    Object.defineProperty(this, 'kind', { enumerable: true, value: 1 });
    Object.defineProperty(this, '_proxied', { configurable: true, value: proxied });
    Object.defineProperty(this, '_builtNode', { configurable: true, writable: true });
    Object.defineProperty(this, '_modified', { configurable: true, writable: true, value: false });
    Object.defineProperty(this, '_edgeMap', {
      value: {
        left: new PropertyEdgeProxy(proxied._edgeMap['left']),
        right: new PropertyEdgeProxy(proxied._edgeMap['right']),
      }
    });
  }

  get _parentEdge() {
    return this._proxied._parentEdge !== null ? this._proxied._parentEdge._getProxy() : null;
  }
  get parent() {
    return this._parentEdge === null ? null : this._parentEdge.node;
  }

  isModified() { return this._modified; }

   _markModified() {
    this._modified = true;
    if (this.parent !== null) {
      this.parent._markModified();
    }
  }

  toJSON() {
    return {
      kind: "BinaryAddition",
      left: this._edgeMap['left']._rawValue().toJSON(),
      right: this._edgeMap['right']._rawValue().toJSON(),
    }
  }

  remove() {
    if (this.parent === null) {
      throw new Error(`Cannot delete the root node.`);
    }
    this._parentEdge.remove(this);
  }

  getLeft() {
    return this._edgeMap['left'].getValue();
  }

  setLeft(left) {
    this._edgeMap['left'].setValue(left);
    return this;
  }

  getRight() {
    return this._edgeMap['right'].getValue();
  }

  setRight(right) {
    this._edgeMap['right'].setValue(right);
    return this;
  }

  _build() {
    if (!this._modified) {
      return this._proxied;
    }
    const newNode = new BinaryAddition(
      this._edgeMap['left']._build(),
      this._edgeMap['right']._build(),
      /* origNode */ this._proxied,
      /* span */     null,
      /* parent */   this.parent !== null ? this.parent._builtNode : null
    );
    this._builtNode = newNode;
    this._proxied._proxy = null;
    return newNode;  }

}

class BinaryMultiplicationProxy extends SyntaxBase {

  constructor(proxied) {
    super();
    Object.defineProperty(this, 'kind', { enumerable: true, value: 2 });
    Object.defineProperty(this, '_proxied', { configurable: true, value: proxied });
    Object.defineProperty(this, '_builtNode', { configurable: true, writable: true });
    Object.defineProperty(this, '_modified', { configurable: true, writable: true, value: false });
    Object.defineProperty(this, '_edgeMap', {
      value: {
        left: new PropertyEdgeProxy(proxied._edgeMap['left']),
        right: new PropertyEdgeProxy(proxied._edgeMap['right']),
      }
    });
  }

  get _parentEdge() {
    return this._proxied._parentEdge !== null ? this._proxied._parentEdge._getProxy() : null;
  }
  get parent() {
    return this._parentEdge === null ? null : this._parentEdge.node;
  }

  isModified() { return this._modified; }

   _markModified() {
    this._modified = true;
    if (this.parent !== null) {
      this.parent._markModified();
    }
  }

  toJSON() {
    return {
      kind: "BinaryMultiplication",
      left: this._edgeMap['left']._rawValue().toJSON(),
      right: this._edgeMap['right']._rawValue().toJSON(),
    }
  }

  remove() {
    if (this.parent === null) {
      throw new Error(`Cannot delete the root node.`);
    }
    this._parentEdge.remove(this);
  }

  getLeft() {
    return this._edgeMap['left'].getValue();
  }

  setLeft(left) {
    this._edgeMap['left'].setValue(left);
    return this;
  }

  getRight() {
    return this._edgeMap['right'].getValue();
  }

  setRight(right) {
    this._edgeMap['right'].setValue(right);
    return this;
  }

  _build() {
    if (!this._modified) {
      return this._proxied;
    }
    const newNode = new BinaryMultiplication(
      this._edgeMap['left']._build(),
      this._edgeMap['right']._build(),
      /* origNode */ this._proxied,
      /* span */     null,
      /* parent */   this.parent !== null ? this.parent._builtNode : null
    );
    this._builtNode = newNode;
    this._proxied._proxy = null;
    return newNode;  }

}

class NumberLiteralProxy extends SyntaxBase {

  constructor(proxied) {
    super();
    Object.defineProperty(this, 'kind', { enumerable: true, value: 3 });
    Object.defineProperty(this, '_proxied', { configurable: true, value: proxied });
    Object.defineProperty(this, '_builtNode', { configurable: true, writable: true });
    Object.defineProperty(this, '_modified', { configurable: true, writable: true, value: false });
    Object.defineProperty(this, '_edgeMap', {
      value: {
      }
    });
  }

  get _parentEdge() {
    return this._proxied._parentEdge !== null ? this._proxied._parentEdge._getProxy() : null;
  }
  get parent() {
    return this._parentEdge === null ? null : this._parentEdge.node;
  }

  isModified() { return this._modified; }

   _markModified() {
    this._modified = true;
    if (this.parent !== null) {
      this.parent._markModified();
    }
  }

  toJSON() {
    return {
      kind: "NumberLiteral",
      value: this._value !== undefined ? this._value : this._proxied._value,
    }
  }

  remove() {
    if (this.parent === null) {
      throw new Error(`Cannot delete the root node.`);
    }
    this._parentEdge.remove(this);
  }

  getValue() {
    if (this._value !== undefined)
      return this._value;
    return this._proxied.getValue();
  }

  setValue(value) {
    this._value = value;
    this._markModified();
    return this;
  }

  _build() {
    if (!this._modified) {
      return this._proxied;
    }
    const newNode = new NumberLiteral(
      this._value !== undefined ? this._value : this._proxied._value,
      /* origNode */ this._proxied,
      /* span */     null,
      /* parent */   this.parent !== null ? this.parent._builtNode : null
    );
    this._builtNode = newNode;
    this._proxied._proxy = null;
    return newNode;  }

}

exports.isBinaryAddition = function isBinaryAddition(value) {
  return value.kind === SyntaxKind.BinaryAddition;
}

exports.isBinaryMultiplication = function isBinaryMultiplication(value) {
  return value.kind === SyntaxKind.BinaryMultiplication;
}

exports.isNumberLiteral = function isNumberLiteral(value) {
  return value.kind === SyntaxKind.NumberLiteral;
}

exports.isExpression = function isExpression(value) {
  return value.kind === mage.SyntaxKind.BinaryAddition
      || value.kind === mage.SyntaxKind.BinaryMultiplication
      || value.kind === mage.SyntaxKind.NumberLiteral;
}

