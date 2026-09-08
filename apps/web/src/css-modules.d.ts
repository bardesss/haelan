// TypeScript 7 refuses a side-effect import of a file it has no declaration for (TS2882), where
// 5.x let one through. `import './app.css'` in main.tsx is exactly that: Vite resolves it at build
// time and the compiler has no business type-checking a stylesheet, but it does need to be told
// the module exists.
//
// Declared as a whole extension rather than per file, because every stylesheet this app adds will
// be imported the same way and a per-file declaration would be one more thing to remember.
declare module '*.css'
