
const fs = require('fs-extra')
const gulp = require('gulp')
const ts = require('gulp-typescript')
const pegjs = require('pegjs')

const proj = ts.createProject('tsconfig.json')

async function getContents(file) {
  if (file.contents === null) {
    return file.contents = await fs.readFile(file.path);
  }
  if (file.contents instanceof stream.Readable) {
    return file.contents = await toString(file.contents)
  }
  return file.contents
}

function buildSrc() {
  return proj.src()
    .pipe(proj())
    .on('error', noop)
    .pipe(gulp.dest('lib/'))
}

function noop() {  }

async function generateParser() {
  await fs.writeFile('lib/typescript-simple.js', pegjs.generate(await fs.readFile('src/typescript-simple.pegjs', 'utf8'), { output: 'source' }))
}

const build = gulp.parallel(buildSrc, generateParser)

function watch() {
  gulp.watch('src/**/*.ts', buildSrc)
  gulp.watch('src/typescript-simple.pegjs', generateParser)
}

module.exports = {
  default: build,
  build,
  watch,
}

