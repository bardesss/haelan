/** Types for the icon renderer, which is plain .mjs so it can be run with bare `node`. */
export declare const GEOMETRY: number[][][]
export declare const PATHS: { stems: string; pulse: string }
export declare function renderIcons(webDir: string): { ico: number[]; pwa: (number | string)[] }
