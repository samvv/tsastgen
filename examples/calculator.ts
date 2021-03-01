
export class CalcNode {

  constructor(foo: string) {

  }

}

export interface Sheet {
  elements: SheetElement[];
}

export interface SheetElement {};

export interface Definition extends SheetElement, CalcNode {
  name: string;
  expression: Expression;
}

export interface Expression extends CalcNode {}

export interface BinaryExpression {
  left: Expression;
  right: Expression;
}

export interface SubtractExpression extends BinaryExpression, Expression {}
export interface AddExpression extends BinaryExpression, Expression {}
export interface MultiplyExpression extends BinaryExpression, Expression {}
export interface DivideExpression extends BinaryExpression, Expression {}

export type CommutativeExpression 
  = AddExpression
  | SubtractExpression
  | MultiplyExpression;

