#!/usr/bin/env node

import * as fs from "fs"
import * as path from "path"
import ts from "typescript"

import "source-map-support/register"
import minimist from "minimist"

import generateCode from "./index"
import { error, fatal } from "./util"

const argv = minimist(process.argv.slice(2));

const files = argv._;

for (const file of files) {
  const i = file.indexOf(':');
  let outFile = null;
  let inFile;
  if (i === -1) {
    inFile = file;
  } else {
    outFile = file.substring(i+1);
    inFile = file.substring(0, i);
  }
  const sourceFile = ts.createSourceFile(inFile, fs.readFileSync(inFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const generatedCode = generateCode(sourceFile, {
    generateVisitor: argv['with-visitor'],
    rootNodeName: argv['with-root-node'] ?? argv['root-node'],
    parentMemberName: argv['with-parent-member'],
    idMemberName: argv['with-id-member']
  });
  if (outFile === null) {
    console.error(generatedCode);
  } else {
    console.error(`Writing generated AST definitions to ${path.resolve(outFile)} ...`)
    fs.writeFileSync(outFile, generatedCode, 'utf8');
  }
}
