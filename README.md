AST Generator for TypeScript
============================

This small utility generates complete definitions for an abstract syntax tree
(AST) in the TypeScript language. It read an ordinary TypeScript file as
a specification file, and will automatically generate classes, contstructors,
union types, visitors, and predicates based on this specification.

## Basic Usage

First you have to install the package:

```
npm install tsastgen
````

Now a binary called `tsastgen` should be available in your favorite shell.
If not, check your `PATH` variable and that _npm_ is properly configured.

Next, create a specification file. Here's an example:

**calc-spec.ts**

```ts
// The root node of our syntax tree. Every AST node should inherit from it,
// either directly or indirectly.
export class AST {

  // You can add as many class members as you like. They will be automatically
  // transferred to the resulting definitions file.
  private typeInformation = null;

  // If you specify a constructor, the parameters will be automatically appended
  // to the constructor of each derived AST node.
  constructor(public annotation: string | null = null) {

  }

  public hasAnnotation(): boolean {
    return this.annotation !== null;
  }

}

export interface Definition extends AST {
  name: string;
  expression: Expression;
}

export interface Expression extends AST {
  lazyEvaluatedResult?: number;
}

export interface ConstantExpression extends Expression {
  value: number;
}

export interface BinaryExpression extends Expression {
  left: Expression;
  right: Expression;
}

export interface SubtractExpression extends BinaryExpression {

}

export interface AddExpression extends BinaryExpression {

}

export interface MultiplyExpression extends BinaryExpression {

}

export interface DivideExpression extends BinaryExpression {

}

export type CommutativeExpression 
  = AddExpression
  | SubtractExpression
  | MultiplyExpression;
```

Now all you need to do is to run `tsastgen` and make sure it knows what the
output file and the root node is.

```
tsastgen --root-node=AST calc.ts:calc-spec.ts
```

### How to match certain generated AST nodes

Here's an example of how the generated code might be used:

```ts
import { Expression } from "./calc"

export function calculate(node: Expression): number {
  switch (node.kind) {
    case SyntaxKind.AddExpression:
       return node.left + node.right;
    case SyntaxKind.SubtractExpression:
      // and so on ...
    default:
      throw new Error(`I did not know how to process the given node.`);
  }
}
```

In the above example, due to the way in which the code is generated, the
compiler automatically knows when certain fields are present.

Alternatively, you can use the generated AST predicates combined with an
if-statement to prevent casting:

```ts
const node = generateANewNodeSomehow();

if (isDefinition(node)) {
  // The fields 'name' and 'expression' are now available.
}
```

No matter which style you use, you will almost never have to cast to another
expression.

### How to create new AST nodes

Creating nodes is also very easy:

```ts
import {
  createAddExpression,
  createConstantExpression,
} from "./calc";

const n1 = createConstantExpression(1);
const n2 = createConstantExpression(2);
const add = createAddExpression(n1, n2);

console.log(`The result of 1 + 2 is ${calculate(add)}`);
```

It is recommended to not use the `new` operator. Instead, use the wrapping
`createX` function.  The motivation is that in the future we might use a more
efficient representation than a class, using `createX`-functions guarantees
forward compatibility.

## CLI Options

```
tsast [input-file[:output-file]..] --root-node=<name>
```

### input-file

The specification file that AST definitions will be generated from.

### output-file

If present, the file where the transformed `input-file` must be written to.
If not present, the program will output the result to standard output.

### --root-node

The name of the node that serves as the root node of the abstract syntax
tree.It will automatically be converted to a union type containing all possible
AST node types.

If `--root-node` is not specified, _tsastgen_ will search for a declaration
named `Syntax`.

## License

I chose to license this piece of software under the MIT license, in the hope
that you may find it useful. You may freely use this generator in your own
projects, but it is always nice if you can give a bit of credit.

