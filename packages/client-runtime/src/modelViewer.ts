import {
  AnimationMixer,
  Box3,
  BufferGeometry,
  Clock,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group,
  HemisphereLight,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  Sphere,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
  type AnimationClip,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createRenderScheduler } from "./device/renderScheduler.ts";
import type { ModelPreviewFormat } from "@t3tools/shared/filePreview";

export interface LoadedModel {
  readonly root: Object3D;
  readonly animations: ReadonlyArray<AnimationClip>;
  /** CAD and print formats are authored Z-up. */
  readonly zUp: boolean;
}

export interface ModelStats {
  readonly triangles: number;
  readonly vertices: number;
  readonly animations: number;
}

export interface ModelViewer {
  readonly stats: ModelStats;
  readonly resize: (width: number, height: number, pixelRatio: number) => void;
  readonly resetView: () => void;
  readonly setWireframe: (enabled: boolean) => void;
  readonly setGridVisible: (visible: boolean) => void;
  readonly setZUp: (zUp: boolean) => void;
  readonly setAnimationPlaying: (playing: boolean) => void;
  readonly dispose: () => void;
}

const MODEL_COLOR = 0xb4b8c0;

function standardMaterial(geometry: BufferGeometry) {
  return new MeshStandardMaterial({
    color: geometry.hasAttribute("color") ? 0xffffff : MODEL_COLOR,
    vertexColors: geometry.hasAttribute("color"),
    roughness: 0.55,
    metalness: 0.05,
    side: DoubleSide,
  });
}

function meshFromGeometry(geometry: BufferGeometry, points: boolean): Object3D {
  if (points) {
    return new Points(
      geometry,
      new PointsMaterial({
        size: 2,
        sizeAttenuation: false,
        color: geometry.hasAttribute("color") ? 0xffffff : MODEL_COLOR,
        vertexColors: geometry.hasAttribute("color"),
      }),
    );
  }
  if (!geometry.hasAttribute("normal")) geometry.computeVertexNormals();
  return new Mesh(geometry, standardMaterial(geometry));
}

/**
 * Parses model bytes. `dependencyUrls` maps each relative URI the file names to a fetchable URL;
 * any other relative URL resolves to nothing, so a model never requests paths on the app origin.
 */
export async function loadModel(input: {
  readonly bytes: ArrayBuffer;
  readonly format: ModelPreviewFormat;
  readonly dependencyUrls?: ReadonlyMap<string, string>;
}): Promise<LoadedModel> {
  const manager = new LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/i.test(url)) return url;
    return input.dependencyUrls?.get(url) ?? "data:,";
  });
  switch (input.format) {
    case "glb":
    case "gltf": {
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/libs/meshopt_decoder.module.js"),
      ]);
      const loader = new GLTFLoader(manager).setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.parseAsync(input.bytes, "");
      return { root: gltf.scene, animations: gltf.animations, zUp: false };
    }
    case "obj": {
      const { OBJLoader } = await import("three/addons/loaders/OBJLoader.js");
      const root = new OBJLoader(manager).parse(new TextDecoder().decode(input.bytes));
      root.traverse((object) => {
        if (object instanceof Mesh && !object.geometry.hasAttribute("color"))
          object.material = standardMaterial(object.geometry);
      });
      return { root, animations: [], zUp: false };
    }
    case "stl": {
      const { STLLoader } = await import("three/addons/loaders/STLLoader.js");
      const geometry = new STLLoader(manager).parse(input.bytes);
      // Exporters often write zeroed facet normals, which render black.
      geometry.computeVertexNormals();
      return { root: meshFromGeometry(geometry, false), animations: [], zUp: true };
    }
    case "ply": {
      const { PLYLoader } = await import("three/addons/loaders/PLYLoader.js");
      const geometry = new PLYLoader(manager).parse(input.bytes);
      return {
        root: meshFromGeometry(geometry, geometry.index === null),
        animations: [],
        zUp: false,
      };
    }
    case "fbx": {
      const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
      const root = new FBXLoader(manager).parse(input.bytes, "");
      return { root, animations: root.animations, zUp: false };
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/addons/loaders/3MFLoader.js");
      return { root: new ThreeMFLoader(manager).parse(input.bytes), animations: [], zUp: true };
    }
  }
}

export function disposeModel(root: Object3D) {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    geometries.add(object.geometry);
    const objectMaterials: ReadonlyArray<Material> = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of objectMaterials) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) {
    texture.dispose();
    if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap)
      texture.image.close();
  }
}

