/// Code that needs a browser (a WebGL context, image decoding, DOM events). It is compiled
/// by Fable as part of the test project so that a binding change which breaks ordinary
/// three.js code fails the build, but nothing here is called under Node.
module BrowserApi

open Browser
open Fable.Core
open Fable.Core.JsInterop
open Three
open Three.Addons

let renderer () =
    let r = WebGLRenderer(antialias = true, alpha = false, powerPreference = "high-performance")
    r.setPixelRatio(window.devicePixelRatio)
    r.setSize(window.innerWidth, window.innerHeight)
    r.shadowMap.enabled <- true
    r.shadowMap.``type`` <- ShadowMapType.PCFShadowMap
    r.toneMapping <- ToneMapping.ACESFilmicToneMapping
    r.outputColorSpace <- Constants.SRGBColorSpace
    document.body.appendChild(r.domElement) |> ignore
    r

let onCanvas (canvas: Types.HTMLCanvasElement) = WebGLRenderer(canvas = canvas)

let cameraAndControls (renderer: WebGLRenderer) =
    let camera = PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100)
    camera.position.set(3, 2, 5) |> ignore
    let controls = OrbitControls(camera, renderer.domElement)
    controls.enableDamping <- true
    controls.target.set(0, 0.5, 0) |> ignore
    controls.addEventListener("change", fun _ -> ())
    controls.update() |> ignore
    camera, controls

let loop (renderer: WebGLRenderer) (scene: Scene) (camera: Camera) =
    let timer = Timer()
    renderer.setAnimationLoop(fun time ->
        timer.update(time) |> ignore
        let dt = timer.getDelta()
        scene.rotation.y <- scene.rotation.y + dt * 0.1
        renderer.render(scene, camera))
    renderer.setAnimationLoop(null)

let loaders (scene: Scene) =
    // A loader's callback is typed by the loader: no casts, no ambiguity with Loader.load.
    let texture = TextureLoader().load("crate.png", fun t -> t.colorSpace <- Constants.SRGBColorSpace)
    texture.wrapS <- Wrapping.RepeatWrapping
    texture.repeat.set(4, 4) |> ignore
    TextureLoader().setPath("/textures/").load("a.png") |> ignore
    let gltf = GLTFLoader()
    let draco = DRACOLoader()
    draco.setDecoderPath("/draco/") |> ignore
    gltf.setDRACOLoader(draco) |> ignore
    gltf.load("model.glb", fun g -> scene.add(g.scene) |> ignore)
    promise {
        let! model = GLTFLoader().loadAsync("model.glb")
        let mixer = AnimationMixer(model.scene)
        for clip in model.animations do
            mixer.clipAction(clip).play() |> ignore
        return mixer
    }
    |> ignore
    HDRLoader().load("studio.hdr", fun t ->
        t.mapping <- Mapping.EquirectangularReflectionMapping
        scene.environment <- t)
    |> ignore

let postprocessing (renderer: WebGLRenderer) (scene: Scene) (camera: Camera) =
    let composer = EffectComposer(renderer)
    composer.addPass(RenderPass(scene, camera))
    composer.addPass(UnrealBloomPass(Vector2(256, 256), 1.5, 0.4, 0.85))
    composer.addPass(ShaderPass(FXAAShader))
    composer.addPass(OutputPass())
    composer.render()

let lights (scene: Scene) =
    let sun = DirectionalLight(0xffffff, 3)
    sun.position.set(5, 10, 7) |> ignore
    sun.castShadow <- true
    sun.shadow.mapSize.set(2048, 2048) |> ignore
    sun.shadow.camera.far <- 50.
    scene.add(sun, HemisphereLight(0xffffff, 0x444444, 1), AmbientLight("#404040")) |> ignore
    scene.fog <- Fog(0xcccccc, 10, 50)

let picking (renderer: WebGLRenderer) (camera: Camera) (scene: Scene) =
    let raycaster = Raycaster()
    let pointer = Vector2()
    renderer.domElement.addEventListener("pointermove", fun e ->
        let e = e :?> Types.PointerEvent
        pointer.set(e.clientX / window.innerWidth * 2. - 1., -(e.clientY / window.innerHeight) * 2. + 1.) |> ignore
        raycaster.setFromCamera(pointer, camera)
        for hit in raycaster.intersectObjects(scene.children, true) do
            match hit.``object`` with
            | :? Mesh as m -> (m.material :?> MeshStandardMaterial).emissive.set(0x333333) |> ignore
            | _ -> ())

let shaders () =
    let uniforms = Record.ofSeq [ "time", IUniform(value = 0.) ]
    let material =
        ShaderMaterial(
            uniforms = uniforms,
            vertexShader = "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
            fragmentShader = "uniform float time; void main() { gl_FragColor = vec4(abs(sin(time)), 0.0, 0.0, 1.0); }"
        )
    material.uniforms["time"].value <- 1.
    material.onBeforeCompile <- fun shader _ -> shader.fragmentShader <- shader.fragmentShader.Replace("gl_FragColor", "gl_FragColor")
    material

let labels (scene: Scene) =
    let div = document.createElement("div")
    div.textContent <- "label"
    let label = CSS2DObject(div)
    label.position.set(0, 1, 0) |> ignore
    scene.add(label) |> ignore
    let labelRenderer = CSS2DRenderer()
    labelRenderer.setSize(window.innerWidth, window.innerHeight)
    labelRenderer

let lines () =
    let points = [| Vector3(-1, 0, 0); Vector3(0, 1, 0); Vector3(1, 0, 0) |]
    let geometry = BufferGeometry().setFromPoints(points)
    let line = Line(geometry, LineBasicMaterial(color = 0x0000ff))
    let curve = CatmullRomCurve3(points, true)
    let tube = Mesh(TubeGeometry(curve, 64, 0.1, 8, true), MeshPhysicalMaterial(clearcoat = 1, transmission = 0.5))
    line, tube

let dispose (scene: Scene) =
    scene.traverse(fun o ->
        match o with
        | :? Mesh as m ->
            m.geometry.dispose()
            m.material.dispose()
        | _ -> ())
