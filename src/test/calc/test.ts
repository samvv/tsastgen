
import * as calc from "./ast"
import { assert } from "chai"

describe('a simple calculator grammar', () => {

  it('can evaluate an expression', () => {

    const expr1 = new calc.BinaryAddition(
      /* left */ new calc.NumberLiteral(1),
      /* right */ new calc.NumberLiteral(2)
    )

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

    assert.strictEqual(evaluate(expr1), 3);

  })

  it('can access an indexed definition by name', () => {
    const prog1 = new calc.Program([
      new calc.Definition('Foo', new calc.NumberLiteral(1))
    ])
    const def1 = prog1.getDefinitionByName('Foo')
    assert.strictEqual(def1.getName(), 'Foo');
  })

  it('can access the root node from deeply nested nodes', () => {
    const num1 = new calc.NumberLiteral(1);
    const prog1 = new calc.Program([
      new calc.Definition('Foo', num1)
    ])
    assert.isOk(num1.getProgram());
  })

  it('can access an indexed definition by name inside a transformation context', () => {
    const prog1 = new calc.Program([
      new calc.Definition('Foo', new calc.NumberLiteral(1))
    ])
    prog1.transform(calc.TraverseStyle.PreOrder, node => {
      const def1 = node.getParentOfKind(calc.SyntaxKind.Program).getDefinitionByName('Foo')
      assert.strictEqual(def1.getName(), 'Foo');
    })
  })

  it('can add a definition during tranformation and have it added to the index immediately', () => {
    const prog1 = new calc.Program([
    ])
    prog1.transform(calc.TraverseStyle.PostOrder, node => {
      if (calc.isProgram(node)) {
        node.appendDefinition(new calc.Definition('Foo', new calc.NumberLiteral(1)));
        assert.isOk(node.getDefinitionByName('Foo'));
      }
    })
  })

  it('can remove a definition during tranformation and have it thrown out of the index immediately', () => {
    const prog1 = new calc.Program([
      new calc.Definition('Foo', new calc.NumberLiteral(1))
    ])
    prog1.transform(calc.TraverseStyle.PostOrder, node => {
      if (calc.isDefinition(node)) {
        node.remove();
        assert.throws(() => node.getProgram().getDefinitionByName('Foo'), "Could not find Foo in the requested index.");
      }
    })
  })

});

