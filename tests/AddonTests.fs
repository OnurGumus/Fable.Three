module AddonTests

open Three
open Three.Addons
open Node

test "BufferGeometryUtils merges geometries" <| fun () ->
    let a = BoxGeometry(1, 1, 1)
    let b = BoxGeometry(1, 1, 1).translate(2, 0, 0)
    let merged = BufferGeometryUtils.mergeGeometries([| a; b |])
    equal "vertex count doubles" (2. * a.getAttribute("position").count) (merged.getAttribute("position").count)

test "RoundedBoxGeometry is a BoxGeometry" <| fun () ->
    let g = RoundedBoxGeometry(2, 2, 2, 4, 0.25)
    ok "subclass" ((g :> obj) :? BoxGeometry)
    g.computeBoundingBox()
    close "extent" 1. g.boundingBox.max.x

test "ConvexGeometry wraps points" <| fun () ->
    let points = [| Vector3(0, 0, 0); Vector3(1, 0, 0); Vector3(0, 1, 0); Vector3(0, 0, 1) |]
    let hull = ConvexGeometry(points)
    ok "has triangles" (hull.getAttribute("position").count >= 12.)

test "SimplexNoise is deterministic for a seeded random" <| fun () ->
    let noise = SimplexNoise()
    let v = noise.noise(0.5, 0.25)
    ok "in range" (v >= -1. && v <= 1.)

test "Lut maps a value to a color" <| fun () ->
    let lut = Lut("rainbow", 32)
    let c = lut.getColor(0.)
    ok "a Color" ((c :> obj) :? Color)

test "LineGeometry takes positions" <| fun () ->
    let g = LineGeometry()
    g.setPositions([| 0.; 0.; 0.; 1.; 1.; 1. |]) |> ignore
    ok "instanceStart exists" (not (isNull (g.getAttribute("instanceStart"))))
