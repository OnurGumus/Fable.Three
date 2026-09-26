/// A stack of cartons on a quiet floor: hover to see which one the pointer is on, click to
/// lift it off the stack. Everything three.js does here is typed by Fable.Three.
module App

open Browser
open Browser.Types
open Three
open Three.Addons

// ---------------------------------------------------------------------------------------
// The stack, as data. Positions are the carton's footprint corner on the floor (x, z) and
// how high its base sits (y); sizes are width, height, depth. Units are metres.

type Carton = { X: float; Y: float; Z: float; W: float; H: float; D: float; Accent: bool }

let cartons =
    let c x y z w h d = { X = x; Y = y; Z = z; W = w; H = h; D = d; Accent = false }
    [ // bottom layer
      c 0.0 0.0 0.0 1.2 0.6 0.8
      c 1.2 0.0 0.0 0.8 0.6 0.8
      c 0.0 0.0 0.8 0.8 0.6 0.8
      c 0.8 0.0 0.8 1.2 0.6 0.8
      // middle layer
      c 0.0 0.6 0.0 0.8 0.5 0.8
      c 0.8 0.6 0.0 0.6 0.5 0.8
      c 1.4 0.6 0.0 0.6 0.5 0.8
      c 0.0 0.6 0.8 1.0 0.5 0.8
      c 1.0 0.6 0.8 1.0 0.5 0.8
      // top
      c 0.2 1.1 0.3 0.9 0.4 0.9
      { c 1.1 1.1 0.3 0.6 0.35 0.6 with Accent = true } ]

let paper = Color("#f2eee6")
let kraft = [| "#cdbfa8"; "#c2b39b"; "#d6cab6"; "#bba98f" |]
let vermilion = "#d4532e"

// ---------------------------------------------------------------------------------------
// Renderer, scene, camera.

let renderer = WebGLRenderer(antialias = true)
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.shadowMap.enabled <- true
renderer.shadowMap.``type`` <- ShadowMapType.PCFShadowMap
renderer.toneMapping <- ToneMapping.NeutralToneMapping
document.getElementById("stage").appendChild(renderer.domElement) |> ignore

let scene = Scene()
scene.background <- paper
scene.fog <- Fog(paper, 12, 30)

// Soft studio light from an environment map, plus one sun for the shadows.
let pmrem = PMREMGenerator(renderer)
scene.environment <- pmrem.fromScene(RoomEnvironment(), 0.04).texture
scene.environmentIntensity <- 0.55

// From the left, so the stack's shadow falls toward the camera's side of the floor.
let sun = DirectionalLight(0xffffff, 1.4)
sun.position.set(-3, 7, 5) |> ignore
sun.target.position.set(1, 0, 0.8) |> ignore
sun.castShadow <- true
sun.shadow.mapSize.set(2048, 2048) |> ignore
sun.shadow.radius <- 6.
sun.shadow.camera.left <- -4.
sun.shadow.camera.right <- 4.
sun.shadow.camera.top <- 4.
sun.shadow.camera.bottom <- -4.
scene.add(sun, sun.target) |> ignore

let floor = Mesh(PlaneGeometry(40, 40), ShadowMaterial(opacity = 0.18))
floor.rotation.x <- -System.Math.PI / 2.
floor.receiveShadow <- true
scene.add(floor) |> ignore

let camera = PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100)
camera.position.set(4.6, 3.2, 5.4) |> ignore

/// On a portrait screen, widen the vertical field of view so the stack keeps the width it
/// has at a square aspect instead of running off the sides.
let fit () =
    let aspect = window.innerWidth / window.innerHeight
    let tall = 35.
    camera.aspect <- aspect
    camera.fov <-
        if aspect >= 1. then tall
        else MathUtils.radToDeg (2. * atan (tan (MathUtils.degToRad tall / 2.) / aspect))
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)

fit ()

