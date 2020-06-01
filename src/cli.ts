#!/usr/bin/env node

import * as fs from "fs"
import * as path from "path"
import ts from "typescript"

import "source-map-support/register"

import generateCode from "./index"
import { error } from "./util"

const tsArgv = [];
let inFile: string | null = null;
let outFile: string | null = null;

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--out-file=')) {
    const k = arg.indexOf('=');
    outFile = arg.substring(k);
  } else if (arg.startsWith('--out-file')) {
    i++;
    if (i >= process.argv.length) {
      error(`Missing value for --out-file.`);
      process.exit(1);
    }
    outFile = process.argv[i];
  } else if (!arg.startsWith('-')) {
    inFile = arg;
  } else {
    tsArgv.push(arg);
  }
}

if (inFile === null) {
  error(`Must specify exactly one input file.`);
  process.exit(1);
}

// const parsedCommandLine = ts.parseCommandLine(tsArgv);

// if (parsedCommandLine.errors.length > 0) {
//   printDiagnostics(parsedCommandLine.errors);
//   error(`Invalid command-line arguments passed to compiler invocation.`)
//   process.exit(1);
// }

// if (parsedCommandLine.fileNames.length > 1) {
//   error(`May specify at most one source file to process at a time.`);
//   process.exit(1);
// }

const sourceFile = ts.createSourceFile(inFile, fs.readFileSync(inFile, 'utf8'), ts.ScriptTarget.Latest, true);
const generatedCode = generateCode(sourceFile);
console.error(generatedCode);

// const program = ts.createProgram(parsedCommandLine.fileNames, { ...parsedCommandLine.options, noEmit: true });

// let emitResult = program.emit(undefined, undefined, undefined, undefined, {
//   before: [
//     createTransformer({
//       isSpecificationFile(fileName) {
//         return true;
//       },
//       getOutputPath(fileName) {
//         return outFile;
//       }
//     })
//   ],
// });

// printDiagnostics(ts.getPreEmitDiagnostics(program))
// printDiagnostics(emitResult.diagnostics);

// if (emitResult.emitSkipped) {
//   error(`Failed to emit JavaScript souces.`);
//   process.exit(1);
// }

// function printDiagnostics(diagnostics: readonly ts.Diagnostic[]) {
//   diagnostics.forEach(diagnostic => {
//     if (diagnostic.file) {
//       let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
//       let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
//       console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
//     } else {
//       console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
//     }
//   });
// }

// function stripExtensions(filename: string) {
//   const i = filename.indexOf('.');
//   if (i === -1 || i === 0) {
//     return filename;
//   } else{
//     return filename.substring(0, i);
//   }
// }
