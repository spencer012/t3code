import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  createModelViewer,
  disposeModel,
  loadModel,
  type LoadedModel,
  type ModelViewer,
} from "@t3tools/client-runtime/model-viewer";
import { gltfExternalUris, modelPreviewFormat } from "@t3tools/shared/filePreview";
import { msg, useGT } from "gt-react";
import { Axis3dIcon, BoxIcon, Grid3x3Icon, PauseIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { m } from "~/i18n/messages";
import { observeResize } from "~/lib/observeResize";

import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

const MAX_MODEL_BYTES = 256 * 1024 * 1024;

function parseJson(bytes: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function readModel(
  src: string,
  name: string,
  resolveDependency: ((uri: string) => Promise<string | null>) | undefined,
  signal: AbortSignal,
): Promise<LoadedModel> {
  const format = modelPreviewFormat({ name });
  if (!format) throw new Error(m(msg("This 3D format can't be previewed.")));
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error(m(msg("The model could not be loaded.")));
  if (Number(response.headers.get("content-length")) > MAX_MODEL_BYTES)
    throw new Error(m(msg("3D previews are limited to 256 MB.")));
  const bytes = await response.arrayBuffer();
  const dependencyUrls = new Map<string, string>();
  const uris = format === "gltf" ? gltfExternalUris(parseJson(bytes)) : [];
  if (uris.length > 0 && !resolveDependency)
    throw new Error(
      m(
        msg(
          "This glTF loads files stored beside it. Open it from the workspace, or export it as .glb.",
        ),
      ),
    );
  await Promise.all(
    uris.map(async (uri) => {
      const url = await resolveDependency?.(uri).catch(() => null);
      if (!url)
        throw new Error(m(msg("Could not load {file}, which this model needs.", { file: uri })));
      dependencyUrls.set(uri, url);
    }),
  );
  return loadModel({ bytes, format, dependencyUrls });
}

/** Pass `resolveDependency` when the model's folder can be read, so a glTF's buffers and textures load. */
export default function ModelFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly resolveDependency?: ((uri: string) => Promise<string | null>) | undefined;
}) {
  const gt = useGT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<ModelViewer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [wireframe, setWireframe] = useState(false);
  const [grid, setGrid] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [zUp, setZUp] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the model fetch and the WebGL viewer, disposing both when the file changes or unmounts.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // A disposed renderer loses its context for good, so each load draws on a new canvas.
    const canvas = document.createElement("canvas");
    canvas.className = "absolute inset-0 block size-full outline-none";
    container.append(canvas);
    const controller = new AbortController();
    let created: ModelViewer | null = null;
    setViewer(null);
    setError(null);
    setWireframe(false);
    setPlaying(false);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The resolver is read once per load; a new file remounts this viewer.
    void readModel(props.src, props.name, props.resolveDependency, controller.signal)
      .then((model) => {
        if (controller.signal.aborted) return disposeModel(model.root);
        try {
          created = createModelViewer({ canvas, model });
        } catch {
          disposeModel(model.root);
          throw new Error(m(msg("3D previews need WebGL, which is unavailable in this browser.")));
        }
        if (created.stats.vertices === 0) throw new Error(m(msg("This model has no geometry.")));
        setZUp(model.zUp);
        setViewer(created);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(thrownErrorMessage(cause, m) ?? m(msg("Unable to load this 3D model.")));
      });
    return () => {
      controller.abort();
      created?.dispose();
      canvas.remove();
    };
  }, [props.src, props.name, attempt]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the WebGL drawing buffer sized to its container.
  useEffect(() => {
    const container = containerRef.current;
    if (!viewer || !container) return;
    return observeResize(container, () => {
      viewer.resize(container.clientWidth, container.clientHeight, window.devicePixelRatio);
    });
  }, [viewer]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
      <div ref={containerRef} className="absolute inset-0" />
      {error ? (
        <div className="absolute inset-0 flex bg-background">
          <FileSurfaceFailure message={error} onRetry={() => setAttempt((value) => value + 1)} />
        </div>
      ) : !viewer ? (
        <div className="pointer-events-none absolute inset-0 flex">
          <FileSurfaceLoading />
        </div>
      ) : (
        <>
          <div className="absolute top-2 right-2 flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/90 p-0.5 shadow-xs">
            {viewer.stats.animations > 0 ? (
              <FileSurfaceAction
                label={playing ? gt("Pause animation") : gt("Play animation")}
                onPress={() => {
                  viewer.setAnimationPlaying(!playing);
                  setPlaying(!playing);
                }}
              >
                {playing ? <PauseIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
              </FileSurfaceAction>
            ) : null}
            <FileSurfaceAction
              label={gt("Wireframe")}
              pressed={wireframe}
              onPress={() => {
                viewer.setWireframe(!wireframe);
                setWireframe(!wireframe);
              }}
            >
              <BoxIcon className="size-3.5" />
            </FileSurfaceAction>
            <FileSurfaceAction
              label={gt("Grid")}
              pressed={grid}
              onPress={() => {
                viewer.setGridVisible(!grid);
                setGrid(!grid);
              }}
            >
              <Grid3x3Icon className="size-3.5" />
            </FileSurfaceAction>
            <FileSurfaceAction
              label={zUp ? gt("Z axis up") : gt("Y axis up")}
              pressed={zUp}
              onPress={() => {
                viewer.setZUp(!zUp);
                setZUp(!zUp);
              }}
            >
              <Axis3dIcon className="size-3.5" />
            </FileSurfaceAction>
            <FileSurfaceAction label={gt("Reset view")} onPress={viewer.resetView}>
              <RotateCcwIcon className="size-3.5" />
            </FileSurfaceAction>
          </div>
          <p className="pointer-events-none absolute bottom-2 left-3 text-2xs text-muted-foreground tabular-nums">
            {viewer.stats.triangles > 0
              ? gt("{triangles} triangles · {vertices} vertices", {
                  triangles: viewer.stats.triangles.toLocaleString(),
                  vertices: viewer.stats.vertices.toLocaleString(),
                })
              : gt("{points} points", { points: viewer.stats.vertices.toLocaleString() })}
          </p>
        </>
      )}
    </div>
  );
}
