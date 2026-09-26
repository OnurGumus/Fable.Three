# How the bindings are generated

`tools/generate/generate.ts` reads `@types/three` through the TypeScript compiler API. For each
entry point it walks the exports as the type checker resolves them, following `export *`,
`export type` and `export * as`. It then writes one `namespace rec` file per entry point:

| entry | namespace | file | import path |
|---|---|---|---|
| `src/Three.d.ts` | `Three` | `Three.fs` | `"three"` |
| `examples/jsm/Addons.d.ts` | `Three.Addons` | `Three.Addons.fs` | the declaring module, e.g. `"three/addons/controls/OrbitControls.js"` |

A type an export mentions but does not export itself is still bound, as a `[<Global>]` class
with no import, so the signature can name it. Exceptions are the paths listed in `opaque`
(`src/nodes`, the WebGPU renderer): the WebGL build only mentions those in passing, and they
map to `obj`.

Every rule below was checked against Fable 5 by compiling a probe and reading the JavaScript.
The tests keep them checked.

## Declarations

| TypeScript | F# | Why |
|---|---|---|
| `class` exported as a value | `[<Import("Name", "module")>] type Name = inherit Base; new (...) = { inherit Base() }` | `new`, `instanceof`, subclassing and upcasts all work. No primary constructor, so each TS overload is its own `new`. |
| `class` exported as a type only | same, with `[<Global>]` | Member access is native. Nothing is imported that the module doesn't export. |
| interface or type literal holding only properties | `[<Global>] type X = [<ParamObject; Emit("$0")>] new (?a, ?b) = { }` plus get/set members | Constructing one produces an object literal. The zero-property case emits `{}`, because a ParamObject with no arguments is `undefined`. |
| interface with methods | `[<Interface>]` with abstract members | Object expressions can implement it. |
| `const X: 0` values joined by `type T = typeof X \| typeof Y`, or a TS `enum` | F# enum | Compiles to the literal. |
| the same with string values, or a union of string literals | `[<StringEnum>]` | |
| named union of unlike types (`ColorRepresentation`) | `[<Erase; RequireQualifiedAccess>]` union with `op_Implicit` per case (plus `int` beside `float`) and `op_ErasedCast` | Any member converts implicitly. `!^` resolves with subtyping, which `op_Implicit` doesn't. Qualified cases matter: an unqualified case named `Color` would shadow the `Color` class. |
| `const X: { f: typeof f; ... }` or a namespace re-export | `[<AbstractClass; Import("X", ...)>] type X = static member f(...)` | `MathUtils.degToRad 90.` compiles to `MathUtils.degToRad(90)`. |
| other exported `const` | `[<Literal>]` in `Constants` when its type is a literal, otherwise an imported `let` in `Values` | |
| exported function | `[<Erase>] type Functions = [<Import>] static member f(...)` | Overloads and optional arguments, which a `let` can't have. |

## Types

- `number` → `float`. F# widens `int` arguments on its own.
- `T | null | undefined` → `T` for class types (`AllowNullLiteral`), or `T option` for types F#
  can't null (numbers, enums, functions). Erased unions are never wrapped in an option, because
  that would block their implicit conversions.
- A union of types → `Union<...>` (Interop.fs), a family of erased unions with the same
  conversions as the named ones. Unions made only of literals collapse to their base type. Two or
  more typed arrays collapse to `JS.TypedArray`, because F# can't tell `Uint8Array` from
  `Uint8ClampedArray`. A union member that is a DOM type with no Fable.Browser binding
  (`SVGElement`) is dropped rather than turning the whole union into `obj`.
- Tuples → F# tuples, which Fable compiles to arrays. Past four elements of one type (Matrix4's
  sixteen) they become an array.
- `{ [key: string]: T }` and `Record<string, T>` → `Record<'T>`.
- Anonymous object types → a POJO named after where it appears (`BoxGeometryParameters`).
- `XLike` interfaces → the class `X`. F# is nominal, so a Vector3 has to be accepted where
  `Vector3Like` is expected.
