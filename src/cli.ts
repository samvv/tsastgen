#!/usr/bin/env node

import * as path from "path"
import ts from "typescript"

import "source-map-support/register"

import createTransformer from "./index"
import { error } from "./util"
import { pathExists } from "fs-extra";

const parsedCommandLine = ts.parseCommandLine(process.argv.slice(2));

if (parsedCommandLine.errors.length > 0) {
  printDiagnostics(parsedCommandLine.errors);
  error(`Invalid command-line arguments passed to compiler invocation.`)
  process.exit(1);
}

let program = ts.createProgram(parsedCommandLine.fileNames, parsedCommandLine.options, );
const { sourceRoot } = program.getCompilerOptions();
let emitResult = program.emit(undefined, undefined, undefined, undefined, {
  before: [
    createTransformer({
      isSpecificationFile(fileName) {
        return true;
      },
      getOutputPath(fileName) {
        return path.join(path.dirname(fileName), stripExtensions(path.basename(fileName)) + '-generated.ts');
      }
    })
  ],
});

printDiagnostics(ts.getPreEmitDiagnostics(program))
printDiagnostics(emitResult.diagnostics);

if (emitResult.emitSkipped) {
  error(`Failed to emit JavaScript souces.`);
  process.exit(1);
}

function printDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
  diagnostics.forEach(diagnostic => {
    if (diagnostic.file) {
      let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
      let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
    } else {
      console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }
  });
}

function stripExtensions(filename: string) {
  const i = filename.indexOf('.');
  if (i === -1 || i === 0) {
    return filename;
  } else{
    return filename.substring(0, i);
  }
}
