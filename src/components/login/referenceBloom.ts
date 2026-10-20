import * as THREE from 'three';

/** Owned postprocessing with transparent output; no Editor renderer monkey-patch. */
export function createReferenceBloom(renderer: THREE.WebGLRenderer) {
  const type = renderer.extensions.has('EXT_color_buffer_float') ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const target = (depth: boolean) => new THREE.WebGLRenderTarget(4, 4, { type, depthBuffer: depth, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const capture = target(true), ping = target(false), pong = target(false);
  capture.samples = 4;
  const screen = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const vertexShader = 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const extract = new THREE.ShaderMaterial({ vertexShader, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { src: { value: capture.texture } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D src;void main(){vec3 c=texture2D(src,vUv).rgb;float b=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c*smoothstep(.28,.85,b),1.);}` });
  const blur = new THREE.ShaderMaterial({ vertexShader, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { src: { value: ping.texture }, stepSize: { value: new THREE.Vector2() } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D src;uniform vec2 stepSize;void main(){
      vec3 c=texture2D(src,vUv).rgb*.227027;
      c+=(texture2D(src,vUv+stepSize*1.384615).rgb+texture2D(src,vUv-stepSize*1.384615).rgb)*.316216;
      c+=(texture2D(src,vUv+stepSize*3.230769).rgb+texture2D(src,vUv-stepSize*3.230769).rgb)*.070270;
      gl_FragColor=vec4(c,1.);}` });
  const combine = new THREE.ShaderMaterial({ vertexShader, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { base: { value: capture.texture }, glow: { value: ping.texture }, strength: { value: .38 } },
    fragmentShader: `varying vec2 vUv;uniform sampler2D base,glow;uniform float strength;
    void main(){vec4 b=texture2D(base,vUv);vec3 c=b.rgb+texture2D(glow,vUv).rgb*strength;c=vec3(1.)-exp(-c);
      float a=clamp(max(b.a,max(c.r,max(c.g,c.b))),0.,1.);gl_FragColor=vec4(c,a);
      #include <colorspace_fragment>
    }` });
  const quad = new THREE.Mesh(geometry, extract); screen.add(quad);
  function pass(material: THREE.ShaderMaterial, destination: THREE.WebGLRenderTarget | null) { quad.material = material; renderer.setRenderTarget(destination); renderer.render(screen, camera); }
  return {
    resize(width: number, height: number) {
      const scale = Math.min(renderer.getPixelRatio(), 2560 / width, 1600 / height);
      const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      capture.setSize(w, h); ping.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); pong.setSize(ping.width, ping.height);
    },
    render(scene: THREE.Scene, view: THREE.Camera) {
      renderer.setRenderTarget(capture); renderer.render(scene, view);
      pass(extract, ping);
      blur.uniforms.src.value = ping.texture; blur.uniforms.stepSize.value.set(1 / ping.width, 0); pass(blur, pong);
      blur.uniforms.src.value = pong.texture; blur.uniforms.stepSize.value.set(0, 1 / pong.height); pass(blur, ping);
      pass(combine, null);
    },
    dispose() { capture.dispose(); ping.dispose(); pong.dispose(); extract.dispose(); blur.dispose(); combine.dispose(); geometry.dispose(); },
  };
}
