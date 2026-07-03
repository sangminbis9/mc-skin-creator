/**
 * 3D 뷰어/페인터 공용 three.js 장면 셋업.
 * 렌더는 on-demand (컨트롤 변경·텍스처 갱신 시에만).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { SkinModel } from "./SkinModel";

export type ViewDirection = "front" | "back" | "left" | "right";

const CAMERA_RADIUS = 48;
const CAMERA_HEIGHT = 2;

export interface SkinScene {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: SkinModel;
  render: () => void;
  setView: (view: ViewDirection) => void;
  resize: () => void;
  dispose: () => void;
}

export function createSkinScene(
  container: HTMLElement,
  skinCanvas: HTMLCanvasElement,
): SkinScene {
  const scene = new THREE.Scene();
  scene.background = null;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_RADIUS);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true, // 공유용 캡처에 필요
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  renderer.domElement.style.touchAction = "none";

  const model = new SkinModel(skinCanvas);
  scene.add(model.group);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.minDistance = 28;
  controls.maxDistance = 90;
  controls.target.set(0, 0, 0);

  const render = () => {
    renderer.render(scene, camera);
  };

  controls.addEventListener("change", render);

  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  };

  const setView = (view: ViewDirection) => {
    const distance = camera.position.length();
    const angles: Record<ViewDirection, number> = {
      front: 0,
      back: Math.PI,
      // 캐릭터의 왼쪽/오른쪽이 보이도록
      left: -Math.PI / 2,
      right: Math.PI / 2,
    };
    const a = angles[view];
    camera.position.set(
      Math.sin(a) * distance,
      CAMERA_HEIGHT,
      Math.cos(a) * distance,
    );
    controls.update();
    render();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const dispose = () => {
    observer.disconnect();
    controls.removeEventListener("change", render);
    controls.dispose();
    model.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };

  return { renderer, camera, controls, model, render, setView, resize, dispose };
}
