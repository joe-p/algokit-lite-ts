## Fixes

- The package now ships compiled JavaScript and type declarations instead of raw TypeScript source. It imports in plain Node.js and type-checks in projects using `"moduleResolution": "NodeNext"`, `"noUnusedLocals"`, or no Node.js types (such as new Vite apps).
- Removed the use of the Node.js `Buffer` global, so the library works in browsers without a polyfill.
- `prettier` is now a dependency, so `ARC56Generator` output is always formatted.
