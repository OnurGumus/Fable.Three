/// Every F# snippet in the README, kept compiling. Not run: it needs a browser.
/// When the README changes, change this file to match.
module Readme

open Browser
open Fable.Core.JsInterop
open Three
open Three.Addons

// Getting started: App.fs, in a function so it only runs when called.
let gettingStarted () =
    // A scene, a camera to look at it, and a renderer that draws into the page.
    let scene = Scene()
    scene.background <- Color(0xf2eee6)

    let camera = PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100)
    camera.position.z <- 3.

    let renderer = WebGLRenderer(antialias = true)
    renderer.setSize(window.innerWidth, window.innerHeight)
    document.body.appendChild(renderer.domElement) |> ignore

    // A cube, and light to see it by.
    let cube = Mesh(BoxGeometry(1, 1, 1), MeshStandardMaterial(color = 0xd4532e))
    let sun = DirectionalLight(0xffffff, 3)
    sun.position.set(1, 2, 3) |> ignore
    scene.add(cube, sun, AmbientLight(0xffffff, 0.5)) |> ignore

    // Turn the cube a little on every frame.
    renderer.setAnimationLoop(fun time ->
        cube.rotation.x <- time / 2000.
        cube.rotation.y <- time / 1000.
        renderer.render(scene, camera))

// "From JavaScript to F#" and "Things that work a little differently", in order.
let fromJavaScript (scene: Scene) (camera: Camera) (renderer: WebGLRenderer) (texture: Texture) (mesh: Mesh) (light: DirectionalLight) (sky: string[]) (vertexSource: string) (fragmentSource: string) (time: float) =
    // Creating objects
    let geometry = BoxGeometry(1, 1, 1)
    let mesh = Mesh(geometry, MeshNormalMaterial())

    // Options become named arguments
    let material = MeshStandardMaterial(color = 0xff0000, roughness = 0.5, metalness = 0.1)
    let renderer = WebGLRenderer(antialias = true, alpha = true)
    let _ = MeshStandardMaterial(color = "tomato")
    let _ = MeshStandardMaterial(color = "#ff6347")
    let _ = MeshStandardMaterial(color = Color(0xff0000))

    // Setting properties and calling methods
    mesh.position.x <- 2.
    material.transparent <- true
    mesh.position.set(1, 2, 3) |> ignore
    scene.add(mesh) |> ignore

    // Constants
    material.side <- Side.DoubleSide
    texture.wrapS <- Wrapping.RepeatWrapping
    renderer.toneMapping <- ToneMapping.ACESFilmicToneMapping
    renderer.outputColorSpace <- Constants.SRGBColorSpace

    // Addons
    let controls = OrbitControls(camera, renderer.domElement)
    controls.enableDamping <- true

    // Loading textures and models
    let crate = TextureLoader().load("crate.png")

    GLTFLoader().load("robot.glb", fun gltf -> scene.add(gltf.scene) |> ignore)

    promise {
        let! gltf = GLTFLoader().loadAsync("robot.glb")
        scene.add(gltf.scene) |> ignore
    }
    |> ignore

    // Checking what kind of object you have
    let raycaster = Raycaster()

    let highlight (pointer: Vector2) =
        raycaster.setFromCamera(pointer, camera)

        for hit in raycaster.intersectObjects(scene.children, true) do
            match hit.``object`` with
            | :? Mesh as mesh -> mesh.scale.setScalar(1.2) |> ignore
            | _ -> ()

    highlight (Vector2())
    light.shadow.camera.far <- 50.
    renderer.shadowMap.``type`` <- ShadowMapType.PCFShadowMap

    // A mesh's material
    let paint = MeshStandardMaterial(color = 0x3080ff)
    let ball = Mesh(SphereGeometry(1), paint)
    paint.roughness <- 0.2
    (ball.material :?> MeshStandardMaterial).roughness <- 0.2

    // Properties that take different kinds of value
    scene.background <- Color(0xf2eee6)
    scene.background <- crate
    scene.background <- !^ CubeTextureLoader().load(sky)

    // Values that may be missing
    if not (isNull mesh.parent) then mesh.removeFromParent() |> ignore

    // Your own data, and shader uniforms
    mesh.userData["id"] <- box 42

    let shader =
        ShaderMaterial(
            uniforms = Record.ofSeq [ "time", IUniform(value = 0.) ],
            vertexShader = vertexSource,
            fragmentShader = fragmentSource
        )

    shader.uniforms["time"].value <- time
