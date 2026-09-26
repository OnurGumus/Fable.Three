/// Just enough of node:test and node:assert to write tests without a test framework.
module Node

open Fable.Core

[<Import("test", "node:test")>]
let test (name: string) (body: unit -> unit) : unit = jsNative

[<Import("default", "node:assert/strict")>]
let private assertModule: obj = jsNative

[<Emit("$0.equal($1, $2, $3)")>]
let private equalImpl (m: obj) (actual: obj) (expected: obj) (message: string) : unit = jsNative

[<Emit("$0.ok($1, $2)")>]
let private okImpl (m: obj) (value: bool) (message: string) : unit = jsNative

let equal (message: string) (expected: 'T) (actual: 'T) = equalImpl assertModule (box actual) (box expected) message
let ok (message: string) (value: bool) = okImpl assertModule value message
let close (message: string) (expected: float) (actual: float) =
    ok (sprintf "%s: expected %f, got %f" message expected actual) (abs (expected - actual) < 1e-9)