- Class type parameters are erased to their constraint. `Mesh`'s `Material | Material[]` erases
  to `Material`, and the array form comes back as the `materials` property and a second
  constructor. `keepGenerics` in config.ts lists the few kept as F# generics. They are the ones
  whose subclasses fix the type and whose methods take it inside a callback, where erasing it
  would produce an ambiguous overload.
- Callback types drop trailing optional parameters, so `fun time -> ...` fits
  `(time, frame?) => void`, and they return `unit` where TS says `any`.

## Members

- **Parameter bags.** A constructor or method whose single argument is a POJO gets a
  `[<ParamObject>]` overload taking the POJO's properties as named arguments. The plain overload
  requires its argument, so a call with no arguments is never ambiguous. @types/three spells a
  parameter bag as
  `interface XParameters extends Partial<MapColorPropertiesToColorRepresentations<XProperties>> {}`.
  The generator unwraps that, making every property optional and widening `Color` to
  `ColorRepresentation`, and follows the `*Properties` inheritance, so
  `MeshStandardMaterialParameters` inherits `MaterialParameters`.
- **Merged interfaces.** @types/three also declares `interface MeshStandardMaterial extends
  MeshStandardMaterialProperties {}` next to the class, and that is where `color` and
  `roughness` live. Those members are added to the class.
- **Union parameters** expand into one overload per member, up to eight overloads. The overloads
  after the first make every argument up to the union's position required, so `Mesh()` still
  picks exactly one constructor. Rest parameters typed as a union of tuples
  (`Color.set(...args: [color] | [r, g, b])`) expand the same way.
- **`this`.** Methods returning `this` are declared again on every subclass with the subclass as
  the return type. F# hides a base method when the parameters match exactly, whatever the return
  type.
- **Specialisation.** When a subclass fixes a base's type parameter
  (`DirectionalLightShadow extends LightShadow<OrthographicCamera>`), inherited *properties*
  that change type are declared again (`shadow.camera: OrthographicCamera`). A redeclared
  property hides the base property cleanly. A method with different parameter types wouldn't
  hide: it would sit beside the base's as an ambiguous overload.
- **Keeping overloads unambiguous across a hierarchy.** F# keeps a base method visible next to a
  subclass's unless the two signatures are identical, including which arguments are optional.
  Three passes line them up:
  - *Optionality unification*: a method and the ancestor method it redeclares, with the same
    parameter types, both take the more permissive optionality (`Controls.update(delta)` and
    `OrbitControls.update(deltaTime?)`).
  - *Widening*: a method that is a prefix of an ancestor's takes on the ancestor's trailing
    optional parameters (`Camera.clone()` and `Object3D.clone(recursive?)`).
  - *Loader callbacks* named `onLoad`, `onProgress` and `onError` are always optional.
- **Hooks.** In classes, `on*` methods (`onBeforeRender`, `onBeforeCompile`) become assignable
  function-typed properties. A function-typed property that isn't a hook
  (`WebGLRenderer.compile`, which three.js assigns in its constructor) becomes a method.
- **Name clashes.** A property and a method with the same name, or a static and an instance
  member, get a suffix and an `[<Emit>]` that calls the real name.
- `memberOverrides` in config.ts replaces the signatures the TS types can't express usefully:
  `setIndex` (copies a sequence into a plain Array, since Fable's typed arrays would fail
  three.js's `Array.isArray` check), `setAttribute` and `getAttribute`.

## Checking a change

`npm test` compiles `tests/` with Fable and runs it under Node against the real three.js.
`tests/BrowserApi.fs` and `tests/Readme.fs` are never run, but they must compile: they hold the
code people write (renderer setup, loaders, controls, post-processing, picking, shaders), so
an overload that turns ambiguous breaks the build.
