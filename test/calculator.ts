export function isCalcNode(value: any): value is CalcNode { return typeof value === "object" && value !== null && value instanceof CalcNodeBase; }

/**
 * Represents a slice of a text file.
 *
 * This object uses byte offsets to point to the right part of the text file.
 * If you want to move the range you will have to modify both the start and the
 * end offset.
 */
export class SourceTextSpan {
    constructor(public startOffset: number, public endOffset: number) {
    }
    /**
     * Count how many characters there are in this slice.
     */
    public get size() {
        return this.endOffset - this.startOffset;
    }
}

// This acts as a global counter that is incremented each time we create a new
// node. That way, we can hash nodes based on their ID and be sure there are no
// collisions.
let nextNodeId = 0;

// This is our root node. You specify it on the command-line with --root-node.
// If you forget to add this flag, tsastgen will by default search for a root
// node named 'Syntax'.
// Every node that should be part of the AST should in some way inherit from
// the root node. If you forget to do this, tsastgen will just emit the
// class/interface without any transformations.
export class CalcNodeBase {
    public readonly id: number;
    constructor(public span: SourceTextSpan | null = null, public parentNode: CalcNode | null = null) {
        this.id = nextNodeId++;
    }
}

export class Sheet extends CalcNodeBase {
    readonly kind = CalcNodeKind.Sheet;
    *getChildNodes(): Iterable<SheetChild> { for (let element of this.elements)
        yield element; }
    // This map is used to efficiently look up a definition given only is name.
    private definitionsByName = Object.create(null);
    constructor(public elements: SheetElement[], span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) {
        super(span, parentNode);
        for (const element of elements) {
            if (isDefinition(element)) {
                this.definitionsByName[element.name.text] = element;
            }
        }
    }
    /**
     * Get a definition using its name and return nothing if it was not found.
     *
     * @param name The name of the definition to search for.
     */
    public getDefinition(name: string): Definition | null {
        return this.definitionsByName[name] ?? null;
    }
}

export type SheetParent = never;

export type SheetChild = SheetElement | never;

export function isSheet(value: any): boolean { return value.kind === CalcNodeKind.Sheet; }

export function createSheet(elements: SheetElement[], span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): Sheet { return new Sheet(elements, span, parentNode); }

// All things that can be written inside a sheet should inherit from this node.
// In this example, this is just a Definition.
export type SheetElement = Definition;

// All things that can be written inside a sheet should inherit from this node.
// In this example, this is just a Definition.
export function isSheetElement(value: any): value is SheetElement { return value.kind === CalcNodeKind.Definition; }

