module MathTests

open Three
open Node

test "Vector3 arithmetic mutates in place and chains" <| fun () ->
    let v = Vector3(1, 2, 3)
    let r = v.add(Vector3(1, 1, 1)).multiplyScalar(2)
    equal "chained add/multiplyScalar returns the same instance" true (obj.ReferenceEquals(v, r))
    equal "x" 4. v.x
    equal "y" 6. v.y
    equal "z" 8. v.z
    close "length" (sqrt (16. + 36. + 64.)) (v.length ())

test "Vector3 defaults to the origin" <| fun () ->
    let v = Vector3()
    equal "x" 0. v.x
    equal "isVector3" true v.isVector3

test "Vector3.set takes an optional z" <| fun () ->
    let v = Vector3(9, 9, 9)
    v.set(1, 2) |> ignore
    equal "x" 1. v.x
    equal "y" 2. v.y

test "Matrix4 and Quaternion rotate a vector" <| fun () ->
    let q = Quaternion().setFromAxisAngle(Vector3(0, 1, 0), MathUtils.degToRad 90.)
    let v = Vector3(1, 0, 0).applyQuaternion(q)
    close "x after quaternion" 0. v.x
    close "z after quaternion" -1. v.z
    let m = Matrix4().makeRotationY(MathUtils.degToRad 90.)
    let w = Vector3(1, 0, 0).applyMatrix4(m)
    close "z after matrix" -1. w.z

test "MathUtils is a static class over the JS namespace" <| fun () ->
    close "degToRad" System.Math.PI (MathUtils.degToRad 180.)
    equal "clamp" 1. (MathUtils.clamp(5, 0, 1))
    equal "generateUUID length" 36 (MathUtils.generateUUID().Length)
    close "DEG2RAD" (System.Math.PI / 180.) MathUtils.DEG2RAD

test "Color accepts a hex int, a CSS string, a Color or RGB floats" <| fun () ->
    equal "hex" (float 0xff0000) (Color(0xff0000).getHex())
    equal "css" (float 0x00ff00) (Color("#00ff00").getHex())
    equal "copy" (float 0x0000ff) (Color(Color(0x0000ff)).getHex())
    equal "rgb" (float 0xffffff) (Color(1, 1, 1).getHex())
    equal "default" (float 0xffffff) (Color().getHex())

test "Color.set is overloaded from its tuple-typed rest argument" <| fun () ->
    let c = Color()
    c.set(0x123456) |> ignore
    equal "set(hex)" (float 0x123456) (c.getHex())
    c.set(0, 0, 1) |> ignore
    equal "set(r, g, b)" (float 0x0000ff) (c.getHex())

test "Box3 and Sphere measure geometry" <| fun () ->
    let box = Box3(Vector3(-1, -2, -3), Vector3(1, 2, 3))
    let size = box.getSize(Vector3())
    equal "size.y" 4. size.y
    equal "contains origin" true (box.containsPoint(Vector3()))
    let sphere = box.getBoundingSphere(Sphere())
    close "radius" (sqrt 14.) sphere.radius

test "Euler order is a string enum" <| fun () ->
    let e = Euler(0, 0, 0, EulerOrder.YXZ)
    equal "order" "YXZ" (unbox<string> e.order)

test "Constants carry the JS values without importing them" <| fun () ->
    equal "DoubleSide" 2 Constants.DoubleSide
    equal "SRGBColorSpace" "srgb" Constants.SRGBColorSpace
    equal "enum case" 2 (int Side.DoubleSide)
    ok "REVISION" (REVISION.Length > 0)
