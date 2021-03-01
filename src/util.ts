
export class MultiMap<K, V> {

  _map = new Map<K, V[]>(); 

  get(k: K): V[] {
    const vs = this._map.get(k);
    return vs === undefined
      ? []
      : vs.slice();
  }

  keys() {
    return this._map.keys();
  }

  add(k: K, v: V) {
    const vs = this._map.get(k);
    if (vs !== undefined) {
      const idx = vs.indexOf(v);
      if (idx === -1) {
        vs.push(v);
      }
    } else {
      this._map.set(k, [v]);
    }
  }

  has(k: K): boolean {
    return this._map.has(k);
  }

}

export class DepGraph<T> {

  _parentToChildren = new MultiMap<T, T>();
  _childToParent = new MultiMap<T, T>();

  add(child: T, parent: T): void {
    this._parentToChildren.add(parent, child);
    this._childToParent.add(child, parent);
  }

  has(el: T): boolean {
    return this._parentToChildren.has(el) || this._childToParent.has(el);
  }

  hasChildren(parent: T): boolean {
    return this._parentToChildren.has(parent);
  }

  getChildren(parent: T): T[] {
    return this._parentToChildren.get(parent);
  }

  getAllChildren(parent: T): T[] {
    const out = new Set<T>();
    const frontier: T[] = [parent];
    while (frontier.length > 0) {
      const parent = frontier.pop();
      for (const child of this.getChildren(parent)) {
        if (!out.has(child)) {
          out.add(child);
          frontier.push(child);
        }
      }
    }
    return [...out];
  }

  hasParents(child: T) {
    return this._childToParent.has(child);
  }

  getParents(child: T): T[] {
    return this._childToParent.get(child);
  }

  getAllParents(child: T) {
    const out = new Set<T>();
    const frontier: T[] = [child];
    while (frontier.length > 0) {
      const child = frontier.pop();
      for (const parent of this.getParents(child)) {
        if (!out.has(parent)) {
          out.add(parent);
          frontier.push(parent);
        }
      }
    }
    return [...out];
  }

}