let controls = OrbitControls(camera, renderer.domElement)
controls.target.set(1, 0.7, 0.8) |> ignore
controls.enableDamping <- true
controls.autoRotate <- true
controls.autoRotateSpeed <- 0.4
controls.maxPolarAngle <- System.Math.PI / 2. - 0.05
controls.minDistance <- 3.
controls.maxDistance <- 16.

// ---------------------------------------------------------------------------------------
// The cartons: one rounded box each, a hair smaller than its slot so the seams show.

/// Where each carton rests, and where it is heading when lifted.
type Lift = { Mesh: Mesh; Rest: float; mutable Target: float }

let lifts =
    cartons
    |> List.mapi (fun i carton ->
        let material =
            MeshStandardMaterial(
                color = (if carton.Accent then vermilion else kraft[i % kraft.Length]),
                roughness = 0.85,
                metalness = 0
            )
        let box = Mesh(RoundedBoxGeometry(carton.W - 0.03, carton.H - 0.03, carton.D - 0.03, 3, 0.03), material)
        let rest = carton.Y + carton.H / 2.
        box.position.set(carton.X + carton.W / 2., rest, carton.Z + carton.D / 2.) |> ignore
        box.castShadow <- true
        box.receiveShadow <- true
        scene.add(box) |> ignore
        { Mesh = box; Rest = rest; Target = rest })

// ---------------------------------------------------------------------------------------
// Pointer: hover highlights, click lifts.

let raycaster = Raycaster()
let pointer = Vector2(10, 10) // off screen until the pointer moves
let mutable hovered: Lift option = None

let liftUnder () =
    raycaster.setFromCamera(pointer, camera)
    raycaster.intersectObjects(lifts |> List.map (fun l -> l.Mesh :> Object3D) |> List.toArray, false)
    |> Array.tryHead
    |> Option.bind (fun hit ->
        match hit.``object`` with
        | :? Mesh as mesh -> lifts |> List.tryFind (fun l -> obj.ReferenceEquals(l.Mesh, mesh))
        | _ -> None)

let setGlow (lift: Lift) (on: bool) =
    let material = lift.Mesh.material :?> MeshStandardMaterial
    material.emissive.setHex(if on then 0x2a2520 else 0x000000) |> ignore

renderer.domElement.addEventListener("pointermove", fun e ->
    let e = e :?> PointerEvent
    pointer.set(e.clientX / window.innerWidth * 2. - 1., -(e.clientY / window.innerHeight) * 2. + 1.) |> ignore
    let next = liftUnder ()
    if next <> hovered then
        hovered |> Option.iter (fun l -> setGlow l false)
        next |> Option.iter (fun l -> setGlow l true)
        hovered <- next
        renderer.domElement.classList.toggle("pointing", next.IsSome) |> ignore)

let mutable downAt = (0., 0.)

renderer.domElement.addEventListener("pointerdown", fun e ->
    let e = e :?> PointerEvent
    downAt <- (e.clientX, e.clientY))

renderer.domElement.addEventListener("pointerup", fun e ->
    let e = e :?> PointerEvent
    // A drag is the camera's; only a click without movement lifts.
    let dx, dy = e.clientX - fst downAt, e.clientY - snd downAt
    if dx * dx + dy * dy < 16. then
        liftUnder ()
        |> Option.iter (fun l -> l.Target <- if l.Target = l.Rest then l.Rest + 0.6 else l.Rest))

window.addEventListener("resize", fun _ -> fit ())

// ---------------------------------------------------------------------------------------
// The loop.

let timer = Timer()

renderer.setAnimationLoop(fun time ->
    let dt = timer.update(time).getDelta()
    // Ease each carton toward its target height; the same for every frame rate.
    let k = 1. - exp (-dt * 10.)
    for l in lifts do
        l.Mesh.position.y <- l.Mesh.position.y + (l.Target - l.Mesh.position.y) * k
    controls.update(dt) |> ignore
    renderer.render(scene, camera))
