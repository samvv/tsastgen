
export interface Grammar {
  importStatements: ImportStatement[];
  /**
   * @index(RuleByName, ParseRule.name, OperandRule.name)
   */ 
  rules: Rule[];
}

export interface ImportStatement {
  moduleName: string;
  bindingName: string;
}

type Expression
  = SequenceExpression
  | ChoiceExpression
  | ReferenceExpression
  | PipeExpression
  | ParenExpression
  | ActionExpression
  | LookaheadExpression
  | RepeatExpression
  | StringLiteral
  | CharClassLiteral
  | AnyCharLiteral
  | TextExpression

type Rule
  = ParseRule
  | PrecedenceRule
  | OperandRule

export interface ParseRule {
  isPublic: boolean;
  name: string;
  displayName: string | null;
  expression: Expression;
}

export interface PrecedenceRule {
  name: string;
  precedence: number;
}

export interface OperandRule {
  isPublic: boolean;
  name: string;
  binding: string;
  expression: Expression;
}

interface ExpressionBase {
  isPicked: boolean;
  label: string | null;
}

interface NAryExpression extends ExpressionBase {
  children: Expression[];
}

interface UnaryExpression extends ExpressionBase {
  child: Expression;
}

export interface SequenceExpression extends NAryExpression {
  
}

export interface ChoiceExpression extends NAryExpression {

}

export interface LookaheadExpression extends UnaryExpression {
  isNegative: boolean;
}

export interface PipeExpression extends UnaryExpression {
  name: string;
}

export interface ParenExpression extends UnaryExpression {

}

export interface ActionExpression extends UnaryExpression {
  code: string;
}

export interface RepeatExpression extends UnaryExpression {
  min: number;
  max: number;
}

export interface TextExpression extends UnaryExpression {

}

export interface ReferenceExpression extends ExpressionBase {
  text: string;
}

export interface StringLiteral extends ExpressionBase {
  text: string;
  ignoreCase: boolean;
}

export interface CharClassLiteral extends ExpressionBase {
  elements: ([number, number] | number)[];
  inverted: boolean;
  ignoreCase: boolean;
}

export interface AnyCharLiteral extends ExpressionBase {
  
}

