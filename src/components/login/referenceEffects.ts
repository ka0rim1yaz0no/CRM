import * as THREE from 'three';
import { loginIntroConfig as config } from './loginIntroConfig';

export const smooth = (a: number, b: number, t: number) => THREE.MathUtils.smootherstep(t, a, b);
export function track(t: number, keys: readonly (readonly [number, number])[]) {
  for (let i = 1; i < keys.length; i++) if (t < keys[i][0]) return THREE.MathUtils.lerp(keys[i - 1][1], keys[i][1], smooth(keys[i - 1][0], keys[i][0], t));
  return keys[keys.length - 1][1];
}

/** Reference choreography: separate inward rush, light hold, impact, then outward debris. */
export function createReferenceEffects(stage: THREE.Group, rayCount: number) {
  const ownedGeometry: THREE.BufferGeometry[] = [], ownedMaterial: THREE.Material[] = [];
  const attachments: THREE.Object3D[] = [];
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 127);
    [[0, 1], [.13, .85], [.4, .13], [1, 0]].forEach(([stop, alpha]) => gradient.addColorStop(stop, `rgba(255,255,255,${alpha})`));
    context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
  }
  const glowTexture = new THREE.CanvasTexture(canvas); glowTexture.colorSpace = THREE.SRGBColorSpace;
  function glow(color: number, w: number, h: number, y: number, z: number) {
    const geometry = new THREE.PlaneGeometry(w, h);
    const material = new THREE.MeshBasicMaterial({ map: glowTexture, color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(0, y, z); stage.add(mesh);
    ownedGeometry.push(geometry); ownedMaterial.push(material); attachments.push(mesh); return mesh;
  }
  const aura = glow(0x5a13ff, 1, 1, .08, .6);
  const floor = glow(0x8430ff, 4.6, .28, -1.34, .1), floorLine = glow(0xd58cff, 3.6, .027, -1.34, .12);
  const halo = glow(0x30106a, 4, 3, .1, -.8);
  let seed = 23017;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const positions = new Float32Array(rayCount * 12), uv = new Float32Array(rayCount * 8), indices: number[] = [];
  const rays = Array.from({ length: rayCount }, (_, i) => {
    uv.set([0, -1, 0, 1, 1, -1, 1, 1], i * 8); const k = i * 4; indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    return { a: random() * 6.283, s: random(), r: 3.1 + random() * 3.4, z: (random() - .5) * .8, v: 4 + random() * 10 };
  });
  const rayGeometry = new THREE.BufferGeometry();
  rayGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  rayGeometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); rayGeometry.setIndex(indices);
  const rayMaterial = new THREE.ShaderMaterial({
    uniforms: { alpha: { value: 0 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: 'varying vec2 u;void main(){u=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: `varying vec2 u;uniform float alpha;void main(){float core=exp(-u.y*u.y*64.),glow=exp(-u.y*u.y*5.);
      float fade=smoothstep(0.,.14,u.x)*(1.-smoothstep(.78,1.,u.x));
      vec3 c=mix(vec3(.22,.008,.62),vec3(.85,.18,1.6),core);gl_FragColor=vec4(c,alpha*fade*(core*.8+glow*.20));}`,
  });
  const rayMesh = new THREE.Mesh(rayGeometry, rayMaterial); rayMesh.frustumCulled = false; rayMesh.position.y = .08; stage.add(rayMesh);
  ownedGeometry.push(rayGeometry); ownedMaterial.push(rayMaterial); attachments.push(rayMesh);
  const shardCount = Math.min(72, Math.floor(rayCount * .32));
  const shardGeometry = new THREE.OctahedronGeometry(.028, 0);
  const shardMaterial = new THREE.MeshBasicMaterial({ color: 0x822afa, wireframe: true, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending });
  const shards = new THREE.InstancedMesh(shardGeometry, shardMaterial, shardCount); shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage); shards.frustumCulled = false; stage.add(shards);
  ownedGeometry.push(shardGeometry); ownedMaterial.push(shardMaterial); attachments.push(shards);
  const dummy = new THREE.Object3D();
  const ringGeometry = new THREE.RingGeometry(1, 1.012, 160);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x7930ee, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial); ring.position.set(0, .08, .1); stage.add(ring);
  ownedGeometry.push(ringGeometry); ownedMaterial.push(ringMaterial); attachments.push(ring);
  return {
    update(t: number, energyAlpha: number, reduced: boolean, coverage = 1) {
      const marks = config.timeline, age = t - marks.burst;
      // The expanding light persists over the logo's first visible frames.
      // Its fade and the logo reveal overlap, eliminating the previous empty beat.
      // The film supplies the contracting point. A violet wash begins at
      // impact; no second white sprite can flash beneath the film spiral.
      aura.material.opacity = track(age, [[-10, 0], [0, 0], [.1, .28], [.24, .24], [.76, 0]]);
      aura.scale.setScalar(track(age, [[-10, .2], [-.01, .2], [0, 1.2], [.2, 3.3], [.76, 4]]));
      halo.material.opacity = energyAlpha * .08 + smooth(marks.logo, marks.logoSettled, t) * .15;
      floor.material.opacity = .10 * smooth(marks.filmFadeStart, marks.burst, t) * (1 - smooth(marks.logoFull, marks.brandFull, t));
      floorLine.material.opacity = .03 * smooth(marks.filmFadeStart, marks.burst, t) * (1 - smooth(marks.logoFull, marks.brandFull, t));
      const inward = t < 5.23;
      const strength = inward ? smooth(marks.transition, 3.7, t) * (1 - smooth(5.04, 5.23, t)) : smooth(0, .16, age) * (1 - smooth(.25, 1.05, age));
      rayMesh.visible = !reduced && strength > .001; rayMesh.scale.set(coverage, coverage, 1); rayMaterial.uniforms.alpha.value = strength * .86;
      if (rayMesh.visible) for (let i = 0; i < rays.length; i++) {
        const p = rays[i]; let radius: number, length: number;
        if (inward) {
          const progress = (p.s + (t - 3.16) * (.8 + p.s * .55) + Math.pow(Math.max(0, t - 3.16), 2) * .35) % 1;
          radius = .02 + p.r * Math.pow(1 - progress, .78); length = .12 + .28 * progress;
        } else { radius = .025 + p.v * (1 - Math.exp(-age * 1.65)) / 1.65; length = (.07 + p.v * .055) * Math.exp(-age * 1.25); }
        const c = Math.cos(p.a), s = Math.sin(p.a), w = .011 + .004 * p.s, tail = radius + length;
        positions.set([c * radius - s * w, s * radius + c * w, p.z, c * radius + s * w, s * radius - c * w, p.z, c * tail - s * w, s * tail + c * w, p.z, c * tail + s * w, s * tail - c * w, p.z], i * 12);
      }
      if (rayMesh.visible) rayGeometry.attributes.position.needsUpdate = true;
      const debris = smooth(.08, .35, age) * (1 - smooth(.65, 1.65, age));
      shards.visible = !reduced && debris > .001; shardMaterial.opacity = debris * .55;
      if (shards.visible) {
        for (let j = 0; j < shardCount; j++) {
          const p = rays[j % rays.length], travel = (1 - Math.exp(-age * .9)) * .23;
          dummy.position.set(Math.cos(p.a) * p.v * travel, .08 + Math.sin(p.a) * p.v * travel - age * age * .09, p.z + (p.s - .5) * age * .6);
          dummy.rotation.set(j * .7 + age, j * .3 + age * 1.4, j + age * .6); dummy.scale.setScalar(.55 + p.s * 1.1); dummy.updateMatrix(); shards.setMatrixAt(j, dummy.matrix);
        }
        shards.instanceMatrix.needsUpdate = true;
      }
      ring.visible = !reduced && age > 0 && age < 1;
      ring.scale.setScalar(.05 + 3.8 * (1 - Math.exp(-Math.max(0, age) * 2)));
      ringMaterial.opacity = smooth(0, .12, age) * (1 - smooth(.2, 1, age)) * .64;
      aura.visible = !reduced;
      return aura.material.opacity;
    },
    dispose() { attachments.forEach(o => o.removeFromParent()); shards.dispose(); ownedGeometry.forEach(g => g.dispose()); ownedMaterial.forEach(m => m.dispose()); glowTexture.dispose(); },
  };
}
