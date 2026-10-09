// The Pyodide Emscripten module has no type file of its own.
declare module "pyodide/pyodide.asm.mjs" {
  const createPyodideModule: unknown;
  export default createPyodideModule;
}
