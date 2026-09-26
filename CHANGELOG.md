# Changelog

## 0.186.1 (2026-09-26)

- The README is rewritten for a first-time reader: a step-by-step from an empty folder to a
  turning cube, three.js and F# side by side, and the differences explained in plain terms.
  No change to the bindings.

## 0.186.0 (2026-09-26)

First release. Generated from `@types/three` 0.186.0 for three.js r186.

- All of `three` and every module `three/addons` exports, with XML docs and `[<Obsolete>]`
  carried over from three.js.
- Classes with native `new`/`instanceof`, named-argument constructors for parameter objects,
  enums and string enums for the constants, erased unions with implicit conversions.
- Members that only exist for the WebGPU renderer (the `colorNode` family on materials) are
  left out rather than bound as `obj`.
- A small demo in `demo/`.
