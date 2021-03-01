
type Expression
  = BinaryAddition
  | BinaryMultiplication
  | NumberLiteral

interface BinaryExpression {
  left: Expression;
  right: Expression;
}

export interface Program {
  /**
   * @index(DefinitionByName, Definition.name)
   */
  definitions: Definition[];
}

export interface Definition {
  name: string;
  expression: Expression;
}

export interface BinaryAddition extends BinaryExpression {

}

export interface BinaryMultiplication extends BinaryExpression {

}

export interface NumberLiteral {
  value: number;
}

