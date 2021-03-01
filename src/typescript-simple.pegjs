{
  function flatten1(arr) {
    return Array.prototype.concat.apply([], arr);
  }
}

File
  = __ @(@Declaration __)*

__  = [ \t\r\n]*
__1 = [ \t\r\n]+

AttributeComment
  = "/**" __ @(CommentSkip @IndexAttribute)* CommentSkip __ "*/"

IndexAttribute
  =  "@index" __ '(' __ name:Identifier paths:(__ ',' __ @PropertyPath)* __ ')' {
      return { type: 'IndexAttribute', name, paths }
    }

CommentSkip = (!('@' / '*/') .)*

PropertyPath
  = head:Identifier tail:('.' @Identifier)* { return [head, ...tail] }

IdentifierStart = [a-zA-Z]
IdentifierPart  = [a-zA-Z0-9]

Identifier = !Reserved @$(IdentifierStart IdentifierPart*)

ExportToken    = 'export'    !IdentifierPart
InterfaceToken = 'interface' !IdentifierPart
TypeToken      = 'type'      !IdentifierPart
NullToken      = 'null'      !IdentifierPart
StringToken    = 'string'    !IdentifierPart
FalseToken     = 'false'     !IdentifierPart
TrueToken      = 'true'      !IdentifierPart
BooleanToken   = 'boolean'   !IdentifierPart
ExtendsToken   = 'extends'   !IdentifierPart
NumberToken    = 'number'    !IdentifierPart

Reserved
  = InterfaceToken
  / TypeToken
  / NullToken
  / StringToken
  / FalseToken
  / TrueToken
  / BooleanToken
  / NumberToken
  / ExportToken

NullType
  = NullToken { return { type: 'NullType' } }

BooleanType
  = 'boolean' { return { type: 'BooleanType' } }
  / 'true' { return { type: 'TrueTypeLiteral' } }
  / 'false' { return { type: 'FalseTypeLiteral' } }

TypeReference 
  = name:Identifier {
      return { type: 'TypeReference', name }  
    }

StringType
  = StringToken { return { type: 'StringType' } }

NumberType
  = NumberToken { return { type: 'NumberType' } }

TypeDecl
  = head:TupleType tail:(__ '|' __ @TupleType)* {
      return tail.length === 0 ? head : { type: 'UnionType', elements: [head, ...tail] }
    }

TupleType
  = '[' __ head:ArrayType tail:(__ ',' __ @ArrayType)* __ ']' {
      return { type: 'TupleType', elements: [head, ...tail] }
    }
  / ArrayType

ArrayType
  = elementType:PrimTypeDecl arrToken:(__ '[]')? {
    if (arrToken === null) return elementType;
    return { type: 'ArrayType', elementType }
  }

PrimTypeDecl
  = TypeReference
  / BooleanType
  / StringType
  / NumberType
  / NullType
  / '(' __ @TypeDecl __ ')'

TypeAlias 
  = TypeToken __ name:Identifier __ '=' __ typeDecl:TypeDecl {
      return { type: 'TypeAlias', name, typeDecl }
    }

Declaration
  = TypeAlias
  / InterfaceDeclaration

PropertyDeclarations
  = (@PropertyDeclaration __ ";" __)*

PropertyDeclaration
  = attrsList:(@AttributeComment __)* name:Identifier __ ':' __ typeDecl:TypeDecl { return { type: 'MemberProperty', name, typeDecl, attributes: flatten1(attrsList) } }

InterfaceDeclaration
  = exportToken:(@ExportToken __)? InterfaceToken __ name:Identifier __ extendsClause:(__ ExtendsToken __ @Identifier)? __ '{' __ properties:PropertyDeclarations __ '}' {
      return {
        type: 'InterfaceDeclaration',
        properties,
        name,
        extendsClause,
        isExported: exportToken !== null
      }
    }

