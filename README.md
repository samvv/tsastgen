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
// The root node of our syntax tree. Every AST node should inherit from it, either directly or
// indirectly.
export class CalcNode {
  
  // You can add as many class members as you like.
  // They will be automatically transferred to the resulting definitions file.
  private typeInformation = null;
  
  // If you specify a constructor, the parameters will be automatically appended
  // to the constructor of each derived AST node.
  constructor(public textOffset?: number) {
  
  }
  
}

export interface Definition extends CalcNode {
  name: string;
  expression: Expression;
}

export interface Expression extends CalcNode {}

// This is a 'trait' declaration. It does not inherit from CalcNode,
// but it does define some fields that every AST node having this trait
// should implement.
interface BinaryExpression {
  left: Expression;
  right: Expression;
}

export interface ConstantExpression {
  value: number;
}

export interface SubtractExpression extends BinaryExpression, Expression {}
export interface AddExpression extends BinaryExpression, Expression {}
export interface MultiplyExpression extends BinaryExpression, Expression {}
export interface DivideExpression extends BinaryExpression, Expression {}

// Another 'trait' declaration, this time defined as a simple TypeScript union type.
// tsastgen will automatically generate types and predicates for this trait.
export type CommutativeExpression 
  = AddExpression
  | SubtractExpression
  | MultiplyExpression;
```

Now all you need to do is to run `tsastgen` and make sure it knows what the output file and the root node is.

```
tsastgen --root-node=CalcNode --output calc.ts calc-spec.ts
```

Here's an example of how the generated code might be used:

```ts
import { Expression } from "./calc"

export function calculate(node: Expression): number {
  switch (node.kind) {
    case SyntaxKind.AddExpression:
       // The fields 'left' and 'right' will now be automatically available, since
       // AddExpression inherits from BinaryExpression.
       return node.left + node.right;
    case SyntaxKind.SubtractExpression:
      // ...
    default:
      throw new Error(`I did not know how to process the given node.`);
  }
}
```

In the above example, due to the way in which the code is generated, the compiler automatically knows
when certain fields are present. The same feature can be seen in the following example:

```ts
const node = generateANewNodeSomehow();

if (isDefinition(node)) {
  // The fields 'name' and 'expression' are now available.
}
```

Creating nodes is also very easy:

```ts
const n1 = createConstantExpression(1);
const n2 = createConstantExpression(2);
const add = createAddExpression(n1, n2);

console.log(`The result of 1 + 2 is ${calculate(add)}`);
```

It is recommended to not use the `new` operator. Instead, use the wrapping `createX` function.
The motivation is that in the future we might use a more efficient representation than a class,
using `createX`-functions guarantees forward compatibility.

## CLI Options

```
tsast [input-file[:output-file]..] --root-node=<name>
```

### input-file

The specification file that AST definitions will be generated from.

### output-file

If present, the file where the transformed `input-file` must be written to.

### --root-node

The name of the node that serves as the root node of the abstract syntax tree.
It will automatically be converted to a union type containing all possible AST node types.

If `--root-node` is not specified, _tsastgen_ will search for a declaration named `Syntax`.

## License

I chose to license this piece of software under the MIT license, in the hope that you may find it useful.
You may freely use this generator in your own projects, but it is always nice if you can give a bit of credit.

