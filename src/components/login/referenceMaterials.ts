import * as THREE from 'three';

export const referenceVertex = `varying vec3 p,n,v;
void main(){p=position;vec4 mv=modelViewMatrix*vec4(position,1.);n=normalize(normalMatrix*normal);v=-mv.xyz;gl_Position=projectionMatrix*mv;}`;

export function createReferenceMaterials() {
  const energy = { time: { value: 0 }, alpha: { value: 0 }, intensity: { value: 1 } };
  const brand = { time: { value: 0 }, alpha: { value: 0 }, hover: { value: 0 }, focus: { value: 1 } };
  const knot = new THREE.ShaderMaterial({
    uniforms: energy, vertexShader: referenceVertex, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    fragmentShader: `varying vec3 p,n,v;uniform float time,alpha,intensity;
    void main(){
      float edge=pow(1.-abs(dot(normalize(n),normalize(v))),2.);
      float a=atan(p.y,p.x),r=length(p.xy);
      float flow=p.z*12.+r*8.+sin(a*3.+p.z*3.)*1.4-time*.65;
      float band=pow(.5+.5*sin(flow),36.);
      float hair=1.-smoothstep(.025,.075+fwidth(flow*5.),abs(sin(flow*5.)));
      float light=edge*.04+band*.45+hair*.12;
      float tint=.5+.5*sin(a*2.+p.z*5.+time*.22);
      vec3 color=mix(vec3(.006,.075,1.),vec3(.50,.012,1.),tint);
      color=mix(color,vec3(.72,.55,1.3),band*.5+edge*.08);
      gl_FragColor=vec4(color*intensity*2.3,alpha*clamp(light,0.,.85));
    }`,
  });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x2d0a8f, metalness: .22, roughness: .105, clearcoat: 1, clearcoatRoughness: .07, transmission: .24, thickness: .65, ior: 1.46, envMapIntensity: 1.4, transparent: true, opacity: 0 });
  const logo = new THREE.MeshPhysicalMaterial({ color: 0x3f00cf, emissive: 0x230075, emissiveIntensity: .42, metalness: .28, roughness: .17, clearcoat: .85, clearcoatRoughness: .09, specularIntensity: .65, specularColor: new THREE.Color(0xb19aff), reflectivity: .65, envMapIntensity: .4, iridescence: .06, iridescenceIOR: 1.35, transparent: true, opacity: 0 });
  // A broad, smoothly curved polish normal on the original model's front/back
  // panels gives studio strips room to travel without altering its silhouette.
  logo.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `
      #include <beginnormal_vertex>
      float faceWeight=pow(abs(normalize(objectNormal).z),8.);
      vec2 panelCenter=vec2(position.y>0.?-.20:.20,position.y>0.?.22:-.22);
      objectNormal.xy+=(position.xy-panelCenter)*.72*faceWeight;
      objectNormal=normalize(objectNormal);
    `);
  };
  logo.customProgramCacheKey = () => 'assistly-polished-panels-v1';
  const highlight = new THREE.ShaderMaterial({
    uniforms: brand, vertexShader: referenceVertex, transparent: true, depthWrite: false,
    side: THREE.FrontSide, toneMapped: false, blending: THREE.AdditiveBlending,
    fragmentShader: `varying vec3 p,n,v;uniform float time,alpha,hover,focus;
    void main(){
      vec3 N=normalize(n),V=normalize(v);
      float rim=pow(1.-abs(dot(N,V)),2.4);
      float x=mix(-1.5,1.5,fract(time*.09));
      float sweep=exp(-pow((p.x*.85+p.y*.32-x)/.10,2.));
      float trace=pow(max(0.,cos(atan(p.y-.05,p.x)-time*.55)),36.);
      vec3 c=vec3(.66,.26,1.45)*rim*(.62+hover*.26);
      c+=vec3(1.35,1.08,1.8)*(rim*trace*1.15+sweep*.045);
      gl_FragColor=vec4(c*focus,alpha);
    }`,
  });
  const edge = new THREE.ShaderMaterial({
    uniforms: brand, transparent: true, depthWrite: false, side: THREE.BackSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position+normal*.0045,1.);}`,
    fragmentShader: `uniform float alpha,hover,focus;void main(){gl_FragColor=vec4(vec3(1.05,.48,1.8)*focus,alpha*(.72+hover*.18));}`,
  });
  // A quiet second silhouette sits just behind the logo. Its light travels
  // around the supplied shape instead of drawing a separate orbital graphic.
  const echo = new THREE.ShaderMaterial({
    uniforms: { time: brand.time, alpha: { value: 0 }, hover: brand.hover, focus: brand.focus },
    transparent: true, depthWrite: false, side: THREE.BackSide,
    blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `varying vec3 p;void main(){p=position;vec3 offset=position+normal*.022+vec3(.014,-.012,-.03);gl_Position=projectionMatrix*modelViewMatrix*vec4(offset,1.);}`,
    fragmentShader: `varying vec3 p;uniform float time,alpha,hover,focus;
    void main(){
      float angle=atan(p.y-.05,p.x);
      float trace=pow(max(0.,cos(angle-time*.55)),24.);
      vec3 lavender=mix(vec3(.58,.26,1.1),vec3(1.15,.82,1.55),trace);
      gl_FragColor=vec4(lavender*focus,alpha*(.14+.26*trace+hover*.06));
    }`,
  });
  const contourMaterial = new THREE.ShaderMaterial({
    uniforms: energy, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    vertexShader: `varying vec3 p;void main(){p=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `varying vec3 p;uniform float time,alpha,intensity;
    void main(){float s=.5+.5*sin(p.x*4.+p.y*3.-time*.8);vec3 c=mix(vec3(.03,.08,1.),vec3(.70,.025,.9),s);gl_FragColor=vec4(c*1.45*intensity,alpha*.25);}`,
  });
  function contours(geometry: THREE.BufferGeometry) {
    const positions = geometry.getAttribute('position'), index = geometry.index;
    const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const values = [0, 0, 0], result: number[] = [];
    const field = (p: THREE.Vector3) => p.z * 12 + Math.hypot(p.x, p.y) * 8 + Math.sin(Math.atan2(p.y, p.x) * 3 + p.z * 3) * 1.4;
    for (let i = 0; i + 2 < (index?.count ?? positions.count); i += 3) {
      for (let j = 0; j < 3; j++) { vertices[j].fromBufferAttribute(positions, index ? index.getX(i + j) : i + j); values[j] = field(vertices[j]); }
      const lo = Math.ceil(Math.min(...values) / .55), hi = Math.floor(Math.max(...values) / .55);
      for (let k = lo; k <= hi; k++) {
        const level = k * .55, hits: number[] = [];
        for (let e = 0; e < 3; e++) {
          const j = (e + 1) % 3, x = values[e], y = values[j];
          if ((x <= level && y > level) || (y <= level && x > level)) {
            const u = (level - x) / (y - x), start = vertices[e], end = vertices[j];
            hits.push(THREE.MathUtils.lerp(start.x, end.x, u), THREE.MathUtils.lerp(start.y, end.y, u), THREE.MathUtils.lerp(start.z, end.z, u));
          }
        }
        if (hits.length === 6) result.push(...hits);
      }
    }
    return new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(result, 3)), contourMaterial);
  }
  return { energy, brand, knot, glass, logo, highlight, edge, echo, contours, dispose() { knot.dispose(); glass.dispose(); logo.dispose(); highlight.dispose(); edge.dispose(); echo.dispose(); contourMaterial.dispose(); } };
}
