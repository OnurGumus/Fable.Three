# Fable.Three

[![CI](https://github.com/OnurGumus/Fable.Three/actions/workflows/ci.yml/badge.svg)](https://github.com/OnurGumus/Fable.Three/actions/workflows/ci.yml)
[![NuGet](https://img.shields.io/nuget/v/Fable.Three.svg)](https://www.nuget.org/packages/Fable.Three)

[three.js](https://threejs.org) for [Fable](https://fable.io): the whole `three` module and every
`three/addons` module, as typed F# that compiles to the JavaScript you would have written by hand.

```fsharp
open Browser
open Three

let scene = Scene()
let camera = PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100)
let renderer = WebGLRenderer(antialias = true)

let cube = Mesh(BoxGeometry(1, 1, 1), MeshStandardMaterial(color = 0xd4532e, roughness = 0.4))
scene.add(cube, DirectionalLight(0xffffff, 3), AmbientLight(0x404040)) |> ignore
camera.position.z <- 3.

renderer.setAnimationLoop(fun time ->
    cube.rotation.y <- time / 1000.
    renderer.render(scene, camera))
```

compiles to

```js
const cube = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 13914926, roughness: 0.4 }));
```

**[Live demo](https://onurgumus.github.io/Fable.Three/)** · [demo source](demo/App.fs)

## What is covered

Generated from `@types/three` 0.186.0 for three.js r186:

- **`three`**: 600 types and about 6,900 members: every class, material, geometry, light, loader,
  helper, curve and math type, plus the WebGL renderer, WebXR and animation. Every one of the 444
  names the module exports is bound.
- **`three/addons`**: all 271 modules that `three/addons` exports, with 628 types and about 5,300
  members. That covers controls, GLTF/DRACO/KTX2/HDR and the other loaders, post-processing,
  CSS2D/CSS3D, lines, exporters, geometries, physics helpers, shaders and utilities. Each class
  is imported from its own module, so bundles only pull in what you use.
- XML docs from three.js's own documentation, shown in the editor's tooltips.
  `[<Obsolete>]` marks what three.js has deprecated.

The WebGPU renderer and TSL (`three/webgpu`, `three/tsl`) are not bound yet. Members that only
exist for them, such as the `colorNode` and `lightsNode` properties @types/three declares on every
material, are left out rather than bound as `obj`.

## Install

```sh
dotnet add package Fable.Three
npm install three@0.186
```

With [Femto](https://github.com/Zaid-Ajaj/Femto), `dotnet femto` installs the matching three.js for you.

The package works with Fable 4 and 5 (it needs Fable.Core 4.3 or later).

## How three.js looks in F#

| three.js | F# |
|---|---|
| `new Mesh(geometry, material)` | `Mesh(geometry, material)` |
| `new MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 })` | `MeshStandardMaterial(color = 0xff0000, roughness = 0.5)` |
| `new WebGLRenderer({ antialias: true })` | `WebGLRenderer(antialias = true)` |
| `material.side = THREE.DoubleSide` | `material.side <- Side.DoubleSide` |
| `renderer.outputColorSpace = THREE.SRGBColorSpace` | `renderer.outputColorSpace <- Constants.SRGBColorSpace` |
| `obj instanceof THREE.Mesh` | `match obj with :? Mesh as m -> ...` |
| `THREE.MathUtils.degToRad(90)` | `MathUtils.degToRad 90.` |
| `import { OrbitControls } from "three/addons/controls/OrbitControls.js"` | `open Three.Addons` then `OrbitControls(camera, renderer.domElement)` |

The rules behind the table:

- **Classes are F# classes.** `new`, `instanceof` and subclassing all work. `mesh.clone()` is a
  `Mesh` and `scene.add(x)` is a `Scene`: methods that return `this` in three.js return the
  subclass. None of the classes are generic, so `:? Mesh` just works. The exceptions are
  `Loader<'TData, 'TUrl>` and `Curve<'TVector>`, whose subclasses fix the type:
  `TextureLoader().load(url, fun texture -> ...)` hands you a `Texture`.
- **Option objects are named arguments.** Every constructor that takes a parameters object also
  accepts its properties as optional named arguments, which compile to an object literal. The
  parameters types (`MeshStandardMaterialParameters(...)`) exist too, for building one up in
  pieces. A colour argument takes a `Color`, a hex `int` or a CSS string.
- **Constants are enums.** `Side.DoubleSide`, `Wrapping.RepeatWrapping`, `ToneMapping.NeutralToneMapping`
  and the rest compile to the literal number. String constants such as `ColorSpace.SRGBColorSpace`
  compile to the string. Where three.js types a property as a plain number or string, use the
  same name from `Constants`, a module of F# literals.
- **Numbers are `float`.** F# widens an `int` argument to `float`, so you can write
  `BoxGeometry(1, 1, 1)`.
- **Unions of types** become F# overloads where a method takes them. For example, `Mesh` has
  constructors for one material and for an array of materials, and `mesh.materials` reads the
  array form. Properties with a union type accept any member directly:
  `scene.background <- Color(0xf2eee6)` and `scene.background <- texture` both work. A subclass
  of a member needs `!^` from `Fable.Core.JsInterop`: `scene.background <- !^ cubeTexture`.
- **Nullable values** are `option` where F# needs it (`float option`, callbacks). Classes accept
  `null` directly.
- **Callbacks are F# functions.** A callback declared to return `any` returns `unit`, so
  `scene.traverse(fun o -> o.visible <- false)` compiles. Hooks such as `onBeforeRender` and
  `onBeforeCompile` are properties you assign.
- **String-keyed objects** (`userData`, `uniforms`) are `Record<'T>`:
  `mesh.userData["id"] <- box 42`, `Record.ofSeq ["time", IUniform(value = 0.)]`.

### Two things to know

- Fable compiles `int[]`/`float[]` literals to typed arrays. Most three.js APIs accept them, and
  `BufferGeometry.setIndex` takes any `seq<int>` and copies it into the plain array three.js
  expects.
- `geometry.getAttribute(name)` is typed as a `BufferAttribute`, which covers nearly every case.
  An interleaved or GL attribute is still there at runtime: reach it with `unbox`.

## Working on the bindings

The bindings are generated. Don't edit `Three.fs` or `Three.Addons.fs`: change the generator or
its config.

```sh
npm ci && dotnet tool restore
npm run generate    # tools/generate → src/Fable.Three/Three.fs, Three.Addons.fs
npm run build       # the library
npm test            # Fable-compiles tests/ and runs them with node:test against three.js
npm run demo        # the demo with hot reload, http://localhost:5173
```

To move to a new three.js release, bump `three` and `@types/three` in `package.json`, run
`npm run generate`, then build and test. Set `<Version>` in the `.fsproj` to the new three.js
version. `tools/generate/config.ts` holds the manual decisions (which generics to keep, which
signatures to override), and [docs/DESIGN.md](docs/DESIGN.md) explains how the generator makes
the rest.

```
src/Fable.Three/     Interop.fs (hand-written) + the generated Three.fs and Three.Addons.fs
tools/generate/      the generator: TypeScript compiler API, run with Node 24
tests/               runtime tests under Node, plus BrowserApi.fs: browser code that must compile
demo/                the demo page
```

## License

MIT. three.js is © its authors, MIT licensed; the doc comments are taken from `@types/three` (MIT).
