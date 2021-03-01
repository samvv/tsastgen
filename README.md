
`tsast` is an AST definition generator for TypeScript. You specify how your
tree should look, and `tsast` will automatically write up classes, functions
and interfaces that allow you to access and manipulate the syntax tree.

:warning: This is a work-in-progress, so the API might still contain a few bugs.

## Usage

Currently, `tsast` ships with a single binary `tsast-gen-template` that you can invoke
from the terminal. It accepts a path to a TypeScript declaration file, which
could look like this:

```ts
type Expression
  = BinaryAddition
  | BinaryMultiplication
  | NumberLiteral

interface BinaryExpression {
  left: Expression;
  right: Expression;
}

export interface BinaryAddition extends BinaryExpression {

}

export interface BinaryMultiplication extends BinaryExpression {

}

export interface NumberLiteral {
  value: number;
}
```

`tsast-gen-template` will write a full type specification for this simple AST,
including visitors and transformers.

```ts
import * as calc from "./ast"

// Evaluate a single expression
function evaluate(node: calc.Syntax): number {
  switch (node.kind) { 
    case calc.SyntaxKind.BinaryAddition:
      return evaluate(node.getLeft()) + evaluate(node.getRight());
    case calc.SyntaxKind.BinaryMultiplication:
      return evaluate(node.getLeft()) + evaluate(node.getRight());
    case calc.SyntaxKind.NumberLiteral:
      return node.getValue();
  }
}

const expr1 = new calc.BinaryAddition(
  /* left */ new calc.NumberLiteral(1),
  /* right */ new calc.NumberLiteral(2)
)

evaluate(expr1); // returns 3
```

## Limitations

 - Mutations on indexed nodes that are more than one level deeper than the node
   containing the index might fail to update properly. Currently, there are no
   use-cases for this scenario, but it might become a problem in the future.
 - Currently, it is not possible to edit a node in-place. You can only use the
   `.tranform()`-method to generate mutable _proxies_ of the node you wish to
   edit. This limitation will be lifted in the future.

## API

### new Node(id, ...fields, parent, origNode, span)

Where `Node` stands for the name of a node that you have defined.

Create a new instance of the given node.

 - `id`: A `number` that has to be unique.
 - `fields`: The fields that direct children of the `Node`. This could be any
   JavaScript value, including other nodes.
 - `parent`: The parent node of the node that is going to be created. Leave
   `null` for the root node or if you want to set the parent later on.
   Defaults to `null`.
 - `origNode`: The node that gave rise to this node. For instance, a JavaScript
   spread operator (`...`) might create a function call to `.concat()`, in which
   case `origNode` is the node corresponding to the spread operator. Leave `null`
   if this node is not derived from another node. Defaults to `null`.
 - `span`: A text range specifying where the node was defined. If left to `null`, the
   AST will attempt to use `origNode` to get the text range. Defaults to `null`.

### node.getField()

Where `Field` stands for a property on the node that you have defined.

Access the value of the given property.

This method can only be used if the property is **not** an array.

### node.getFieldAt(index)

Where `Field` stands for a property on the node that you have defined.

Gets the element at the given index of the property defined by `Field`.

This method is only avaialbe when the property is an array.

### node.getFieldCount()

Where `Field` stands for a property on the node that you have defined.

Get the amount of elements that the property defined by `Field` contains.

This method is only avaialbe when the property is an array.

### node.transform(traverseStyle, proc)

Transforms the given node into something new using the callback `proc`. 

 - `traverseStyle`: A bit mask specifying how the nodes should be visited. You
   can use either of `TraverseStyle.PreOrder` or `TraverseStyle.PostOrder`, or
   both. See the [WikiPedia article][2] for more information on how the AST can
   be traversed.

`proc` is called with the following arguments:

 - `node`: The node that currently is being transformed. It is of type
   `Mutable<Syntax>`. Use one of the methods `.remove()`, `.appendField()`,
   `.setField()`, ... to do the actual transformation.

[2]: https://en.wikipedia.org/wiki/Tree_traversal

### node.setField(value)

Where `Field` stands for a property on the node that you have defined.

Sets the property to the given value. 

This method only be used inside a transformer and when the property is **not**
an array. 

### node.removeField()

Where `Field` stands for a property on the node that you have defined.

Removes the property from this node. 

This method can only be used inside a transformer and when the property is
nullable.

### node.remove()

Can only be used inside a transformer. Will cause the node to be removed from
its parent. This can only happen if the corresponding property on the parent node
is an array or if the property is nullable. This function will throw an error
if the node cannot be unset on the parent.

### node.appendField(field)

Where `Field` stands for a property on the node that you have defined.

Inserts a single node at the beginning of the child array.

This method is only available if the field is an array.

### node.prependField(fied)

Where `Field` stands for a property on the node that you have defined.

Inserts a single node at the end of the child array.

This method is only available if the field is an array.

## FAQ

### What is an AST?

AST is short for _abstract syntax tree_. It refers to a set of data structures
that represent a piece of source code but are easier to digest than raw text.
A good AST allows you to quickly and effectively transform a piece of source
code to something else.

### Why go through all the trouble of distinguishing mutable nodes from immutable ones?

Because it allows us to choose how traverse the tree safely while performing
side-effects. For example, we could add new nodes to the tree while traversing
without having to worry that they are also unexpectedly visited.

## License

This code is generously licensed under the MIT license.