export class Identifier extends CalcNodeBase {
    readonly kind = CalcNodeKind.Identifier;
    constructor(public text: string, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<IdentifierChild> { }
}

export type IdentifierParent = Definition | never;

export type IdentifierChild = never;

export function isIdentifier(value: any): boolean { return value.kind === CalcNodeKind.Identifier; }

export function createIdentifier(text: string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): Identifier { return new Identifier(text, span, parentNode); }

export class Definition extends CalcNodeBase {
    readonly kind = CalcNodeKind.Definition;
    constructor(public name: Identifier, public expression: Expression, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<DefinitionChild> { yield this.name; yield this.expression; }
}

export type DefinitionParent = Sheet | never;

export type DefinitionChild = Identifier | Expression | never;

export function isDefinition(value: any): boolean { return value.kind === CalcNodeKind.Definition; }

export function createDefinition(name: Identifier | string, expression: Expression | number | string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): Definition { if (typeof name === "string")
    name = createIdentifier(name); if (typeof expression === "number")
    expression = createConstantExpression(expression); if (typeof expression === "string")
    expression = createReferenceExpression(expression); return new Definition(name, expression, span, parentNode); }

export type Expression = ConstantExpression | ReferenceExpression | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression;

export function isExpression(value: any): value is Expression { return value.kind === CalcNodeKind.ConstantExpression || value.kind === CalcNodeKind.ReferenceExpression || value.kind === CalcNodeKind.SubtractExpression || value.kind === CalcNodeKind.AddExpression || value.kind === CalcNodeKind.MultiplyExpression || value.kind === CalcNodeKind.DivideExpression; }

export class ConstantExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.ConstantExpression;
    constructor(public value: number, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<ConstantExpressionChild> { }
}

export type ConstantExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type ConstantExpressionChild = never;

export function isConstantExpression(value: any): boolean { return value.kind === CalcNodeKind.ConstantExpression; }

export function createConstantExpression(value: number, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): ConstantExpression { return new ConstantExpression(value, span, parentNode); }

export class ReferenceExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.ReferenceExpression;
    constructor(public name: string, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<ReferenceExpressionChild> { }
}

export type ReferenceExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type ReferenceExpressionChild = never;

export function isReferenceExpression(value: any): boolean { return value.kind === CalcNodeKind.ReferenceExpression; }

export function createReferenceExpression(name: string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): ReferenceExpression { return new ReferenceExpression(name, span, parentNode); }

// You can view this as a kind of 'mixin' that will be pushed inside every node
// that inherits from it. Note that this interface does not extend CalcNode,
// though in theory it could.
export interface BinaryExpression {
    left: Expression;
    right: Expression;
}

export class SubtractExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.SubtractExpression;
    constructor(public left: Expression, public right: Expression, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<SubtractExpressionChild> { yield this.left; yield this.right; }
}

export type SubtractExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type SubtractExpressionChild = Expression | never;

export function isSubtractExpression(value: any): boolean { return value.kind === CalcNodeKind.SubtractExpression; }

export function createSubtractExpression(left: Expression | number | string, right: Expression | number | string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): SubtractExpression { if (typeof left === "number")
    left = createConstantExpression(left); if (typeof left === "string")
    left = createReferenceExpression(left); if (typeof right === "number")
    right = createConstantExpression(right); if (typeof right === "string")
    right = createReferenceExpression(right); return new SubtractExpression(left, right, span, parentNode); }

export class AddExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.AddExpression;
    constructor(public left: Expression, public right: Expression, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<AddExpressionChild> { yield this.left; yield this.right; }
}

export type AddExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type AddExpressionChild = Expression | never;

export function isAddExpression(value: any): boolean { return value.kind === CalcNodeKind.AddExpression; }

export function createAddExpression(left: Expression | number | string, right: Expression | number | string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): AddExpression { if (typeof left === "number")
    left = createConstantExpression(left); if (typeof left === "string")
    left = createReferenceExpression(left); if (typeof right === "number")
    right = createConstantExpression(right); if (typeof right === "string")
    right = createReferenceExpression(right); return new AddExpression(left, right, span, parentNode); }

export class MultiplyExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.MultiplyExpression;
    constructor(public left: Expression, public right: Expression, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<MultiplyExpressionChild> { yield this.left; yield this.right; }
}

export type MultiplyExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type MultiplyExpressionChild = Expression | never;

export function isMultiplyExpression(value: any): boolean { return value.kind === CalcNodeKind.MultiplyExpression; }

export function createMultiplyExpression(left: Expression | number | string, right: Expression | number | string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): MultiplyExpression { if (typeof left === "number")
    left = createConstantExpression(left); if (typeof left === "string")
    left = createReferenceExpression(left); if (typeof right === "number")
    right = createConstantExpression(right); if (typeof right === "string")
    right = createReferenceExpression(right); return new MultiplyExpression(left, right, span, parentNode); }

export class DivideExpression extends CalcNodeBase {
    readonly kind = CalcNodeKind.DivideExpression;
    constructor(public left: Expression, public right: Expression, span: SourceTextSpan | null = null, parentNode: CalcNode | null = null) { super(span, parentNode); }
    *getChildNodes(): Iterable<DivideExpressionChild> { yield this.left; yield this.right; }
}

export type DivideExpressionParent = Definition | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression | never;

export type DivideExpressionChild = Expression | never;

export function isDivideExpression(value: any): boolean { return value.kind === CalcNodeKind.DivideExpression; }

export function createDivideExpression(left: Expression | number | string, right: Expression | number | string, span: (SourceTextSpan | null) = null, parentNode: (CalcNode | null) = null): DivideExpression { if (typeof left === "number")
    left = createConstantExpression(left); if (typeof left === "string")
    left = createReferenceExpression(left); if (typeof right === "number")
    right = createConstantExpression(right); if (typeof right === "string")
    right = createReferenceExpression(right); return new DivideExpression(left, right, span, parentNode); }

// This type alias only consists of references to other AST node types, so a
// predicate isCommutativeExpression will be generated after you have run
// tsastgen.
export type CommutativeExpression = AddExpression | SubtractExpression | MultiplyExpression;

export function isCommutativeExpression(value: any): value is CommutativeExpression { return value.kind === CalcNodeKind.AddExpression || value.kind === CalcNodeKind.SubtractExpression || value.kind === CalcNodeKind.MultiplyExpression; }

export function kindToString(kind: CalcNodeKind): string { if (CalcNodeKind[kind] === undefined)
    throw new Error("The SyntaxKind value that was passed in is not valid."); return CalcNodeKind[kind]; }

export type CalcNode = Sheet | Identifier | Definition | ConstantExpression | ReferenceExpression | SubtractExpression | AddExpression | MultiplyExpression | DivideExpression;

export const NODE_TYPES = { Sheet, Identifier, Definition, ConstantExpression, ReferenceExpression, SubtractExpression, AddExpression, MultiplyExpression, DivideExpression };

export enum CalcNodeKind {
    Sheet,
    Identifier,
    Definition,
    ConstantExpression,
    ReferenceExpression,
    SubtractExpression,
    AddExpression,
    MultiplyExpression,
    DivideExpression
}


export function setParents(node: CalcNode, parentNode: CalcNode | null = null): void {
  // We cast to any here because parentNode is strongly typed and not generic
  // enough to accept arbitrary AST nodes
  node.parentNode = parentNode as any;
  for (const childNode of node.getChildNodes()) {
    setParents(childNode, node);
  }
}
