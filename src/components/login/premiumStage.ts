import * as THREE from 'three';
import { smooth } from './referenceEffects';
import { loginIntroConfig as config } from './loginIntroConfig';

/** Owned studio reflections and lighting. Podium projects in CSS for level rims. */
export function createPremiumStage(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
  const room = new THREE.Scene(); room.background = new THREE.Color(0x07020e);
  const reflectionGeometry = new THREE.PlaneGeometry(1, 1);
  const softboxes: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
  function softbox(color: THREE.Color, x: number, y: number, z: number, w: number, h: number) {
    const panel = new THREE.Mesh(reflectionGeometry, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    panel.position.set(x, y, z); panel.scale.set(w, h, 1); panel.lookAt(0, 0, 0); room.add(panel); softboxes.push(panel);
  }
  softbox(new THREE.Color(2.7, 2.1, 4.1), -3, 1.8, 4, .85, 5);
  softbox(new THREE.Color(1.25, .6, 3.2), 3.2, .4, 3, .45, 4.5);
  softbox(new THREE.Color(1.6, 1.25, 2.5), .4, 4, 1.2, 4, .5);
  const pmrem = new THREE.PMREMGenerator(renderer), environment = pmrem.fromScene(room, .025);
  softboxes.forEach(p => p.material.dispose()); reflectionGeometry.dispose(); pmrem.dispose(); scene.environment = environment.texture;
  const lights = new THREE.Group(); scene.add(lights);
  const key = new THREE.DirectionalLight(0xf4ebff, 2); key.position.set(-3, 4, 5);
  const fill = new THREE.DirectionalLight(0x8660ff, .7); fill.position.set(4, -1, 3);
  const rim = new THREE.DirectionalLight(0xc2a3ff, 1.8); rim.position.set(2, 3, -3);
  lights.add(key, fill, rim, new THREE.HemisphereLight(0xd2beff, 0x100525, .3));
  return {
    update(t: number) {
      const marks = config.timeline;
      return smooth(marks.platform, marks.complete, t);
    },
    dispose() { lights.removeFromParent(); scene.environment = null; environment.dispose(); },
  };
}
