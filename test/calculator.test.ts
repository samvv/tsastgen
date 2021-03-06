
import test from "ava";
import {createImportDeclaration} from "typescript";

import {
  createAddExpression,
  CalcNodeKind,
  ConstantExpression,
  createConstantExpression,
  setParents,
  createDefinition,
  ReferenceExpression,
  createSheet,
  createIdentifier
} from "./calculator";

test('can use auto-casts in factory functions', t => {
  const addOneTwo = createAddExpression(1, 'x');
  t.assert(addOneTwo.kind === CalcNodeKind.AddExpression);
  t.assert(addOneTwo.left.kind === CalcNodeKind.ConstantExpression);
  t.assert((addOneTwo.left as ConstantExpression).value === 1);
  t.assert(addOneTwo.right.kind === CalcNodeKind.ReferenceExpression);
  t.assert((addOneTwo.right as ReferenceExpression).name === 'x');
});

test('can get the parent of a node after setParents()', t => {
  const one = createConstantExpression(1);
  const two = createConstantExpression(2);
  const addOneTwo = createAddExpression(one, two);
  const foo = createDefinition('foo', addOneTwo)
  setParents(foo)
  t.assert(foo.parentNode === null);
  t.assert(one.parentNode === addOneTwo);
  t.assert(two.parentNode === addOneTwo);
  t.assert(addOneTwo.parentNode === foo);
});

test('can traverse child nodes in the correct order with getChildNodes()', t => {
  const one = createConstantExpression(1);
  const two = createConstantExpression(2);
  const addOneTwo = createAddExpression(one, two);
  const four = createConstantExpression(4);
  const addThreeFour = createAddExpression(addOneTwo, four);
  const fourtyTwo = createConstantExpression(42);
  const answerId = createIdentifier('answer');
  const answerDef = createDefinition(answerId, fourtyTwo);
  const fooId = createIdentifier('foo');
  const fooDef = createDefinition(fooId, addThreeFour)
  const sheet = createSheet([
    fooDef,
    answerDef
  ])
  const sheetChilNodes = [...sheet.getChildNodes()];
  t.assert(sheetChilNodes[0] === fooDef);
  t.assert(sheetChilNodes[1] === answerDef);
  const fooDefChildNodes = [...fooDef.getChildNodes()];
  t.assert(fooDefChildNodes[0] === fooId);
  t.assert(fooDefChildNodes[1] === addThreeFour);
  const theAnwserChildNodes = [...answerDef.getChildNodes()];
  t.assert(theAnwserChildNodes[0] === answerId);
  t.assert(theAnwserChildNodes[1] === fourtyTwo);
  t.assert([...fourtyTwo.getChildNodes()].length === 0);
  t.assert([...one.getChildNodes()].length === 0);
  t.assert([...two.getChildNodes()].length === 0);
  t.assert([...four.getChildNodes()].length === 0);
  const addThreeFourChildNodes = [...addThreeFour.getChildNodes()];
  t.assert(addThreeFourChildNodes[0] === addOneTwo);
  t.assert(addThreeFourChildNodes[1] === four);
  const addOneTwoChildNodes = [...addOneTwo.getChildNodes()];
  t.assert(addOneTwoChildNodes[0] === one);
  t.assert(addOneTwoChildNodes[1] === two);
});

