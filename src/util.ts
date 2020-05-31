
export function error(message: string) {
  console.error(`Error: ${message}`)
}

export interface MapLike<T> { [key: string]: T }

export function *map<T, R>(iterator: Iterator<T>, func: (value: T) => R) : IterableIterator<R> {
   while (true) {
     const { done, value } = iterator.next();
     if (done) {
       break;
     }
     yield func(value);
   }
}

export function assert(test: boolean): void {
  if (!test) {
    throw new Error(`Assertion error: an internal invarant failed. This most likely means a bug in tsastgen or an incompatible TypeScript compiler.`)
  }
}

export function hasSome(iterator: Iterator<any>): boolean {
  return iterator.next().done === false;
}
