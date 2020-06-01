AST Generator for TypeScript
============================

This small utility generates complete definitions for an abstract syntax tree (AST) in the TypeScript language.
It uses an ordinary TypeScript file as specification file, and will automatically generate classes, contstructors, union types,
and predicates based on this specification.

## Usage

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
class CalcNode {
  // You can add as many class members as you like.
  // They will be automatically transferred to the resulting definitions file.
}

interface Expression extends CalcNode {}

// This is a 'trait' declaration. It does not inherit from CalcNode,
// but it does define some fields that every AST node having this trait
// should implement.
interface BinaryExpression {
  left: Expression;
  right: Expression;
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

If `--root-node` is not specified, _tsastgen_ will fall back to searching for a class declaration called `Syntax`.

## License

I chose to license this piece of software under the MIT license, in the hope that you may find it useful.
You may freely use this generator in your own projects, but it is always nice if you can give a bit of credit.