function modelStats(root: Object3D, animations: number): ModelStats {
  let triangles = 0;
  let vertices = 0;
  root.traverse((object) => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    const position = object.geometry.getAttribute("position");
    if (!position) return;
    vertices += position.count;
    if (object instanceof Mesh)
      triangles += Math.floor((object.geometry.index?.count ?? position.count) / 3);
  });
  return { triangles, vertices, animations };
}

/**
 * Takes ownership of the model. Renders only when the view changes or an animation plays.
 * Throws when the browser cannot create a WebGL context.
 */
export function createModelViewer(options: {
  readonly canvas: HTMLCanvasElement;
  readonly model: LoadedModel;
}): ModelViewer {
  const renderer = new WebGLRenderer({
    canvas: options.canvas,
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environment = environment;
  scene.add(new HemisphereLight(0xffffff, 0x444444, 0.6));
  const sun = new DirectionalLight(0xffffff, 1.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const pivot = new Group();
  pivot.add(options.model.root);
  scene.add(pivot);
  const grid = new GridHelper(1, 20, new Color(0x888888), new Color(0x888888));
  const gridMaterials: ReadonlyArray<Material> = Array.isArray(grid.material)
    ? grid.material
    : [grid.material];
  for (const material of gridMaterials) {
    material.transparent = true;
    material.opacity = 0.25;
    material.depthWrite = false;
  }
  scene.add(grid);

  const camera = new PerspectiveCamera(45, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, options.canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  const home = { position: new Vector3(), target: new Vector3() };

  const mixer = options.model.animations.length > 0 ? new AnimationMixer(options.model.root) : null;
  const clip = options.model.animations[0];
  if (mixer && clip) {
    mixer.clipAction(clip).play();
    mixer.update(0);
  }
  const clock = new Clock(false);
  let playing = false;

  const scheduler = createRenderScheduler(() => {
    if (playing && mixer) {
      mixer.update(clock.getDelta());
      scheduler.invalidate();
    }
    // Damping emits `change` until the camera settles, which schedules the next frame.
    controls.update();
    renderer.render(scene, camera);
  });
  controls.addEventListener("change", scheduler.invalidate);

  let zUp = options.model.zUp;
  const frame = () => {
    pivot.rotation.x = zUp ? -Math.PI / 2 : 0;
    pivot.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(pivot);
    if (bounds.isEmpty()) return;
    const sphere = bounds.getBoundingSphere(new Sphere());
    const radius = Math.max(sphere.radius, 1e-6);
    const size = bounds.getSize(new Vector3());
    const span = Math.max(size.x, size.z) * 2 || radius * 2;
    grid.scale.setScalar(span);
    grid.position.set(sphere.center.x, bounds.min.y, sphere.center.z);
    const verticalHalfFov = (camera.fov * Math.PI) / 360;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(verticalHalfFov, horizontalHalfFov))) * 1.05;
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.05;
    controls.maxDistance = distance * 20;
    home.target.copy(sphere.center);
    home.position
      .copy(sphere.center)
      .add(new Vector3(1, 0.7, 1.2).normalize().multiplyScalar(distance));
  };
  // Until the user moves the camera, a resize reframes the model for the new aspect ratio.
  let moved = false;
  controls.addEventListener("start", () => {
    moved = true;
  });
  const resetView = () => {
    moved = false;
    frame();
    camera.position.copy(home.position);
    controls.target.copy(home.target);
    controls.update();
    scheduler.invalidate();
  };
  resetView();

  return {
    stats: modelStats(options.model.root, options.model.animations.length),
    resize(width, height, pixelRatio) {
      if (width <= 0 || height <= 0) return;
      renderer.setPixelRatio(Math.min(pixelRatio, 2));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (moved) scheduler.invalidate();
      else resetView();
    },
    resetView,
    setWireframe(enabled) {
      options.model.root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const materials: ReadonlyArray<Material> = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of materials) {
          if ("wireframe" in material) material.wireframe = enabled;
        }
      });
      scheduler.invalidate();
    },
    setGridVisible(visible) {
      grid.visible = visible;
      scheduler.invalidate();
    },
    setZUp(next) {
      if (zUp === next) return;
      zUp = next;
      resetView();
    },
    setAnimationPlaying(next) {
      if (!mixer || playing === next) return;
      playing = next;
      if (next) clock.start();
      else clock.stop();
      scheduler.invalidate();
    },
    dispose() {
      scheduler.dispose();
      controls.removeEventListener("change", scheduler.invalidate);
      controls.dispose();
      mixer?.stopAllAction();
      disposeModel(options.model.root);
      grid.dispose();
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
