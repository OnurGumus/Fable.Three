// What the generator reads, where each output goes, and the hand decisions it cannot make itself.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const typesDir = path.join(root, "node_modules/@types/three");

export type Target = {
    /** F# namespace the declarations land in. */
    ns: string;
    /** Output file, relative to the repo root. */
    output: string;
    /** The .d.ts whose exports define the surface. */
    entry: string;
    /** JS module specifier for a declaration found in `file` (absolute .d.ts path). */
    moduleOf: (file: string) => string;
};

export const targets: Target[] = [
    {
        ns: "Three",
        output: "src/Fable.Three/Three.fs",
        entry: path.join(typesDir, "src/Three.d.ts"),
        moduleOf: () => "three",
    },
    {
        ns: "Three.Addons",
        output: "src/Fable.Three/Three.Addons.fs",
        entry: path.join(typesDir, "examples/jsm/Addons.d.ts"),
        moduleOf: (file) => {
            const rel = path.relative(path.join(typesDir, "examples/jsm"), file).replace(/\\/g, "/");
            return "three/addons/" + rel.replace(/\.d\.ts$/, ".js");
        },
    },
];

/**
 * Class type parameters kept as F# generics. Everything else is erased to its constraint,
 * which keeps `Mesh`, `Object3D` and friends non-generic (a type test on `Mesh<_, _>` cannot
 * be written, and one on `Mesh<A, B>` never matches under Fable).
 *
 * A parameter belongs here when subclasses pin it to a concrete type and methods take it
 * inside a callback — `Loader.load(url, onLoad: 'TData -> unit)` next to
 * `TextureLoader.load(url, onLoad: Texture -> unit)` is otherwise an ambiguous overload.
 */
export const keepGenerics: Record<string, string[]> = {
    Loader: ["TData", "TUrl"],
    // `getPoint(t, target?: TVector): TVector` — a Vector3 curve has to hand back a Vector3.
    Curve: ["TVector"],
    CurvePath: ["TVector"],
};

/** Symbols not worth binding: internal plumbing, or superseded by a hand-written helper. */
export const skip = new Set<string>([
    // The generic event map machinery; listeners take a plain `Event`.
    "EventListener",
]);

/** TS type names whose F# form is fixed by hand. Checked before anything else. */
export const typeOverrides: Record<string, string> = {
    EventListener: "Event -> unit",
};

/**
 * Declarations under these paths are not bound unless an entry point exports them; a
 * reference to one from a bound signature becomes `obj`. They are the WebGPU renderer's
 * node system, which `three` (the WebGL build) only mentions in passing.
 */
export const opaque: RegExp[] = [/\/src\/nodes\//, /\/src\/materials\/nodes\//, /\/src\/renderers\/common\//, /\/src\/renderers\/webgpu\//, /\/examples\/jsm\/tsl\//];

/**
 * Members whose generated signature is replaced, keyed `Class.member` by the class that
 * declares them (subclasses re-declaring a `this`-returning member get the same treatment).
 * `ret` defaults to the generated return type; `emit` replaces the JS call.
 */
export const memberOverrides: Record<string, { params: string; ret?: string; emit?: string }[]> = {
    // Fable compiles an `int[]` literal to an Int32Array, which three's `Array.isArray`
    // check would take for a BufferAttribute. Copy whatever sequence arrives into an Array.
    "BufferGeometry.setIndex": [
        { params: "index: BufferAttribute" },
        { params: "index: seq<int>", emit: "$0.setIndex(Array.from($1))" },
    ],
    // `setAttribute<K extends keyof Attributes>(name: K, attribute: Attributes[K])`.
    "BufferGeometry.setAttribute": [
        { params: "name: string, attribute: BufferAttribute" },
        { params: "name: string, attribute: InterleavedBufferAttribute" },
        { params: "name: string, attribute: GLBufferAttribute" },
    ],
    // Nearly always a BufferAttribute; an interleaved one can be read through `unbox`.
    "BufferGeometry.getAttribute": [{ params: "name: string", ret: "BufferAttribute" }],
};
