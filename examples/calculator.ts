
class CalcBase {

  constructor(foo: string) {

  }

}

interface Expression extends CalcBase {}

interface BinaryExpression {
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

