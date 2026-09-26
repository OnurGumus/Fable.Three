module SceneTests

open Fable.Core.JsInterop
open Three
open Node

test "Materials take their parameters as named arguments" <| fun () ->
    let m = MeshStandardMaterial(color = 0xff8800, roughness = 0.25, side = Side.DoubleSide, transparent = true)
    equal "color" (float 0xff8800) (m.color.getHex())
    equal "roughness" 0.25 m.roughness
    equal "side" Side.DoubleSide m.side
    equal "transparent" true m.transparent

test "Materials still take a prebuilt parameters object" <| fun () ->
    let p = MeshBasicMaterialParameters(color = "#00ff00", opacity = 0.5)
    p.transparent <- true
    let m = MeshBasicMaterial(p)
    equal "color" (float 0x00ff00) (m.color.getHex())
    equal "opacity" 0.5 m.opacity
    equal "transparent" true m.transparent

test "A material built with no arguments has three's defaults" <| fun () ->
    let m = MeshStandardMaterial()
    equal "roughness" 1. m.roughness
    equal "side" Side.FrontSide m.side

test "Scene graph: add returns the parent typed as itself" <| fun () ->
    let scene = Scene()
    let group = Group()
    let mesh = Mesh(BoxGeometry(1, 1, 1), MeshNormalMaterial())
    let returned: Scene = scene.add(group)
    group.add(mesh).add(Object3D()) |> ignore
    equal "add returns the scene" true (obj.ReferenceEquals(scene, returned))
    equal "group children" 2 group.children.Length
    equal "mesh parent" true (obj.ReferenceEquals(mesh.parent, group))

test "Type tests compile to instanceof" <| fun () ->
    let scene = Scene()
    scene.add(Mesh(), Mesh(), Group(), PointLight(0xffffff)) |> ignore
    let meshes = scene.children |> Array.filter (fun o -> o :? Mesh)
    let lights = scene.children |> Array.choose (function :? Light as l -> Some l | _ -> None)
    equal "meshes" 2 meshes.Length
    equal "lights" 1 lights.Length

test "traverse takes a statement lambda" <| fun () ->
    let scene = Scene()
    scene.add(Mesh(), Group().add(Mesh())) |> ignore
    let mutable count = 0
    scene.traverse(fun o -> if o :? Mesh then count <- count + 1)
    equal "meshes reached" 2 count

test "clone returns the subclass" <| fun () ->
    let mesh = Mesh(BoxGeometry(), MeshBasicMaterial(color = 0x123456))
    mesh.name <- "original"
    let copy: Mesh = mesh.clone()
    equal "name" "original" copy.name
    equal "shares geometry" true (obj.ReferenceEquals(copy.geometry, mesh.geometry))

test "A multi-material mesh" <| fun () ->
    let mats: Material[] = [| MeshBasicMaterial(); MeshBasicMaterial() |]
    let mesh = Mesh(BoxGeometry(), mats)
    equal "materials" 2 mesh.materials.Length
    mesh.materials <- [| MeshBasicMaterial() |]
    equal "reassigned" 1 mesh.materials.Length

test "Scene.background takes a Color or a Texture without a cast" <| fun () ->
    let scene = Scene()
    scene.background <- Color(0x202020)
    ok "is a Color" (scene.background :> obj :? Color)
    scene.background <- Texture()
    ok "is a Texture" (scene.background :> obj :? Texture)
    scene.background <- !^ (CanvasTexture(null))
    ok "subclass through !^" (scene.background :> obj :? CanvasTexture)

test "Raycasting a mesh works without a renderer" <| fun () ->
    let mesh = Mesh(BoxGeometry(2, 2, 2), MeshBasicMaterial())
    mesh.position.set(0, 0, -5) |> ignore
    mesh.updateMatrixWorld()
    let ray = Raycaster(Vector3(0, 0, 0), Vector3(0, 0, -1))
    let hits = ray.intersectObject(mesh)
    equal "one hit per face crossed" true (hits.Length >= 1)
    close "distance to the near face" 4. hits[0].distance
    equal "the object hit" true (obj.ReferenceEquals(hits[0].``object``, mesh))

test "BufferGeometry built by hand, index from an F# int array" <| fun () ->
    let geo = BufferGeometry()
    let positions = Float32BufferAttribute([| 0.; 0.; 0.; 1.; 0.; 0.; 0.; 1.; 0. |], 3)
    geo.setAttribute("position", positions).setIndex([| 0; 1; 2 |]) |> ignore
    equal "position count" 3. (geo.getAttribute("position").count)
    equal "index count" 3. geo.index.count
    equal "index is a real attribute" true (geo.index.isBufferAttribute)
    geo.computeBoundingBox()
    equal "bbox max x" 1. geo.boundingBox.max.x

test "Geometry parameters are typed" <| fun () ->
    let g = BoxGeometry(2, 3, 4, 5)
    equal "width" 2. g.parameters.width
    equal "widthSegments" 5. g.parameters.widthSegments

test "Hooks are assignable properties" <| fun () ->
    let mesh = Mesh()
    let mutable called = false
    mesh.onBeforeRender <- fun _ _ _ _ _ _ -> called <- true
    mesh.onBeforeRender Unchecked.defaultof<_> null null null null null
    equal "hook ran" true called

test "userData is a string-keyed record" <| fun () ->
    let o = Object3D()
    o.userData["id"] <- box 42
    equal "id" 42 (unbox<int> o.userData["id"])

test "Event dispatch" <| fun () ->
    let o = Object3D()
    let mutable seen = ""
    o.addEventListener("ping", fun e -> seen <- e.``type``)
    o.dispatchEvent(BaseEvent(``type`` = "ping"))
    equal "listener saw the event" "ping" seen

test "InstancedMesh positions each instance" <| fun () ->
    let im = InstancedMesh(BoxGeometry(), MeshBasicMaterial(), 3)
    let m = Matrix4()
    for i in 0 .. 2 do
        im.setMatrixAt(i, m.makeTranslation(float i, 0, 0)) |> ignore
    let out = Matrix4()
    im.getMatrixAt(2, out) |> ignore
    equal "third instance x" 2. out.elements[12]
