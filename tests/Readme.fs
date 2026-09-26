/// The README's opening example, kept compiling. Not run: it needs a browser.
module Readme

open Browser
open Three

let start () =
    let scene = Scene()
    let camera = PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100)
    let renderer = WebGLRenderer(antialias = true)

    let cube = Mesh(BoxGeometry(1, 1, 1), MeshStandardMaterial(color = 0xd4532e, roughness = 0.4))
    scene.add(cube, DirectionalLight(0xffffff, 3), AmbientLight(0x404040)) |> ignore
    camera.position.z <- 3.

    renderer.setAnimationLoop(fun time ->
        cube.rotation.y <- time / 1000.
        renderer.render(scene, camera))

// The other README snippets.
let snippets (renderer: WebGLRenderer) (material: Material) (obj: Object3D) (scene: Scene) (texture: Texture) (cubeTexture: CubeTexture) =
    material.side <- Side.DoubleSide
    renderer.outputColorSpace <- Constants.SRGBColorSpace
    let _ = match obj with :? Mesh as m -> Some m | _ -> None
    let _ = MathUtils.degToRad 90.
    scene.background <- Color(0xf2eee6)
    scene.background <- texture
    scene.background <- Fable.Core.JsInterop.(!^) cubeTexture
    scene.traverse(fun o -> o.visible <- false)
    obj.userData["id"] <- box 42
    let _ = Record.ofSeq [ "time", IUniform(value = 0.) ]
    TextureLoader().load("a.png", fun (t: Texture) -> t.needsUpdate <- true) |> ignore
