import * as THREE from 'three';

/** Viewport-sized depth field, independent of the docking brand composition. */
export function createCinematicBackdrop(scene: THREE.Scene, count: number) {
  const data = new Float32Array(count * 3), sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) { data.set([((i * .618034) % 1) - .5, ((i * .414214) % 1) - .5, -2 + ((i * .73205) % 1) * 2.5], i * 3); sizes[i] = 1 + ((i * .2718) % 1) * 2.6; }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(data, 3)); geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { viewport: { value: new THREE.Vector2(1, 1) }, time: { value: 0 }, alpha: { value: .4 }, pixel: { value: 1 } },
    vertexShader: `attribute float size;uniform vec2 viewport;uniform float time,pixel;varying float brightness;void main(){vec3 p=position;p.xy*=viewport*1.45;p.x+=sin(time*.025+position.y*8.)*.07;p.y+=cos(time*.03+position.x*6.)*.06;vec4 v=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*v;gl_PointSize=size*pixel;brightness=.4+.6*size/3.6;}`,
    fragmentShader: `uniform float alpha;varying float brightness;void main(){float r=length(gl_PointCoord-.5)*2.;float a=exp(-r*r*4.)*(1.-smoothstep(.5,1.,r));gl_FragColor=vec4(mix(vec3(.38,.18,.8),vec3(.85,.75,1.),brightness),a*alpha*brightness);}` });
  const points = new THREE.Points(geometry, material); points.frustumCulled = false; scene.add(points);
  return {
    update(time: number, reveal: number, width: number, height: number, dpr: number) { material.uniforms.time.value = time; material.uniforms.alpha.value = .5 - reveal * .2; material.uniforms.viewport.value.set(width, height); material.uniforms.pixel.value = dpr; },
    dispose() { points.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
