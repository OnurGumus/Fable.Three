namespace Three

open Fable.Core
open Fable.Core.JsInterop

// Types the generated bindings are written against. They erase to plain JS values.

/// A value that is one of two types, erased to that value at runtime.
///
/// Pass either type directly: `Union<Color, Texture>` accepts a Color or a Texture through an
/// implicit conversion. A subclass needs `!^` (from Fable.Core.JsInterop), which resolves
/// against the conversions with subtyping: `scene.background <- !^ cubeTexture`.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B> =
    | Case1 of 'A
    | Case2 of 'B
    static member inline op_Implicit(x: 'A) : Union<'A, 'B> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B> = Case2 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B> = Case2 x

/// A value that is one of three types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C> = Case3 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C> = Case3 x

/// A value that is one of four types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C, 'D> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    | Case4 of 'D
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C, 'D> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C, 'D> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C, 'D> = Case3 x
    static member inline op_Implicit(x: 'D) : Union<'A, 'B, 'C, 'D> = Case4 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C, 'D> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C, 'D> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C, 'D> = Case3 x
    static member inline op_ErasedCast(x: 'D) : Union<'A, 'B, 'C, 'D> = Case4 x

/// A value that is one of five types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C, 'D, 'E> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    | Case4 of 'D
    | Case5 of 'E
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C, 'D, 'E> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C, 'D, 'E> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C, 'D, 'E> = Case3 x
    static member inline op_Implicit(x: 'D) : Union<'A, 'B, 'C, 'D, 'E> = Case4 x
    static member inline op_Implicit(x: 'E) : Union<'A, 'B, 'C, 'D, 'E> = Case5 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C, 'D, 'E> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C, 'D, 'E> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C, 'D, 'E> = Case3 x
    static member inline op_ErasedCast(x: 'D) : Union<'A, 'B, 'C, 'D, 'E> = Case4 x
    static member inline op_ErasedCast(x: 'E) : Union<'A, 'B, 'C, 'D, 'E> = Case5 x

/// A value that is one of six types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C, 'D, 'E, 'F> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    | Case4 of 'D
    | Case5 of 'E
    | Case6 of 'F
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case3 x
    static member inline op_Implicit(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case4 x
    static member inline op_Implicit(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case5 x
    static member inline op_Implicit(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case6 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case3 x
    static member inline op_ErasedCast(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case4 x
    static member inline op_ErasedCast(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case5 x
    static member inline op_ErasedCast(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F> = Case6 x

/// A value that is one of seven types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    | Case4 of 'D
    | Case5 of 'E
    | Case6 of 'F
    | Case7 of 'G
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case3 x
    static member inline op_Implicit(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case4 x
    static member inline op_Implicit(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case5 x
    static member inline op_Implicit(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case6 x
    static member inline op_Implicit(x: 'G) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case7 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case3 x
    static member inline op_ErasedCast(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case4 x
    static member inline op_ErasedCast(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case5 x
    static member inline op_ErasedCast(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case6 x
    static member inline op_ErasedCast(x: 'G) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G> = Case7 x

/// A value that is one of eight types, erased to that value at runtime. See Union<'A, 'B>.
[<Erase; RequireQualifiedAccess>]
type Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> =
    | Case1 of 'A
    | Case2 of 'B
    | Case3 of 'C
    | Case4 of 'D
    | Case5 of 'E
    | Case6 of 'F
    | Case7 of 'G
    | Case8 of 'H
    static member inline op_Implicit(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case1 x
    static member inline op_Implicit(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case2 x
    static member inline op_Implicit(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case3 x
    static member inline op_Implicit(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case4 x
    static member inline op_Implicit(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case5 x
    static member inline op_Implicit(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case6 x
    static member inline op_Implicit(x: 'G) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case7 x
    static member inline op_Implicit(x: 'H) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case8 x
    static member inline op_ErasedCast(x: 'A) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case1 x
    static member inline op_ErasedCast(x: 'B) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case2 x
    static member inline op_ErasedCast(x: 'C) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case3 x
    static member inline op_ErasedCast(x: 'D) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case4 x
    static member inline op_ErasedCast(x: 'E) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case5 x
    static member inline op_ErasedCast(x: 'F) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case6 x
    static member inline op_ErasedCast(x: 'G) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case7 x
    static member inline op_ErasedCast(x: 'H) : Union<'A, 'B, 'C, 'D, 'E, 'F, 'G, 'H> = Case8 x

/// A plain JS object used as a string-keyed dictionary (TypeScript's `Record<string, T>`
/// and `{ [key: string]: T }`), such as a ShaderMaterial's `uniforms`.
[<AllowNullLiteral; Global>]
type Record<'T> =
    /// An empty object.
    [<Emit("{}")>]
    new() = { }

    [<EmitIndexer>]
    member _.Item
        with get (key: string): 'T = jsNative
        and set (key: string) (_: 'T) = jsNative

    /// An object holding the given key/value pairs.
    static member inline ofSeq(pairs: seq<string * 'T>) : Record<'T> =
        unbox (createObj (pairs |> Seq.map (fun (k, v) -> k, box v)))
