
export function error(message: string) {
  console.error(`Error: ${message}`)
}

export function info(message: string) {
  console.error(`Info: ${message}`)
}

export function fatal(message: string) {
  console.error(`Fatal: ${message}`)
  process.exit(1);
}

export function *depthFirstSearch<T>(value: T, expand: (value: T) => Iterable<T>, includeSelf = true): IterableIterator<T> {
  const visited = new Set<T>();
  const stack: T[] = [ value ];
  while (stack.length > 0) {
    const currValue = stack.pop()!;
    if (visited.has(currValue)) {
      continue;
    }
    visited.add(currValue);
    if (includeSelf) {
      yield currValue;
    }
    for (const newValue of expand(currValue)) {
      if (!includeSelf) {
        yield newValue;
      }
      stack.push(newValue);
    }
  }
}

export function hasSome(iterator: Iterator<any>): boolean {
  return !iterator.next().done;
}

export function *filter<T>(iterator: Iterator<T>, pred: (value: T) => boolean) : IterableIterator<T> {
   while (true) {
     const { done, value } = iterator.next();
     if (done) {
       break;
     }
     if (pred(value)) {
       yield value;
     }
   }
}

export function toArray<T>(value: T | T[]): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === null || value === undefined ? [] : [ value ];
}

export function *map<T, R>(iterator: Iterator<T>, func: (value: T) => R) : IterableIterator<R> {
   while (true) {
     const { done, value } = iterator.next();
     if (done) {
       break;
     }
     yield func(value);
   }
}

interface MapLike<T> { [key: string]: T }

export class FastMap<K extends PropertyKey, V> {

  private mapping: MapLike<V> = Object.create(null);

  public *values(): IterableIterator<V> {
    for (const key of Object.keys(this.mapping)) {
      yield this.mapping[key as string];
    }
  }

  public add(key: K, value: V): void {
    this.mapping[key as string] = value;
  }

  public has(key: K, value?: V): boolean {
    if (!(key in this.mapping)) {
      return false;
    }
    if (value === undefined) {
      return true;
    }
    return this.mapping[key as string] === value;
  }

  public get(key: K): V | undefined {
    return this.mapping[key as string];
  }

  public delete(key: K): boolean {
    if (!(key in this.mapping)) {
      return false;
    }
    delete this.mapping[key as string]
    return true;
  }

}

export class MultiMap<K extends PropertyKey, V> {

  private mapping: MapLike<V[]> = Object.create(null);

  public *values(): IterableIterator<V> {
    for (const key of Object.keys(this.mapping)) {
      yield* this.mapping[key as string];
    }
  }

  public add(key: K, value: V): void {
    if (key in this.mapping) {
      this.mapping[key as string].push(value);
    } else {
      this.mapping[key as string] = [ value ];
    }
  }

  public has(key: K, value?: V): boolean {
    if (!(key in this.mapping)) {
      return false;
    }
    if (value === undefined) {
      return true;
    }
    return this.mapping[key as string].indexOf(value) !== -1;
  }

  public *get(key: K): IterableIterator<V> {
    if (key in this.mapping) {
      yield* this.mapping[key as string];
    }
  }

  public delete(key: K, value?: V): boolean {
    if (!(key in this.mapping)) {
      return false;
    }
    if (value === undefined) {
      delete this.mapping[key as string]
      return true;
    } else {
      const values = this.mapping[key as string];
      const i = values.indexOf(value);
      if (i === -1) {
        return false;
      }
      values.splice(i, 1);
      return true;
    }
  }

}

export type ArgResolver
  = string
  | ((value: any) => string)

export function memoise<F extends (...args: any[]) => any>(fn: F, ...resolvers: ArgResolver[]): F {
  const cache: MapLike<any> = Object.create(null);
  const resolve = (arg: any, i: number) => {
    const resolver = resolvers[i];
    if (resolver === undefined) {
      return arg;
    }
    if (typeof(resolver) === 'string') {
      const propertyKey = resolver;
      return arg[propertyKey];
    }
    return resolver(arg);
  }
  return function (...args) {
    const key = args.map(resolve).join(':');
    if (key in cache) {
      return cache[key];
    } else {
      return cache[key] = fn(...args);
    }
  } as F;
}

export function assert(test: boolean): asserts test {
  if (!test) {
    throw new Error(`Assertion error: an internal invarant failed. This most likely means a bug in tsastgen or an incompatible TypeScript compiler.`)
  }
}

export function mapValues<T extends object, R extends object>(obj: T, func: (value: T[keyof T], key: keyof T) => R[keyof R]): R {
  const result: Partial<R> = {};
  for (const key of Object.keys(obj)) {
    result[key as keyof R] = func(obj[key as keyof T], key as keyof T);
  }
  return result as R;
}

export function values<T extends object>(obj: T): T[keyof T][] {
  const result = [];
  for (const key of Object.keys(obj)) {
    result.push(obj[key as keyof T]);
  }
  return result;
}

export function spread<T>(iterator: Iterator<T>): T[] {
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
