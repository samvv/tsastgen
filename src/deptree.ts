
import { MapLike } from "./util"

export class DepTree<V extends string> {

  private parentToChildren: MapLike< V[]> = Object.create(null);
  private childToParents: MapLike<V[]> = Object.create(null);

  public addDependency(a: V, b: V) {
    if (a in this.parentToChildren) {
      this.parentToChildren[a].push(b);
    } else {
      this.parentToChildren[a] = [ b ];
    }
    if (b in this.childToParents) {
      this.childToParents[b].push(a);
    } else {
      this.childToParents[b] = [ a ];
    }
  }

  public *getAllDependencies(node: V): IterableIterator<V> {
    const visited = new Set();
    const stack = [ node ]
    while (stack.length > 0) {
      const currNode = stack.pop()!;
      if (visited.has(currNode)) {
        continue;
      }
      visited.add(currNode);
      if (currNode in this.childToParents) {
        for (const dependingNode of this.childToParents[currNode]) {
          yield dependingNode;
          stack.push(dependingNode);
        }
      }
    }
  } 

  public *getAllDependants(node: V): IterableIterator<V> {
    const visited = new Set();
    const stack = [ node ]
    while (stack.length > 0) {
      const currNode = stack.pop()!;
      if (visited.has(currNode)) {
        continue;
      }
      visited.add(currNode);
      if (currNode in this.parentToChildren) {
        for (const dependingNode of this.parentToChildren[currNode]) {
          yield dependingNode;
          stack.push(dependingNode);
        }
      }
    }
  }

}

