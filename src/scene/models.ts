/** Shared geometry, materials and shaders for the fun bodies. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../galaxy/random';

/** A lumpy, flat-shaded rock. Same seed, same rock. */
export function rockGeometry(seed: number, detail = 1, roughness = 0.28): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, detail);
  // Merge shared vertices so faces stay joined after displacement.
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const merged = mergeVertices(base);
  const random = mulberry32(seed);
  const position = merged.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).multiplyScalar(1 - roughness / 2 + random() * roughness);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  const rock = merged.toNonIndexed();
  rock.computeVertexNormals();
  return rock;
}

function mergeVertices(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const position = geometry.getAttribute('position');
  const map = new Map<string, number>();
  const unique: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i).toFixed(4)},${position.getY(i).toFixed(4)},${position.getZ(i).toFixed(4)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = unique.length / 3;
      map.set(key, id);
      unique.push(position.getX(i), position.getY(i), position.getZ(i));
    }
    index.push(id);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(unique, 3));
  out.setIndex(index);
  return out;
}

/** Two cones meeting at the origin, pointing up and down: a pulsar's beams. */
export function beamGeometry(): THREE.BufferGeometry {
  const length = 4;
  const up = new THREE.ConeGeometry(0.45, length, 16, 1, true).rotateX(Math.PI).translate(0, length / 2, 0);
  const down = up.clone().rotateX(Math.PI);
  return mergeGeometries([up, down])!;
}

/** Concentric bands as an alpha map for flat rings (RingGeometry UVs are planar). */
export function ringBandsTexture(): THREE.Texture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const random = mulberry32(42);
  for (let r = size / 2; r > 0; r -= 2) {
    const shade = Math.floor(120 + random() * 135);
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return new THREE.CanvasTexture(canvas);
}

/** Flat ring around the Y axis, inner/outer radius relative to a unit body. */
export function ringGeometry(inner = 1.5, outer = 2.5): THREE.BufferGeometry {
  return new THREE.RingGeometry(inner, outer, 96, 1).rotateX(-Math.PI / 2);
}

const noise = /* glsl */ `
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
`;

/**
 * Instanced star surface. Colour (with brightness baked in) comes from
 * instanceColor; uBoil is how lively the surface is.
 */
export function starSurfaceMaterial(boil: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uBoil: { value: boil } },
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vSeed;
      void main() {
        vec4 p = vec4(position, 1.0);
        vColor = vec3(1.0);
        vSeed = 0.0;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          vSeed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.11;
        #endif
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #endif
        vec3 n = normal;
        #ifdef USE_INSTANCING
          n = mat3(instanceMatrix) * n;
        #endif
        vLocal = position;
        vNormal = normalize(mat3(viewMatrix) * mat3(modelMatrix) * n);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * p;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBoil;
      varying vec3 vLocal;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vSeed;
      ${noise}
      void main() {
        vec3 p = normalize(vLocal) * 2.6 + vSeed;
        float t = uTime * (0.15 + uBoil * 0.6);
        float n = noise(p + t) * 0.55 + noise(p * 2.7 - t * 1.3) * 0.3 + noise(p * 6.0 + t * 2.0) * 0.15 * uBoil;
        float spots = smoothstep(0.62, 0.8, noise(p * 1.6 + t * 0.5)) * uBoil;
        vec3 hot = mix(vColor, vec3(1.0, 0.97, 0.9) * length(vColor) * 0.75, 0.45);
        vec3 col = mix(vColor * 0.7, hot, n) + spots * hot * 0.9;
        float rim = pow(1.0 - abs(vNormal.z), 2.0);
        gl_FragColor = vec4(col * (1.0 + rim * 0.6), 1.0);
      }
    `,
  });
}

/** Banded gas-giant surface lit from the system's star at the origin. */
export function gasGiantMaterial(color: THREE.ColorRepresentation, seed: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSeed: { value: seed % 97 } },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vWorldNormal;
      void main() {
        vLocal = position;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uSeed;
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vWorldNormal;
      ${noise}
      void main() {
        vec3 n = normalize(vLocal);
        float swirl = noise(n * 3.0 + vec3(uTime * 0.05, 0.0, uSeed)) * 1.4;
        float bands = sin(n.y * 14.0 + swirl + uSeed) * 0.5 + 0.5;
        float fine = sin(n.y * 41.0 + swirl * 2.0) * 0.5 + 0.5;
        vec3 light = mix(uColor, vec3(1.0), 0.35);
        vec3 dark = uColor * 0.45;
        vec3 col = mix(dark, light, bands * 0.75 + fine * 0.25);
        float storm = smoothstep(0.08, 0.0, length(n - normalize(vec3(0.6, -0.25, 0.75))) - 0.12);
        col = mix(col, vec3(1.0, 0.85, 0.75), storm * 0.6);
        float lit = max(dot(normalize(vWorldNormal), normalize(-vWorld)), 0.0);
        gl_FragColor = vec4(col * (0.32 + lit * 0.95), 1.0);
      }
    `,
  });
}
